/**
 * FuseDraftIntoOfficialVacancyUseCase — manutenção (03/11): funde a vaga RASCUNHO que o foguete criou (is_draft, ligada
 * ao serviço) na vaga OFICIAL legada do mesmo paciente (sem serviço). Depois dela o rascunho não existe mais e tudo
 * (Kanban, Talentum, site) enxerga a oficial — que mantém vacancy_number e case_ordinal. Status do paciente não muda.
 *
 * UMA transação por paciente, só reaproveitando o que existe:
 *   1. lock do contexto = `lockRecruitmentContext` (o MESMO do foguete/vínculo: paciente → serviço). Com o rascunho
 *      vivo no serviço ele trava as duas linhas e lança `ServiceAlreadyRecruitingError(rascunho)` — que aqui é a
 *      revalidação esperada; qualquer outro desfecho = o par saiu do estado do mapa → pula;
 *   2. `bypassRegisteredGuard` (SET LOCAL): o guard da postulação (migration 196) dispara em UPDATE OF job_posting_id /
 *      application_funnel_stage e recusaria worker não-REGISTERED — mover não é postular (mesma razão do merge/dedup);
 *   3. revalidação do par + referências que a fusão não sabe mover (fail-closed) + colisões do Kanban
 *      (`decideCollisionStage`; conflito → o paciente inteiro fica de fora);
 *   4. soft-delete do rascunho pela semântica do DELETE de vaga (`lockLiveVacancySnapshot` + `softDeleteVacancyRow` + `auditVacancyDeleted`);
 *   5. endereço divergente → vale o do serviço; `LinkExistingVacancyUseCase.confirm` vincula a oficial ao serviço
 *      (o runner injetado roda NO client desta transação);
 *   6. move postulações/encuadres/triagens/log de mensagem (a trilha segue a postulação) e confere a contagem;
 *   7. auditoria "fusão com rascunho <id>" na oficial (`logFieldChangesSafe`).
 * Sem side-effect outbound: nada aqui chama Talentum/WhatsApp/Ana Care/Short.io, e nenhum evento de funil é emitido.
 */
import type { PoolClient } from 'pg';
import {
  lockRecruitmentContext,
  PatientNotFoundForRecruitmentError,
  ServiceAlreadyRecruitingError,
  ServiceNotFoundForRecruitmentError,
} from './recruitmentReadinessContext';
import { LinkBlockedError, VacancyNotLinkableError, type LinkExistingVacancyUseCase } from './LinkExistingVacancyUseCase';
import { decideCollisionStage } from './draftFusionStage';
import type { DraftFusionRepository, FusionCounts, FusionTable } from '../infrastructure/DraftFusionRepository';
import type { LinkExistingVacancyRepository } from '../infrastructure/LinkExistingVacancyRepository';
import { countVigenteForVacancy } from '../infrastructure/VacancyAllocationProbe';
import { bypassRegisteredGuard } from '../../matching/application/ReconcileMergedWorkerApplications';
import type { JobPostingAuditRepository, FieldChange } from '../../matching/infrastructure/JobPostingAuditRepository';
import {
  auditVacancyDeleted,
  lockLiveVacancySnapshot,
  softDeleteVacancyRow,
  type HumanActor,
} from '../../matching/interfaces/controllers/vacancyCrudAuditHelpers';

export interface FusionPair {
  patientId: string;
  draftId: string;
  officialId: string;
  serviceId: string;
}

export type FusionSkipReason =
  | 'PATIENT_NOT_FOUND'
  | 'SERVICE_NOT_FOUND'
  | 'DRAFT_NOT_LIVE_ON_SERVICE'
  | 'SERVICE_HAS_OTHER_VACANCY'
  | 'DRAFT_CHANGED'
  | 'OFFICIAL_CHANGED'
  | 'PATIENT_SHAPE_CHANGED'
  | `UNHANDLED_REFS:${string}`
  | `LINK_BLOCKED:${string}`
  | `VACANCY_NOT_LINKABLE:${string}`;

export interface FusionConflict {
  workerId: string;
  officialStage: string | null;
  draftStage: string | null;
}

export interface FusionResult {
  before: FusionCounts;
  after: FusionCounts;
  /** Linhas que deixaram de existir por fusão (o worker já estava na oficial), por tabela. */
  merged: Partial<Record<FusionTable, number>>;
  /** Etapa final de cada colisão de postulação (só ids/etapas). */
  collisionStages: Record<string, number>;
  addressAligned: boolean;
  vigentesNoServico: number;
}

export type FusionOutcome =
  | { status: 'FUSED'; committed: boolean; result: FusionResult }
  | { status: 'SKIPPED'; reason: FusionSkipReason }
  | { status: 'CONFLICT'; conflicts: FusionConflict[] };

type TransactionRunner = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;
type LinkConfirmer = Pick<LinkExistingVacancyUseCase, 'confirm'>;

/** Sinal interno: desfaz a transação (pulo, conflito ou dry-run) devolvendo o desfecho. */
class RollbackWith extends Error {
  constructor(readonly outcome: FusionOutcome) {
    super('fusion rollback');
  }
}

/** A contagem pós-fusão não fecha com a de antes: nada é gravado (rollback) e o paciente sai como erro. */
export class FusionCountMismatchError extends Error {
  constructor(readonly table: FusionTable) {
    super(`fusion count mismatch on ${table}`);
    this.name = 'FusionCountMismatchError';
  }
}

const CLOSED_STATUSES = ['CLOSED', 'DE_BAJA'];

export class FuseDraftIntoOfficialVacancyUseCase {
  constructor(
    private readonly repo: DraftFusionRepository,
    private readonly linkRepo: Pick<LinkExistingVacancyRepository, 'readVacancyForLink'>,
    private readonly auditRepo: Pick<JobPostingAuditRepository, 'logFieldChangesSafe'>,
    /** `LinkExistingVacancyUseCase` montado com um runner que reusa ESTE client (mesma transação). */
    private readonly linkFor: (client: PoolClient) => LinkConfirmer,
    private readonly runInTransaction: TransactionRunner,
    private readonly actor: HumanActor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `apply=false` executa tudo e dá ROLLBACK (dry-run). Erro inesperado propaga (a transação já foi desfeita). */
  async fuse(pair: FusionPair, opts: { apply: boolean }): Promise<FusionOutcome> {
    try {
      return await this.runInTransaction(async (client) => {
        const outcome = await this.fuseInTx(client, pair);
        if (outcome.status !== 'FUSED' || !opts.apply) throw new RollbackWith(outcome);
        return { ...outcome, committed: true };
      });
    } catch (err) {
      if (err instanceof RollbackWith) return err.outcome;
      if (err instanceof LinkBlockedError) return skip(`LINK_BLOCKED:${err.blockers.join('+')}`);
      if (err instanceof VacancyNotLinkableError) return skip(`VACANCY_NOT_LINKABLE:${err.reason}`);
      throw err;
    }
  }

  private async fuseInTx(client: PoolClient, pair: FusionPair): Promise<FusionOutcome> {
    const lock = await this.lockContext(client, pair);
    if (lock) return lock;
    await bypassRegisteredGuard(client);

    const draft = await lockLiveVacancySnapshot(client, pair.draftId);
    if (!draft || draft.is_draft !== true || draft.contracted_service_id !== pair.serviceId || draft.patient_id !== pair.patientId) {
      return skip('DRAFT_CHANGED');
    }
    const official = await lockLiveVacancySnapshot(client, pair.officialId);
    if (
      !official ||
      official.is_draft !== false ||
      official.contracted_service_id !== null ||
      official.patient_id !== pair.patientId ||
      CLOSED_STATUSES.includes(official.status as string)
    ) {
      return skip('OFFICIAL_CHANGED');
    }
    const shape = await this.repo.patientVacancyShape(client, pair.patientId);
    if (shape.openLegacy !== 1 || shape.liveDrafts !== 1) return skip('PATIENT_SHAPE_CHANGED');
    const unhandled = await this.repo.unhandledReferences(client, pair.draftId);
    if (unhandled.length > 0) return skip(`UNHANDLED_REFS:${unhandled.join('+')}`);

    const before = await this.repo.countRows(client, pair.draftId, pair.officialId);
    const collisions = await this.repo.listApplicationCollisions(client, pair.draftId, pair.officialId);
    const decisions = collisions.map((c) => ({ c, d: decideCollisionStage(c.officialStage, c.draftStage) }));
    const conflicts = decisions.filter(({ d }) => d.action === 'CONFLICT');
    if (conflicts.length > 0) {
      return {
        status: 'CONFLICT',
        conflicts: conflicts.map(({ c }) => ({ workerId: c.workerId, officialStage: c.officialStage, draftStage: c.draftStage })),
      };
    }

    // 4. soft-delete do rascunho. A probe toma o lock do itinerário do serviço; vigência NÃO bloqueia aqui (a guarda do
    //    DELETE protege o serviço de ficar sem vaga — na fusão ele ganha a oficial na MESMA transação); só se conta.
    const vigentesNoServico = await countVigenteForVacancy(client, pair.draftId, this.now());
    if (!(await softDeleteVacancyRow(client, pair.draftId))) return skip('DRAFT_CHANGED');
    await auditVacancyDeleted(client, pair.draftId, draft, this.actor);

    // 5. endereço: vale o do serviço; depois o vínculo pelo caminho existente.
    const addressAudit = await this.alignAddress(client, pair);
    await this.linkFor(client).confirm(pair.patientId, pair.serviceId, pair.officialId, this.actor);

    // 6. Kanban e filhos.
    const collisionStages: Record<string, number> = {};
    for (const { c, d } of decisions) {
      const stage = d.action === 'ADOPT' ? d.stage : null;
      await this.repo.mergeCollidingApplication(client, c, pair.draftId, pair.officialId, stage);
      const finalStage = stage ?? c.officialStage ?? '(sem etapa)';
      collisionStages[finalStage] = (collisionStages[finalStage] ?? 0) + 1;
    }
    const mergedEncuadres = await this.repo.mergeCollidingEncuadres(client, pair.draftId, pair.officialId);
    await this.repo.reparentToOfficial(client, pair.draftId, pair.officialId);

    const after = await this.repo.countRows(client, pair.draftId, pair.officialId);
    const adopted = decisions.filter(({ d }) => d.action === 'ADOPT').length;
    const merged: Partial<Record<FusionTable, number>> = {
      worker_job_applications: collisions.length,
      encuadres: mergedEncuadres,
    };
    // A trilha não perde linha (é movida); ganha UMA por etapa adotada (trigger da migration 169).
    assertCounts(before, after, merged, { worker_job_application_stage_history: adopted });

    // 7. auditoria da fusão na oficial (só ids e contagens).
    const fields: FieldChange[] = [
      { field: 'fusao_rascunho', before: pair.draftId, after: pair.officialId },
      { field: 'fusao_rascunho_contagens', before, after: { after, merged, collisionStages } },
      ...addressAudit,
    ];
    await this.auditRepo.logFieldChangesSafe(client, {
      jobPostingId: pair.officialId,
      fields,
      actorUserId: this.actor.actorUserId,
      actorType: this.actor.actorType,
      actorLabel: this.actor.actorLabel,
      traceId: this.actor.traceId ?? null,
    });

    return {
      status: 'FUSED',
      committed: false,
      result: { before, after, merged, collisionStages, addressAligned: addressAudit.length > 0, vigentesNoServico },
    };
  }

  /** null = travado com o rascunho como a vaga viva do serviço (o estado do mapa); senão, o desfecho de pulo. */
  private async lockContext(client: PoolClient, pair: FusionPair): Promise<FusionOutcome | null> {
    try {
      await lockRecruitmentContext(client, pair.patientId, pair.serviceId);
      return skip('DRAFT_NOT_LIVE_ON_SERVICE');
    } catch (err) {
      if (err instanceof ServiceAlreadyRecruitingError) {
        return err.vacancyId === pair.draftId ? null : skip('SERVICE_HAS_OTHER_VACANCY');
      }
      if (err instanceof PatientNotFoundForRecruitmentError) return skip('PATIENT_NOT_FOUND');
      if (err instanceof ServiceNotFoundForRecruitmentError) return skip('SERVICE_NOT_FOUND');
      throw err;
    }
  }

  private async alignAddress(client: PoolClient, pair: FusionPair): Promise<FieldChange[]> {
    const officialLink = await this.linkRepo.readVacancyForLink(client, pair.officialId, { forUpdate: true });
    const vacancyAddress = officialLink?.patient_address_id ?? null;
    const serviceAddress = await this.repo.readServiceLiveAddress(client, pair.serviceId);
    if (vacancyAddress === null || serviceAddress === null || vacancyAddress === serviceAddress) return [];
    await this.repo.alignVacancyAddress(client, pair.officialId, serviceAddress);
    return [{ field: 'patient_address_id', before: vacancyAddress, after: serviceAddress }];
  }
}

function skip(reason: FusionSkipReason): FusionOutcome {
  return { status: 'SKIPPED', reason };
}

/** Invariante de contagem por tabela: rascunho zerado; oficial = antes(rascunho + oficial) − fundidas + criadas. */
function assertCounts(
  before: FusionCounts,
  after: FusionCounts,
  merged: Partial<Record<FusionTable, number>>,
  created: Partial<Record<FusionTable, number>>,
): void {
  for (const table of Object.keys(before) as FusionTable[]) {
    const expected = before[table].draft + before[table].official - (merged[table] ?? 0) + (created[table] ?? 0);
    if (after[table].draft !== 0 || after[table].official !== expected) throw new FusionCountMismatchError(table);
  }
}
