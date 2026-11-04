/**
 * LegacyVacancyCutoffRepository — SQL da LINHA DE CORTE (spec 084 F3). TODO método roda no `client` da transação do
 * chamador (uma só: ensaio = ROLLBACK, apply = COMMIT). Só IDs, números de caso, status e contagens saem daqui —
 * nenhuma coluna de nome/telefone/texto. Nada aqui apaga linha de `job_postings` (R2).
 */
import type { PoolClient } from 'pg';
import { classifyLegacyVacancy, isGroupE, isOpenVacancy, type CutoffDecision, type LegacyVacancyFacts } from '../domain/LegacyVacancyCutoff';
import { OPEN_JOB_STATUSES } from '../../matching/domain/openJobStatuses';

export interface ClassifiedVacancy extends CutoffDecision {
  vacancyId: string;
  caseNumber: number | null;
  patientId: string | null;
  status: string;
}

export interface GroupEVacancy {
  vacancyId: string;
  caseNumber: number | null;
  serviceId: string;
}

export interface MergeCandidate {
  vacancyId: string;
  vacancyCaseOrdinal: number | null;
  status: string;
  isDraft: boolean;
}

export class LegacyVacancyCutoffRepository {
  /** Vagas vivas SEM serviço, fora de DE_BAJA, classificadas pela regra pura. Trava as linhas (apply grava depois). */
  async classifyLegacy(client: PoolClient): Promise<ClassifiedVacancy[]> {
    const res = await client.query<{
      id: string;
      case_number: number | null;
      patient_id: string | null;
      status: string;
      is_draft: boolean;
      patient_exists: boolean;
      patient_status: string | null;
      service_count: number;
      active_service_count: number;
    }>(
      `SELECT jp.id, jp.case_number, jp.patient_id, jp.status, jp.is_draft,
              (p.id IS NOT NULL AND p.deleted_at IS NULL) AS patient_exists,
              CASE WHEN p.deleted_at IS NULL THEN p.status END AS patient_status,
              (SELECT count(*) FROM patient_contracted_services s WHERE s.patient_id = jp.patient_id)::int AS service_count,
              (SELECT count(*) FROM patient_contracted_services s WHERE s.patient_id = jp.patient_id AND s.active)::int AS active_service_count
         FROM job_postings jp
         LEFT JOIN patients p ON p.id = jp.patient_id
        WHERE jp.deleted_at IS NULL AND jp.contracted_service_id IS NULL AND jp.status != 'DE_BAJA'
          AND COALESCE(jp.is_test, false) = false
        ORDER BY jp.case_number NULLS LAST, jp.created_at, jp.id`,
    );
    return res.rows.map((r) => {
      const facts: LegacyVacancyFacts = {
        status: r.status,
        isDraft: r.is_draft,
        hasPatientId: r.patient_id !== null,
        patientExists: r.patient_exists,
        patientStatus: r.patient_status,
        patientServiceCount: r.service_count,
        patientActiveServiceCount: r.active_service_count,
      };
      return {
        vacancyId: r.id, caseNumber: r.case_number, patientId: r.patient_id, status: r.status, ...classifyLegacyVacancy(facts),
      };
    });
  }

  /** Grupo e: vaga de serviço ATIVO hoje CLOSED. */
  async listGroupE(client: PoolClient): Promise<GroupEVacancy[]> {
    const res = await client.query<{ id: string; case_number: number | null; status: string; service_id: string; active: boolean }>(
      `SELECT jp.id, jp.case_number, jp.status, jp.contracted_service_id AS service_id, s.active
         FROM job_postings jp JOIN patient_contracted_services s ON s.id = jp.contracted_service_id
        WHERE jp.deleted_at IS NULL AND jp.status = 'CLOSED' AND COALESCE(jp.is_test, false) = false
        ORDER BY jp.case_number NULLS LAST, jp.id`,
    );
    return res.rows
      .filter((r) => isGroupE({ status: r.status, serviceActive: r.active }))
      .map((r) => ({ vacancyId: r.id, caseNumber: r.case_number, serviceId: r.service_id }));
  }

  /**
   * CLOSED → ON_HOLD (F5/R18). Idempotente: só toca o que ainda está CLOSED com serviço ativo. `status_before_hold` = SEARCHING, NÃO CLOSED:
   * vaga de serviço ativo nunca é encerrada (R4), então "Reanudar" para CLOSED seria recusado (409) pelo servidor.
   */
  async putOnHold(client: PoolClient, vacancyIds: readonly string[]): Promise<string[]> {
    if (vacancyIds.length === 0) return [];
    const res = await client.query<{ id: string }>(
      `UPDATE job_postings jp
          SET status_before_hold = 'SEARCHING', status = 'ON_HOLD', updated_at = NOW()
         FROM patient_contracted_services s
        WHERE jp.id = ANY($1::uuid[]) AND s.id = jp.contracted_service_id AND s.active
          AND jp.status = 'CLOSED' AND jp.deleted_at IS NULL
        RETURNING jp.id`,
      [vacancyIds],
    );
    return res.rows.map((r) => r.id);
  }

  /** Vagas de serviço do paciente que podem ser DESTINO do merge (o recrutamento escolhe no ensaio). */
  async mergeCandidates(client: PoolClient, patientId: string): Promise<MergeCandidate[]> {
    const res = await client.query<{ id: string; case_ordinal: number | null; status: string; is_draft: boolean }>(
      `SELECT id, case_ordinal, status, is_draft FROM job_postings
        WHERE patient_id = $1 AND deleted_at IS NULL AND contracted_service_id IS NOT NULL AND status != 'DE_BAJA'
        ORDER BY case_ordinal NULLS LAST, id`,
      [patientId],
    );
    return res.rows.map((r) => ({ vacancyId: r.id, vacancyCaseOrdinal: r.case_ordinal, status: r.status, isDraft: r.is_draft }));
  }

  /** "Abertas sem serviço" (SUP-3) — a conta antes/depois do relatório. */
  async countOpenWithoutService(client: PoolClient): Promise<number> {
    const res = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM job_postings
        WHERE deleted_at IS NULL AND contracted_service_id IS NULL AND is_draft = false
          AND status IN (${OPEN_JOB_STATUSES.map((s) => `'${s}'`).join(',')}) AND COALESCE(is_test, false) = false`,
    );
    return res.rows[0].n;
  }

  /** Total de vagas não apagadas — prova de que a aplicação NUNCA apaga (antes = depois). */
  async countLiveVacancies(client: PoolClient): Promise<number> {
    const res = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_postings WHERE deleted_at IS NULL`);
    return res.rows[0].n;
  }

  /** Quantas das vagas têm projeto no Talentum (só a contagem e os ids; o pause é do chamador, DEPOIS do commit). */
  async withTalentumProject(client: PoolClient, vacancyIds: readonly string[]): Promise<string[]> {
    if (vacancyIds.length === 0) return [];
    const res = await client.query<{ id: string }>(
      `SELECT id FROM job_postings WHERE id = ANY($1::uuid[]) AND talentum_project_id IS NOT NULL ORDER BY id`,
      [vacancyIds],
    );
    return res.rows.map((r) => r.id);
  }

  /** Cards BLOQUEADOS (tentativas) da vaga antiga → vaga do serviço; o par já presente no destino fica na antiga (sem duplicar). */
  async moveBlockedApplications(client: PoolClient, fromId: string, toId: string): Promise<{ moved: number; left: number }> {
    const moved = await client.query(
      `UPDATE worker_blocked_applications b SET job_posting_id = $2
        WHERE b.job_posting_id = $1
          AND NOT EXISTS (SELECT 1 FROM worker_blocked_applications o WHERE o.job_posting_id = $2 AND o.worker_id = b.worker_id)`,
      [fromId, toId],
    );
    const left = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM worker_blocked_applications WHERE job_posting_id = $1`,
      [fromId],
    );
    return { moved: moved.rowCount ?? 0, left: left.rows[0].n };
  }

  async countBlockedApplications(client: PoolClient, vacancyId: string): Promise<number> {
    const res = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM worker_blocked_applications WHERE job_posting_id = $1`,
      [vacancyId],
    );
    return res.rows[0].n;
  }
}

export { isOpenVacancy };
