/**
 * wja-test-helper.ts
 *
 * Helpers para inserir/limpar worker_job_applications e encuadres
 * diretamente no banco via `docker exec enlite-postgres psql`.
 *
 * Complementa db-test-helper.ts (que cobre workers, pacientes e vagas)
 * sem duplicar funções existentes.
 */

import { execSync } from 'child_process';

// ── Constants ────────────────────────────────────────────────────────────────

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

// ── Internal helpers ─────────────────────────────────────────────────────────

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString();
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    throw new Error(`DB error: ${e.message}`);
  }
}

function extractUUID(psqlOutput: string): string | null {
  const match = psqlOutput.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface InsertWJAOpts {
  workerId: string;
  jobPostingId: string;
  /** application_funnel_stage — ex: 'INVITED', 'CONFIRMED', 'REJECTED' */
  funnelStage: string;
  /** source — ex: 'system', 'manual', 'talentum' */
  source?: string;
  /** acquisition_channel — ex: 'instagram', 'facebook', 'site', 'system' */
  acquisitionChannel?: string | null;
  /** match_score (0-100) */
  matchScore?: number | null;
  /** interview_response — ex: 'confirmed', 'awaiting_reschedule' */
  interviewResponse?: string | null;
  /** interview_meet_link */
  meetLink?: string | null;
  /** interview_datetime ISO string — ex: '2099-08-10T14:00:00Z' */
  interviewDatetime?: string | null;
}

/**
 * Inserts a worker_job_application directly into the DB.
 * Returns the wja.id UUID.
 *
 * Note: the trigger trg_ensure_encuadre_on_wja_insert fires AFTER INSERT,
 * creating a linked encuadre with origen='auto-trigger'.
 */
export function insertWJA(opts: InsertWJAOpts): string {
  const {
    workerId,
    jobPostingId,
    funnelStage,
    source = 'manual',
    acquisitionChannel = null,
    matchScore = null,
    interviewResponse = null,
    meetLink = null,
    interviewDatetime = null,
  } = opts;

  const channelSql = acquisitionChannel ? `'${acquisitionChannel}'` : 'NULL';
  const scoreSql = matchScore !== null ? String(matchScore) : 'NULL';
  const responseSql = interviewResponse ? `'${interviewResponse}'` : 'NULL';
  const meetSql = meetLink ? `'${meetLink}'` : 'NULL';
  const dtSql = interviewDatetime ? `'${interviewDatetime}'` : 'NULL';

  // Note: application_status column was dropped in migration 196 (F7.c / ADR-004)
  runSQL(`
    INSERT INTO worker_job_applications (
      worker_id, job_posting_id, application_funnel_stage, source,
      acquisition_channel, match_score, interview_response,
      interview_meet_link, interview_datetime,
      created_at, updated_at
    ) VALUES (
      '${workerId}', '${jobPostingId}', '${funnelStage}', '${source}',
      ${channelSql}, ${scoreSql}, ${responseSql},
      ${meetSql}, ${dtSql},
      NOW(), NOW()
    )
    ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
      application_funnel_stage = EXCLUDED.application_funnel_stage,
      source = EXCLUDED.source,
      acquisition_channel = EXCLUDED.acquisition_channel,
      match_score = EXCLUDED.match_score,
      interview_response = EXCLUDED.interview_response,
      interview_meet_link = EXCLUDED.interview_meet_link,
      interview_datetime = EXCLUDED.interview_datetime,
      updated_at = NOW()
  `);

  const out = runSQL(
    `SELECT id FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}' LIMIT 1`,
  );
  const id = extractUUID(out);
  if (!id) {
    throw new Error(`Could not find WJA after insert (worker=${workerId}, job=${jobPostingId})`);
  }
  return id;
}

export interface InsertEncuadreOpts {
  workerId: string;
  jobPostingId: string;
  /** resultado — ex: 'RECHAZADO', 'SELECCIONADO' */
  resultado?: string | null;
  /** rejection_reason_category — ex: 'WORKER_DECLINED', 'NOT_SUITABLE' */
  rejectionReasonCategory?: string | null;
  /** rejection_reason (texto livre) */
  rejectionReason?: string | null;
  /** origen — defaults to 'manual' */
  origen?: string;
}

/**
 * Inserts (or updates) an encuadre row for a worker+vacancy pair.
 * Returns the encuadre.id UUID.
 *
 * In most scenarios the trigger already creates the encuadre — this helper
 * is used to UPDATE rejection fields on an existing encuadre, or to insert
 * one explicitly when the trigger is not expected to run.
 */
export function upsertEncuadre(opts: InsertEncuadreOpts): string {
  const {
    workerId,
    jobPostingId,
    resultado = null,
    rejectionReasonCategory = null,
    rejectionReason = null,
    origen = 'manual',
  } = opts;

  const resultadoSql = resultado ? `'${resultado}'` : 'NULL';
  const reasonCatSql = rejectionReasonCategory ? `'${rejectionReasonCategory}'` : 'NULL';
  const reasonSql = rejectionReason ? `'${rejectionReason}'` : 'NULL';

  // Note: origen was renamed to import_source_audit in migration 197 (F8 / ADR-002)
  const dedupHash = `md5('${origen}|' || '${workerId}' || '|' || '${jobPostingId}')`;

  runSQL(`
    INSERT INTO encuadres (
      worker_id, job_posting_id, import_source_audit, resultado,
      rejection_reason_category, rejection_reason, dedup_hash,
      created_at, updated_at
    ) VALUES (
      '${workerId}', '${jobPostingId}', '${origen}', ${resultadoSql},
      ${reasonCatSql}, ${reasonSql},
      ${dedupHash},
      NOW(), NOW()
    )
    ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
      resultado = COALESCE(EXCLUDED.resultado, encuadres.resultado),
      rejection_reason_category = COALESCE(EXCLUDED.rejection_reason_category, encuadres.rejection_reason_category),
      rejection_reason = COALESCE(EXCLUDED.rejection_reason, encuadres.rejection_reason),
      updated_at = NOW()
  `);

  const out = runSQL(
    `SELECT id FROM encuadres WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}' ORDER BY created_at DESC LIMIT 1`,
  );
  const id = extractUUID(out);
  if (!id) {
    throw new Error(`Could not find encuadre after upsert (worker=${workerId}, job=${jobPostingId})`);
  }
  return id;
}

/**
 * Deletes WJAs, encuadres and talentum_prescreenings for a given worker+vacancy pair.
 * Safe to call even if no rows exist.
 */
export function cleanupWJAAndEncuadre(workerId: string, jobPostingId: string): void {
  if (!workerId || !jobPostingId) return;
  runSQL(`DELETE FROM talentum_prescreenings WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}'`);
  runSQL(`DELETE FROM encuadres WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}'`);
  runSQL(`DELETE FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}'`);
}
