import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { withActorContext } from '@shared/database/actorContext';
import {
  nextMajor,
  nextMinorOf,
  sortByCreatedDesc,
  versionLabel,
  type CatalogSnapshotItem,
  type TherapeuticDiagnosis,
  type TherapeuticModality,
  type TherapeuticProjectVersion,
} from '../domain/TherapeuticProject';
import { TherapeuticCatalogRepository } from './TherapeuticCatalogRepository';

interface VersionRow {
  id: string;
  patient_id: string;
  major: number;
  minor: number;
  edited_from_version_id: string | null;
  contracted_service_id: string;
  modality: TherapeuticModality | null;
  diagnoses: TherapeuticDiagnosis[];
  clinical_context: string;
  general_objective: string;
  specific_objectives: CatalogSnapshotItem[];
  activities: CatalogSnapshotItem[];
  pathology_types: CatalogSnapshotItem[];
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
  pathologyTypeIds: string[];
  startDate: string;
  endDate: string;
}

export type CreateVersionCommand =
  | { mode: 'new'; patientId: string; actorUid: string; version: TherapeuticProjectVersionInput }
  | { mode: 'edit'; patientId: string; actorUid: string; fromVersionId: string; version: TherapeuticProjectVersionInput };

/** A versão de origem do "Editar" não existe neste paciente (ou está anulada). */
export class SourceVersionNotFoundError extends Error {
  readonly code = 'source_version_not_found';
  constructor() {
    super('source_version_not_found');
  }
}

/** O paciente não existe (ou não é visível sob a RLS) — a trava `FOR UPDATE` não achou linha. */
export class PatientNotFoundForProjectError extends Error {
  readonly code = 'patient_not_found';
  constructor() {
    super('patient_not_found');
  }
}

/** O serviço contratado escolhido não é deste paciente (trigger `ptp_service_de_outro_paciente`, 416). */
export class ServiceNotOfPatientError extends Error {
  readonly code = 'service_not_of_patient';
  constructor() {
    super('service_not_of_patient');
  }
}

const isServiceOfOtherPatient = (err: unknown): boolean =>
  /ptp_service_de_outro_paciente/.test(String((err as { message?: string })?.message ?? ''));

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
    modality: r.modality ?? null,
    diagnoses: r.diagnoses,
    clinicalContext: r.clinical_context,
    generalObjective: r.general_objective,
    specificObjectives: r.specific_objectives,
    activities: r.activities,
    pathologyTypes: r.pathology_types,
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

  constructor(private readonly catalogs: TherapeuticCatalogRepository = new TherapeuticCatalogRepository()) {}

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
        // Trava o paciente: a numeração é lida e gravada na MESMA transação. Zero linhas = paciente
        // inexistente OU invisível sob a RLS — 404 nos dois casos (nunca dizer qual).
        const lock = await cli.query('SELECT id FROM patients WHERE id = $1 FOR UPDATE', [cmd.patientId]);
        if (lock.rows.length === 0) throw new PatientNotFoundForProjectError();
        const existing = await this.listForPatient(cmd.patientId, cli);

        let number: { major: number; minor: number };
        let editedFrom: string | null = null;
        if (cmd.mode === 'new') {
          number = nextMajor(existing);
        } else {
          const source = existing.find((v) => v.id === cmd.fromVersionId && v.annulledAt === null);
          if (!source) throw new SourceVersionNotFoundError();
          number = nextMinorOf(existing, source.major);
          editedFrom = source.id;
        }

        // Snapshot montado AQUI, do catálogo (lex C19): o cliente manda ids, a versão congela texto.
        const [specificObjectives, activities, pathologyTypes] = await Promise.all([
          this.catalogs.snapshotOf('specific-objectives', cmd.version.specificObjectiveIds, cli),
          this.catalogs.snapshotOf('activities', cmd.version.activityIds, cli),
          this.catalogs.snapshotOf('pathology-types', cmd.version.pathologyTypeIds, cli),
        ]);

        const ins = await cli.query<{ id: string }>(
          `INSERT INTO patient_therapeutic_projects
             (patient_id, major, minor, edited_from_version_id, contracted_service_id, diagnoses,
              clinical_context, general_objective, specific_objectives, activities, pathology_types,
              start_date, end_date, created_by, modality)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13, $14, $15)
           RETURNING id`,
          [
            cmd.patientId, number.major, number.minor, editedFrom, cmd.version.contractedServiceId,
            JSON.stringify(cmd.version.diagnoses), cmd.version.clinicalContext, cmd.version.generalObjective,
            JSON.stringify(specificObjectives), JSON.stringify(activities), JSON.stringify(pathologyTypes),
            cmd.version.startDate, cmd.version.endDate, cmd.actorUid, cmd.version.modality,
          ],
        );
        const sel = await cli.query<VersionRow>(`${SELECT_VERSION} WHERE v.id = $1`, [ins.rows[0].id]);
        return sel.rows[0];
      });
      return toVersion(row);
    } catch (err) {
      if (isServiceOfOtherPatient(err)) throw new ServiceNotOfPatientError();
      throw err;
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
      const sel = await cli.query<VersionRow>(`${SELECT_VERSION} WHERE v.id = $1`, [versionId]);
      return sel.rows[0];
    });
    return row ? toVersion(row) : null;
  }
}
