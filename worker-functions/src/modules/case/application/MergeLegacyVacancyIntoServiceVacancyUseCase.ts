/**
 * MergeLegacyVacancyIntoServiceVacancyUseCase — spec 084 F3 grupo c (R19): paciente com serviço que ainda tem a vaga
 * ANTIGA aberta (sem serviço): os candidatos e o histórico do Kanban da antiga VÃO para a vaga do serviço (mesmo que seja
 * rascunho) e a antiga é BAIXADA no mesmo passo (motivo CUTOFF). NADA é apagado (R2): a antiga fica DE_BAJA, só consulta.
 *
 * É o "irmão espelhado" da `FuseDraftIntoOfficialVacancyUseCase` (que mantém a antiga e APAGA o rascunho — usado na fusão de
 * 03/11 e não refeito): aqui a vaga DO SERVIÇO é quem fica. Reaproveita as MESMAS peças, sem copiar:
 *   - `lockRecruitmentContext` (paciente → serviço), `bypassRegisteredGuard`;
 *   - `DraftFusionRepository` (contagem, colisões, merge de postulações/encuadres, reparent) — direção parametrizada por
 *     ids: aqui "draft" = a ANTIGA (origem) e "official" = a vaga do SERVIÇO (destino);
 *   - `decideCollisionStage` (a etapa do destino em entrada adota a da origem; duas decididas diferentes = CONFLITO, o
 *     paciente não é tocado) e `assertCounts` (a contagem antes/depois fecha, senão ROLLBACK);
 *   - `BajaVacanciesUseCase.executeInTx` para a baixa (P1/P2/P6 num lugar só).
 * O destino vem do mapa do recrutamento (nunca por chute): este use case só recebe o par já escolhido e o REVALIDA.
 * Sem side-effect outbound: o pause no Talentum é do chamador, DEPOIS do commit.
 */
import type { PoolClient } from 'pg';
import {
  lockRecruitmentContext,
  PatientNotFoundForRecruitmentError,
  ServiceAlreadyRecruitingError,
  ServiceNotFoundForRecruitmentError,
} from './recruitmentReadinessContext';
import { decideCollisionStage } from './draftFusionStage';
import { assertCounts, type FusionConflict, type FusionResult } from './FuseDraftIntoOfficialVacancyUseCase';
import type { DraftFusionRepository, FusionTable } from '../infrastructure/DraftFusionRepository';
import type { LegacyVacancyCutoffRepository } from '../infrastructure/LegacyVacancyCutoffRepository';
import { bypassRegisteredGuard } from '../../matching/application/ReconcileMergedWorkerApplications';
import type { BajaVacanciesUseCase } from '../../matching/application/BajaVacanciesUseCase';
import type { JobPostingAuditRepository, FieldChange } from '../../matching/infrastructure/JobPostingAuditRepository';
import { lockLiveVacancySnapshot, type HumanActor } from '../../matching/interfaces/controllers/vacancyCrudAuditHelpers';
import { isOpenVacancy } from '../domain/LegacyVacancyCutoff';

export interface LegacyMergePair {
  patientId: string;
  /** A vaga ANTIGA (sem serviço) — origem do merge e alvo da baixa. */
  legacyId: string;
  /** A vaga DO SERVIÇO escolhida pelo recrutamento — destino. */
  targetId: string;
}

export type LegacyMergeSkipReason =
  | 'PATIENT_NOT_FOUND'
  | 'SERVICE_NOT_FOUND'
  | 'LEGACY_CHANGED'
  | 'TARGET_CHANGED'
  | 'TARGET_NOT_SERVICE_VACANCY'
  | 'DIFFERENT_PATIENT';

export type LegacyMergeOutcome =
  | { status: 'MERGED'; committed: boolean; result: FusionResult & { blockedMoved: number; blockedLeft: number; blockedBefore: number; blockedAfter: number } }
  | { status: 'SKIPPED'; reason: LegacyMergeSkipReason }
  | { status: 'CONFLICT'; conflicts: FusionConflict[] };

const skip = (reason: LegacyMergeSkipReason): LegacyMergeOutcome => ({ status: 'SKIPPED', reason });

export class MergeLegacyVacancyIntoServiceVacancyUseCase {
  constructor(
    private readonly repo: Pick<
      DraftFusionRepository,
      'countRows' | 'listApplicationCollisions' | 'mergeCollidingApplication' | 'mergeCollidingEncuadres' | 'reparentToOfficial'
    >,
    private readonly cutoffRepo: Pick<LegacyVacancyCutoffRepository, 'moveBlockedApplications' | 'countBlockedApplications'>,
    private readonly baja: Pick<BajaVacanciesUseCase, 'executeInTx'>,
    private readonly auditRepo: Pick<JobPostingAuditRepository, 'logFieldChangesSafe'>,
    private readonly actor: HumanActor,
  ) {}

  /**
   * Roda NA transação do chamador (`client`). Quem decide COMMIT × ROLLBACK é o chamador (ensaio × apply); este método
   * só devolve o desfecho. Erro inesperado propaga (o chamador desfaz). Conflito/pulo NÃO escrevem nada.
   */
  async mergeInTx(client: PoolClient, pair: LegacyMergePair): Promise<LegacyMergeOutcome> {
    const target0 = await lockLiveVacancySnapshot(client, pair.targetId);
    if (!target0 || target0.contracted_service_id == null) return skip('TARGET_NOT_SERVICE_VACANCY');
    const serviceId = target0.contracted_service_id as string;

    const lock = await this.lockContext(client, pair.patientId, serviceId, pair.targetId);
    if (lock) return lock;
    await bypassRegisteredGuard(client);

    const legacy = await lockLiveVacancySnapshot(client, pair.legacyId);
    if (
      !legacy ||
      legacy.contracted_service_id !== null ||
      !isOpenVacancy({ status: legacy.status as string, isDraft: legacy.is_draft === true })
    ) {
      return skip('LEGACY_CHANGED');
    }
    const target = await lockLiveVacancySnapshot(client, pair.targetId);
    if (!target || target.status === 'DE_BAJA' || target.contracted_service_id !== serviceId) return skip('TARGET_CHANGED');
    if (legacy.patient_id !== pair.patientId || target.patient_id !== pair.patientId) return skip('DIFFERENT_PATIENT');

    const before = await this.repo.countRows(client, pair.legacyId, pair.targetId);
    const blockedBefore = await this.cutoffRepo.countBlockedApplications(client, pair.legacyId);
    const collisions = await this.repo.listApplicationCollisions(client, pair.legacyId, pair.targetId);
    const decisions = collisions.map((c) => ({ c, d: decideCollisionStage(c.officialStage, c.draftStage) }));
    const conflicts = decisions.filter(({ d }) => d.action === 'CONFLICT');
    if (conflicts.length > 0) {
      return {
        status: 'CONFLICT',
        conflicts: conflicts.map(({ c }) => ({ workerId: c.workerId, officialStage: c.officialStage, draftStage: c.draftStage })),
      };
    }

    // Kanban e filhos: antiga → vaga do serviço (mesma ordem da fusão de 03/11).
    const collisionStages: Record<string, number> = {};
    for (const { c, d } of decisions) {
      const stage = d.action === 'ADOPT' ? d.stage : null;
      await this.repo.mergeCollidingApplication(client, c, pair.legacyId, pair.targetId, stage);
      const finalStage = stage ?? c.officialStage ?? '(sem etapa)';
      collisionStages[finalStage] = (collisionStages[finalStage] ?? 0) + 1;
    }
    const mergedEncuadres = await this.repo.mergeCollidingEncuadres(client, pair.legacyId, pair.targetId);
    await this.repo.reparentToOfficial(client, pair.legacyId, pair.targetId);
    const blocked = await this.cutoffRepo.moveBlockedApplications(client, pair.legacyId, pair.targetId);

    const after = await this.repo.countRows(client, pair.legacyId, pair.targetId);
    const adopted = decisions.filter(({ d }) => d.action === 'ADOPT').length;
    const merged: Partial<Record<FusionTable, number>> = { worker_job_applications: collisions.length, encuadres: mergedEncuadres };
    assertCounts(before, after, merged, { worker_job_application_stage_history: adopted });
    const blockedAfter = await this.cutoffRepo.countBlockedApplications(client, pair.legacyId);

    // A baixa da ANTIGA no mesmo passo (motivo CUTOFF; P1/P2/P6 pelo mesmo caminho da baixa à mão).
    const baixa = await this.baja.executeInTx(client, [pair.legacyId], 'CUTOFF', this.actor);
    if (!baixa.ok) throw new Error(`baixa da antiga recusada: ${baixa.refused.map((r) => r.code).join('+')}`);

    const fields: FieldChange[] = [
      { field: 'merge_vaga_antiga', before: pair.legacyId, after: pair.targetId },
      { field: 'merge_vaga_antiga_contagens', before, after: { after, merged, collisionStages, blocked } },
    ];
    await this.auditRepo.logFieldChangesSafe(client, {
      jobPostingId: pair.targetId,
      fields,
      actorUserId: this.actor.actorUserId,
      actorType: this.actor.actorType,
      actorLabel: this.actor.actorLabel,
      traceId: this.actor.traceId ?? null,
    });

    return {
      status: 'MERGED',
      committed: false,
      result: {
        before, after, merged, collisionStages, addressAligned: false, vigentesNoServico: 0, gateWaived: [],
        blockedMoved: blocked.moved, blockedLeft: blocked.left, blockedBefore, blockedAfter,
      },
    };
  }

  /** null = travado com a vaga destino como a vaga viva do serviço (o estado esperado); senão, o desfecho de pulo. */
  private async lockContext(client: PoolClient, patientId: string, serviceId: string, targetId: string): Promise<LegacyMergeOutcome | null> {
    try {
      await lockRecruitmentContext(client, patientId, serviceId);
      return skip('TARGET_CHANGED');
    } catch (err) {
      if (err instanceof ServiceAlreadyRecruitingError) return err.vacancyId === targetId ? null : skip('TARGET_CHANGED');
      if (err instanceof PatientNotFoundForRecruitmentError) return skip('PATIENT_NOT_FOUND');
      if (err instanceof ServiceNotFoundForRecruitmentError) return skip('SERVICE_NOT_FOUND');
      throw err;
    }
  }
}
