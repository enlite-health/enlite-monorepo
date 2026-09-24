/**
 * vacancyCrudAuditHelpers
 *
 * Audit-log helpers for VacancyCrudController mutations.
 * Extracted to keep VacancyCrudController within the 400-line limit.
 *
 * Design:
 * - All helpers accept a PoolClient (open transaction) and insert audit rows
 *   INSIDE the same transaction using logEventSafe / logFieldChangesSafe.
 * - Those methods use PostgreSQL SAVEPOINTs internally so that an audit
 *   INSERT failure (e.g. FK violation on actor_user_id) rolls back ONLY the
 *   audit row, leaving the surrounding transaction intact to COMMIT.
 * - Audit failures are logged by the repository; they NEVER surface to the
 *   HTTP caller. The mutation is always the priority.
 */

import type { Pool, PoolClient } from 'pg';
import type { AuditActorType } from '@shared/audit/types';
import {
  JobPostingAuditRepository,
} from '../../infrastructure/JobPostingAuditRepository';
import {
  captureVacancyDiff,
  FULL_ALLOWED_UPDATE_FIELDS,
  buildInsertQuery,
  buildInsertParams,
  retryOnCaseOrdinalConflict,
  type VacancyInsertParams,
} from './vacancyCrudHelpers';

const auditRepo = new JobPostingAuditRepository();

// ─── Actor type ───────────────────────────────────────────────────────────────

/**
 * Ator de uma escrita auditada de vaga. Chamava-se `HumanActor` porque, até a
 * T017 (spec 027, US2), só o painel humano (`extractHumanActor`, sempre
 * `actorType: 'HUMAN'`/`actorLabel: 'admin_panel'`) chegava até aqui. Agora
 * aceita os 4 valores que `audit_log.actor_type` já permite (ver
 * `@shared/audit/types.ts:20`) — o disparo do sistema (T018,
 * `ActivateRecruitmentUseCase`) é o primeiro caller que não é humano.
 * NÃO renomeada: os 3 call sites de `VacancyCrudController.ts` continuam
 * importando `HumanActor` e passando `'HUMAN'`/`'admin_panel'` sem mudar nada.
 */
export interface HumanActor {
  actorUserId: string | null;
  actorType: AuditActorType;
  actorLabel: string;
  traceId?: string | null;
}

// ─── createVacancy audit ─────────────────────────────────────────────────────

/**
 * Logs a CREATED event after a vacancy is inserted.
 * The snapshot captures the key fields of the newly created vacancy row.
 *
 * Called inside a PoolClient transaction when the vacancy is part of a
 * patient-update flow; otherwise called with a freshly acquired client
 * that is committed/rolled-back inline (best-effort, no throw).
 */
export async function auditVacancyCreated(
  client: PoolClient,
  jobPostingId: string,
  after: Record<string, unknown>,
  actor: HumanActor,
): Promise<void> {
  const snapshot = pickAuditFields(after);
  // logEventSafe uses a SAVEPOINT so FK/constraint failures do not abort the
  // surrounding transaction — the mutation can still COMMIT successfully.
  await auditRepo.logEventSafe(client, {
    jobPostingId,
    eventType: 'CREATED',
    changes: { before: null, after: snapshot },
    actorUserId: actor.actorUserId,
    actorType: actor.actorType,
    actorLabel: actor.actorLabel,
    traceId: actor.traceId ?? null,
  });
}

// ─── updateVacancy audit ─────────────────────────────────────────────────────

/**
 * Logs field-level changes for a PUT /api/admin/vacancies/:id request.
 * Uses captureVacancyDiff to emit one audit row per changed field.
 */
export async function auditVacancyUpdated(
  client: PoolClient,
  jobPostingId: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  actor: HumanActor,
): Promise<void> {
  const diffs = captureVacancyDiff(before, after, FULL_ALLOWED_UPDATE_FIELDS);
  if (diffs.length === 0) return;

  // logFieldChangesSafe uses SAVEPOINTs so FK/constraint failures do not abort
  // the surrounding transaction — the mutation can still COMMIT successfully.
  await auditRepo.logFieldChangesSafe(client, {
    jobPostingId,
    fields: diffs,
    actorUserId: actor.actorUserId,
    actorType: actor.actorType,
    actorLabel: actor.actorLabel,
    traceId: actor.traceId ?? null,
  });
}

// ─── deleteVacancy audit ─────────────────────────────────────────────────────

/**
 * Logs a DELETED event (soft-delete: status=CLOSED, deleted_at=NOW()).
 */
export async function auditVacancyDeleted(
  client: PoolClient,
  jobPostingId: string,
  before: Record<string, unknown>,
  actor: HumanActor,
): Promise<void> {
  const snapshot = pickAuditFields(before);
  // logEventSafe uses a SAVEPOINT so FK/constraint failures do not abort the
  // surrounding transaction — the soft-delete can still COMMIT successfully.
  await auditRepo.logEventSafe(client, {
    jobPostingId,
    eventType: 'DELETED',
    changes: { before: snapshot, after: null },
    actorUserId: actor.actorUserId,
    actorType: actor.actorType,
    actorLabel: actor.actorLabel,
    traceId: actor.traceId ?? null,
  });
}

// ─── createWithPatientUpdate ──────────────────────────────────────────────────

/**
 * Wraps INSERT job_posting + optional patient field update + audit in one transaction.
 * Extracted from VacancyCrudController to keep that file under 400 lines.
 */
export async function createWithPatientUpdate(
  pool: Pool,
  case_number: unknown,
  updatePatient: Record<string, unknown>,
  insertArgs: VacancyInsertParams,
  actor: HumanActor,
): Promise<Record<string, unknown>> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');

    const patientRow = await client.query<{
      id: string; diagnosis: string | null; dependency_level: string | null;
    }>(
      `SELECT id, diagnosis, dependency_level FROM patients
       WHERE id = (
         SELECT patient_id FROM job_postings
         WHERE case_number = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1
       ) FOR UPDATE`,
      [case_number],
    );

    if (patientRow.rows.length > 0) {
      const pat = patientRow.rows[0];
      const setClauses: string[] = [];
      const auditEntries: Array<{ field: string; old: string | null; new: string }> = [];
      const updateParams: unknown[] = [pat.id];

      if (updatePatient.pathology_types !== undefined) {
        updateParams.push(String(updatePatient.pathology_types));
        setClauses.push(`diagnosis = $${updateParams.length}`);
        auditEntries.push({ field: 'diagnosis', old: pat.diagnosis, new: String(updatePatient.pathology_types) });
      }
      if (updatePatient.dependency_level !== undefined) {
        updateParams.push(String(updatePatient.dependency_level));
        setClauses.push(`dependency_level = $${updateParams.length}`);
        auditEntries.push({ field: 'dependency_level', old: pat.dependency_level, new: String(updatePatient.dependency_level) });
      }

      if (setClauses.length > 0) {
        await client.query(
          `UPDATE patients SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1`,
          updateParams,
        );
        for (const e of auditEntries) {
          await client.query(
            `INSERT INTO patient_field_overrides_audit
               (patient_id, field_name, old_value, new_value, source)
             VALUES ($1, $2, $3, $4, 'vacancy_create_pdf')`,
            [pat.id, e.field, e.old, e.new],
          );
        }
      }
    }

    // case_ordinal (spec 027 Fase 5) é computado dentro do próprio INSERT; em conflito
    // (23505 de idx_job_postings_case_ordinal) SAVEPOINT + retry recalcula e tenta de novo,
    // sem abortar a transação (paciente + audit) que o envolve.
    const result = await retryOnCaseOrdinalConflict(
      async () => {
        await client.query('SAVEPOINT case_ordinal_retry');
        const r = await client.query(buildInsertQuery(), buildInsertParams(insertArgs));
        await client.query('RELEASE SAVEPOINT case_ordinal_retry');
        return r;
      },
      async () => {
        await client.query('ROLLBACK TO SAVEPOINT case_ordinal_retry');
      },
    );
    const newVacancy = result.rows[0] as Record<string, unknown>;

    // Audit inside the same transaction — atomic with the insert
    await auditVacancyCreated(client, newVacancy.id as string, newVacancy, actor);

    await client.query('COMMIT');
    return newVacancy;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Returns a subset of fields that are meaningful for the audit log.
 * Avoids logging very large JSONB blobs verbatim — only scalar / small fields.
 */
function pickAuditFields(row: Record<string, unknown>): Record<string, unknown> {
  const AUDIT_SNAPSHOT_FIELDS = [
    'id', 'vacancy_number', 'case_number', 'title', 'status', 'is_draft',
    'patient_id', 'patient_address_id', 'providers_needed', 'salary_text',
    'published_at', 'closes_at', 'deleted_at', 'country',
  ] as const;

  const out: Record<string, unknown> = {};
  for (const f of AUDIT_SNAPSHOT_FIELDS) {
    if (f in row) out[f] = row[f];
  }
  return out;
}
