import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import {
  nextMajor,
  nextMinorOf,
  sortByCreatedDesc,
  versionLabel,
  currentVersionOf,
  macroFieldsChanged,
  type CatalogSnapshotItem,
  type ContactRef,
  type PathologySegment,
  type TherapeuticCatalogSnapshotItem,
  type TherapeuticDiagnosis,
  type TherapeuticMacroField,
  type TherapeuticModality,
  type TherapeuticProjectVersion,
} from '../domain/TherapeuticProject';
import { TherapeuticCatalogRepository } from './TherapeuticCatalogRepository';
import { TherapeuticProjectContactStatusRepository } from './TherapeuticProjectContactStatusRepository';
import { TherapeuticContactReminderRepository } from './TherapeuticContactReminderRepository';
import { planContactStatuses, type ContactStatusMap } from '../domain/TherapeuticContactStatus';
import { canWaiveContact } from '../application/therapeuticProjectAccess';
import { createTerminologyPort } from '@modules/terminology/infrastructure/TerminologyPortFactory';
import type { TerminologyPort } from '@modules/terminology/domain/TerminologyPort';
import { derivePathologySegments } from '../application/pathologySegments';

interface VersionRow {
  id: string;
  patient_id: string;
  major: number;
  minor: number;
  edited_from_version_id: string | null;
  contracted_service_id: string;
  contracted_service_code: string;
  modality: TherapeuticModality | null;
  diagnoses: TherapeuticDiagnosis[];
  clinical_context: string;
  general_objective: string;
  specific_objectives: TherapeuticCatalogSnapshotItem[];
  activities: TherapeuticCatalogSnapshotItem[];
  pathology_types: PathologySegment[];
  /** `NULL` em versão anterior à 496 (spec 030). */
  segment: CatalogSnapshotItem | null;
  start_date: string;
  end_date: string;
  annulled_at: string | null;
  annulled_by: string | null;
  annulled_by_name: string | null;
  annul_reason: string | null;
  country: string;
  created_by: string;
  created_by_name: string | null;
  created_at: string;
}

export interface TherapeuticProjectVersionInput {
  contractedServiceId: string;
  modality: TherapeuticModality;
  diagnoses: TherapeuticDiagnosis[];
  clinicalContext: string;
  generalObjective: string;
  specificObjectiveIds: string[];
  activityIds: string[];
  startDate: string;
  endDate: string;
  /** MICRO (D328/SUP-24) — só ids; a linha de origem tem de estar ATIVA (trigger 429). */
  contactRefs: ContactRef[];
  careTeamIds: string[];
  /** spec 048: estado explícito por campo ("Todavía no hay registro" / "No necesita"); `{}` = nenhum. */
  contactStatus: ContactStatusMap;
}

/** `mode:'new'` carrega o `segmentId` (MACRO, spec 030) — o `{id,label}` é congelado AQUI, do catálogo ativo. */
export type NewTherapeuticProjectVersionInput = TherapeuticProjectVersionInput & { segmentId: string };

/** `cells`: células do ator (D113: `null`/ausente = o engine não decidiu → passa). Só decide `NOT_NEEDED` novo. */
export type CreateVersionCommand =
  | { mode: 'new'; patientId: string; actorUid: string; cells?: readonly string[] | null; version: NewTherapeuticProjectVersionInput }
  | { mode: 'edit'; patientId: string; actorUid: string; cells?: readonly string[] | null; fromVersionId: string; version: TherapeuticProjectVersionInput };


export * from './therapeuticProjectErrors';
import {
  isServiceOfOtherPatient, isContactInactiveViolation, isForeignKeyViolation, ServiceNotOfPatientError, SourceVersionNotFoundError,
  VersionNotCurrentError, MacroFieldsLockedError, PatientNotFoundForProjectError, ContactInactiveError, ContactNotFoundError, WaiveContactForbiddenError,
} from './therapeuticProjectErrors';

const CONTACT_COLUMN: Record<'RESPONSIBLE' | 'EXTERNAL' | 'COVERAGE' | 'CARE_TEAM', string> = {
  RESPONSIBLE: 'responsible_id',
  EXTERNAL: 'external_contact_id',
  COVERAGE: 'coverage_contact_id',
  CARE_TEAM: 'professional_id',
};

// `date` chega como Date pelo driver quando não há tipo customizado; a API fala ISO yyyy-mm-dd.
const isoDate = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
const isoTs = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));

// Só o NOME do autor — nunca o e-mail como fallback (o e-mail do staff é dado pessoal do colaborador e
// sairia para qualquer ator com a célula do projeto). Sem display_name a tela mostra "—" (SUP-14).
const SELECT_VERSION = `
  SELECT v.*,
         (SELECT u.display_name FROM users u WHERE u.firebase_uid = v.created_by) AS created_by_name,
         (SELECT u.display_name FROM users u WHERE u.firebase_uid = v.annulled_by) AS annulled_by_name
    FROM patient_therapeutic_projects v`;

function toVersion(r: VersionRow): TherapeuticProjectVersion {
  return {
    id: r.id,
    patientId: r.patient_id,
    major: r.major,
    minor: r.minor,
    version: versionLabel(r.major, r.minor),
    editedFromVersionId: r.edited_from_version_id,
    contractedServiceId: r.contracted_service_id,
    contractedServiceCode: r.contracted_service_code,
    modality: r.modality ?? null,
    diagnoses: r.diagnoses,
    clinicalContext: r.clinical_context,
    generalObjective: r.general_objective,
    specificObjectives: r.specific_objectives,
    activities: r.activities,
    pathologyTypes: r.pathology_types,
    segment: r.segment ?? null,
    startDate: isoDate(r.start_date),
    endDate: isoDate(r.end_date),
    annulledAt: isoTs(r.annulled_at),
    annulledBy: r.annulled_by,
    annulledByName: r.annulled_by_name ?? null,
    annulReason: r.annul_reason,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    createdAt: isoTs(r.created_at) as string,
    country: r.country,
  };
}

/**
 * Versões do projeto terapêutico (migration 416). Toda escrita passa por `withActorContext`
 * (D95; lex C3) — a transação leva o país da request, senão a policy da 411 recusa (o 500 que a
 * stage mediu no serviço contratado). O número da versão é decidido DENTRO da transação, com o
 * paciente travado (`SELECT ... FOR UPDATE`): dois "Novo" concorrentes não geram a mesma 2.0.
 */
export class TherapeuticProjectRepository {
  private poolMemo?: Pool;

  constructor(
    private readonly catalogs: TherapeuticCatalogRepository = new TherapeuticCatalogRepository(),
    /** Resolve o capítulo CID-11 de cada diagnóstico — o "tipo de patologia" é derivado, não escolhido. */
    private readonly terminology: TerminologyPort = createTerminologyPort(process.env),
    private readonly statuses: TherapeuticProjectContactStatusRepository = new TherapeuticProjectContactStatusRepository(),
    private readonly reminders: TherapeuticContactReminderRepository = new TherapeuticContactReminderRepository(),
  ) {}

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /** Todas as versões do paciente (anuladas incluídas — a lista mostra o estado), mais recente primeiro. */
  async listForPatient(patientId: string, cli: Pool | PoolClient = this.pool): Promise<TherapeuticProjectVersion[]> {
    const res = await cli.query<VersionRow>(`${SELECT_VERSION} WHERE v.patient_id = $1`, [patientId]);
    return sortByCreatedDesc(res.rows.map(toVersion));
  }

  async findById(patientId: string, versionId: string): Promise<TherapeuticProjectVersion | null> {
    const res = await this.pool.query<VersionRow>(`${SELECT_VERSION} WHERE v.patient_id = $1 AND v.id = $2`, [patientId, versionId]);
    return res.rows[0] ? toVersion(res.rows[0]) : null;
  }

  async createVersion(cmd: CreateVersionCommand): Promise<TherapeuticProjectVersion> {
    try {
      const row = await withActorContext(this.pool, async (cli) => {
        // As 4 FKs de contato da 429 (`ptpc_resp_fk`/`ptpc_ext_fk`/`ptpc_cov_fk`/`ptpc_pro_fk`) são
        // DEFERRABLE INITIALLY DEFERRED — necessário para a purga de paciente (`PatientTestFixtureService`)
        // cascatear sem estourar pela ORDEM das duas cascatas convergentes (ver migration 429). Mas
        // adiada, o 23503 de um `id` que não é uma linha ATIVA deste paciente só apareceria no COMMIT,
        // fora do try/catch por linha de `insertContacts` — virava 500 em vez do 404 do contrato.
        // Tornar IMEDIATA aqui, só para ESTA transação de escrita, devolve o erro para dentro do INSERT.
        await cli.query(
          'SET CONSTRAINTS ptpc_resp_fk, ptpc_ext_fk, ptpc_cov_fk, ptpc_pro_fk IMMEDIATE',
        );
        // Trava o paciente: a numeração é lida e gravada na MESMA transação. Zero linhas = paciente
        // inexistente OU invisível sob a RLS — 404 nos dois casos (nunca dizer qual).
        const lock = await cli.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [cmd.patientId]);
        if (lock.rows.length === 0) throw new PatientNotFoundForProjectError();
        const existing = await this.listForPatient(cmd.patientId, cli);

        // spec 048: o status da nova versão herda da VIGENTE (nos dois modos). "No necesita" NOVO exige a célula —
        // checado ANTES de qualquer INSERT (a transação inteira some junto, de todo jeito).
        const vigente = currentVersionOf(existing);
        const previousStatuses = vigente ? (await this.statuses.listByVersions([vigente.id], cli)).get(vigente.id) ?? [] : [];
        const statusPlan = planContactStatuses(cmd.version.contactStatus, previousStatuses, cmd.actorUid);
        if (statusPlan.newlyWaived.length > 0 && !canWaiveContact(cmd.cells)) {
          throw new WaiveContactForbiddenError(statusPlan.newlyWaived);
        }

        let number: { major: number; minor: number };
        let editedFrom: string | null = null;
        // Segmento (030): `new` congela o do catálogo ATIVO; `edit` COPIA o da origem (MACRO não muda;
        // origem anterior à 496 → `null`).
        let segment: CatalogSnapshotItem | null;
        if (cmd.mode === 'new') {
          number = nextMajor(existing);
          segment = await this.catalogs.snapshotSegment(cmd.version.segmentId, cli);
        } else {
          const source = existing.find((v) => v.id === cmd.fromVersionId && v.annulledAt === null);
          if (!source) throw new SourceVersionNotFoundError();
          // ADR-4/SUP-24: só a VIGENTE (created_at mais recente entre as não-anuladas) pode ser
          // editada — 409, nunca "edita como se fosse a última minor da major".
          const current = currentVersionOf(existing);
          if (!current || current.id !== source.id) throw new VersionNotCurrentError();
          // D328: MACRO só muda em versão NOVA — edição recusa alteração de MACRO (422, só nomes).
          const changedMacro = macroFieldsChanged(
            {
              contractedServiceId: source.contractedServiceId,
              diagnosisUris: source.diagnoses.map((d) => d.uri),
              clinicalContext: source.clinicalContext,
              generalObjective: source.generalObjective,
              specificObjectiveIds: source.specificObjectives.map((o) => o.id),
              activityIds: source.activities.map((a) => a.id),
            },
            {
              contractedServiceId: cmd.version.contractedServiceId,
              diagnoses: cmd.version.diagnoses,
              clinicalContext: cmd.version.clinicalContext,
              generalObjective: cmd.version.generalObjective,
              specificObjectiveIds: cmd.version.specificObjectiveIds,
              activityIds: cmd.version.activityIds,
            },
          );
          if (changedMacro.length > 0) throw new MacroFieldsLockedError(changedMacro);
          number = nextMinorOf(existing, source.major);
          editedFrom = source.id;
          segment = source.segment;
        }

        // Snapshot montado AQUI, do catálogo (lex C19): o cliente manda ids, a versão congela texto.
        // O tipo de patologia é DERIVADO dos CID-11 (capítulo, via porta de terminologia) — D163/D164.
        const [specificObjectives, activities, pathologyTypes] = await Promise.all([
          this.catalogs.snapshotOf('specific-objectives', cmd.version.specificObjectiveIds, cli),
          this.catalogs.snapshotOf('activities', cmd.version.activityIds, cli),
          derivePathologySegments(this.terminology, cmd.version.diagnoses),
        ]);

        const ins = await cli.query<{ id: string }>(
          `INSERT INTO patient_therapeutic_projects
             (patient_id, major, minor, edited_from_version_id, contracted_service_id, diagnoses,
              clinical_context, general_objective, specific_objectives, activities, pathology_types,
              start_date, end_date, created_by, modality, segment)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16::jsonb)
           RETURNING id`,
          [
            cmd.patientId, number.major, number.minor, editedFrom, cmd.version.contractedServiceId,
            JSON.stringify(cmd.version.diagnoses), cmd.version.clinicalContext, cmd.version.generalObjective,
            JSON.stringify(specificObjectives), JSON.stringify(activities), JSON.stringify(pathologyTypes),
            cmd.version.startDate, cmd.version.endDate, cmd.actorUid, cmd.version.modality,
            segment === null ? null : JSON.stringify(segment),
          ],
        );
        // SUP-26: a ligação só nasce NESTA transação, com a versão já gravada — nunca "adicionar
        // depois" numa versão antiga. Erro daqui vira 422/404 (lex #7 C7: nunca nome/telefone).
        await this.insertContacts(cli, ins.rows[0].id, cmd.patientId, cmd.version.contactRefs, cmd.version.careTeamIds);
        // Ordem fixa: o trigger do status recusa status + contato no MESMO campo, então os contatos entram ANTES.
        await this.statuses.insertStatuses(cli, ins.rows[0].id, cmd.patientId, statusPlan.rows);

        const sel = await cli.query<VersionRow>(`${SELECT_VERSION} WHERE v.id = $1`, [ins.rows[0].id]);
        // Outbox dos lembretes: só campo NOVAMENTE pendente abre ciclo; com ciclo aberto o campo entra nele (P6, Opção A).
        if (statusPlan.newlyPending.length > 0) {
          await this.reminders.openCycleIfNone(cli, {
            patientId: cmd.patientId,
            anchorVersionId: ins.rows[0].id,
            openedByUid: cmd.actorUid,
            country: sel.rows[0].country,
          });
        }
        return sel.rows[0];
      });
      return toVersion(row);
    } catch (err) {
      if (isServiceOfOtherPatient(err)) throw new ServiceNotOfPatientError();
      throw err;
    }
  }

  /**
   * Insere a ligação versão→contato UMA LINHA POR VEZ (não em lote): o erro do trigger (429) não
   * diz QUAL linha violou, e o contrato exige `{kind,id}` do contato específico no 422/404.
   */
  private async insertContacts(
    cli: PoolClient,
    versionId: string,
    patientId: string,
    contactRefs: ContactRef[],
    careTeamIds: string[],
  ): Promise<void> {
    const rows: { kind: 'RESPONSIBLE' | 'EXTERNAL' | 'COVERAGE' | 'CARE_TEAM'; id: string }[] = [
      ...contactRefs.map((r) => ({ kind: r.kind, id: r.id })),
      ...careTeamIds.map((id) => ({ kind: 'CARE_TEAM' as const, id })),
    ];
    for (const [sortOrder, row] of rows.entries()) {
      const column = CONTACT_COLUMN[row.kind];
      try {
        await cli.query(
          `INSERT INTO patient_therapeutic_project_contacts (version_id, patient_id, contact_kind, ${column}, sort_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [versionId, patientId, row.kind, row.id, sortOrder],
        );
      } catch (err) {
        if (isContactInactiveViolation(err)) throw new ContactInactiveError(row.kind, row.id);
        if (isForeignKeyViolation(err)) throw new ContactNotFoundError(row.kind, row.id);
        throw err;
      }
    }
  }

  /** Anulação (lex C5): a única escrita depois do INSERT. `null` = versão inexistente ou já anulada. */
  async annul(patientId: string, versionId: string, actorUid: string, reason: string): Promise<TherapeuticProjectVersion | null> {
    const row = await withActorContext(this.pool, async (cli) => {
      const res = await cli.query<{ id: string }>(
        `UPDATE patient_therapeutic_projects
            SET annulled_at = NOW(), annulled_by = $3, annul_reason = $4
          WHERE patient_id = $1 AND id = $2 AND annulled_at IS NULL
          RETURNING id`,
        [patientId, versionId, actorUid, reason],
      );
      if (res.rows.length === 0) return null;
      // P5 (Gabriel, 08/10): anular a VIGENTE pode re-expor uma pendência. Se a nova vigente tem campo PENDING e não há
      // ciclo aberto, abre um — não deixar pendente sem ninguém ser lembrado (mesma regra da criação). A trava do
      // paciente é a mesma do `createVersion` (as duas escritas do ciclo se serializam).
      await cli.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [patientId]);
      const all = await this.listForPatient(patientId, cli);
      const annulledNow = all.find((v) => v.id === versionId);
      const wasCurrent = !!annulledNow && all.every((v) => v.id === versionId || v.annulledAt !== null || v.createdAt < annulledNow.createdAt);
      const after = wasCurrent ? currentVersionOf(all) : null;
      if (after) {
        const rows = (await this.statuses.listByVersions([after.id], cli)).get(after.id) ?? [];
        if (rows.some((r) => r.status === 'PENDING')) {
          await this.reminders.openCycleIfNone(cli, { patientId, anchorVersionId: after.id, openedByUid: actorUid, country: after.country });
        }
      }
      const sel = await cli.query<VersionRow>(`${SELECT_VERSION} WHERE v.id = $1`, [versionId]);
      return sel.rows[0];
    });
    return row ? toVersion(row) : null;
  }
}
