/**
 * phase3_5-llm-cleanup-invariants.e2e.test.ts
 *
 * Invariants for Fase 3.5 — removal of encuadres.llm_* columns.
 *
 * Uses a real Postgres (E2E Docker) database.
 *
 * Invariants covered:
 *   I19 — colunas llm_* não existem mais em encuadres
 *   I20 — rejection_reason_category enum continua funcionando
 *   I21 — upsert de encuadre não usa mais campos llm_* (funciona sem erro)
 *   I22 — MatchmakingService.hardFilter não referencia colunas llm_* dropadas
 */

import { Pool } from 'pg';
import * as crypto from 'crypto';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: TEST_DATABASE_URL });

function suffix(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function dedupHash(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

afterAll(async () => {
  await pool.end();
});

// ── I19: colunas llm_* não existem em encuadres ───────────────────────────────

describe('I19 — colunas llm_* não existem mais em encuadres', () => {
  it('information_schema.columns retorna 0 colunas llm_% em encuadres', async () => {
    const { rows } = await pool.query<{ col_count: string }>(
      `SELECT COUNT(*)::text AS col_count
       FROM information_schema.columns
       WHERE table_name = 'encuadres'
         AND column_name LIKE 'llm_%'
         AND table_schema = 'public'`,
    );
    expect(parseInt(rows[0].col_count)).toBe(0);
  });

  it('nenhuma coluna _deprecated_ llm_* existe em encuadres', async () => {
    const { rows } = await pool.query<{ col_count: string }>(
      `SELECT COUNT(*)::text AS col_count
       FROM information_schema.columns
       WHERE table_name = 'encuadres'
         AND column_name LIKE 'llm_%deprecated%'
         AND table_schema = 'public'`,
    );
    expect(parseInt(rows[0].col_count)).toBe(0);
  });
});

// ── I20: rejection_reason_category continua funcionando ───────────────────────

describe('I20 — rejection_reason_category enum continua funcionando', () => {
  let jobPostingId: string;
  let workerId: string;

  beforeAll(async () => {
    const s = suffix();
    // Insert minimal job_posting
    const jpRes = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status)
       VALUES ($1, 'I20 e2e test', 'AR', 'SEARCHING') RETURNING id`,
      [`I20-JP-${s}`],
    );
    jobPostingId = jpRes.rows[0].id;

    // Insert minimal worker (auth_uid and email are NOT NULL in workers table)
    const wPhone = `+549${Date.now().toString().slice(-10)}`;
    const wRes = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, occupation, status, country)
       VALUES ($1, $2, $3, 'AT', 'REGISTERED', 'AR') RETURNING id`,
      [`i20-${s}`, `i20-${s}@e2e.test`, wPhone],
    );
    workerId = wRes.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM encuadres WHERE obs_adicionales = 'I20-e2e-test'`);
    await pool.query(`DELETE FROM job_postings WHERE description = 'I20 e2e test'`);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  });

  it('INSERT com rejection_reason_category válido funciona', async () => {
    const s = suffix();
    const hash = dedupHash(`I20-valid-${s}`);
    await expect(pool.query(
      `INSERT INTO encuadres
         (worker_id, job_posting_id, worker_raw_name, worker_raw_phone,
          rejection_reason_category, dedup_hash, obs_adicionales)
       VALUES ($1, $2, 'Test Worker', '+5491100000000', 'DISTANCE', $3, 'I20-e2e-test')`,
      [workerId, jobPostingId, hash],
    )).resolves.toBeDefined();
  });

  it('INSERT com rejection_reason_category inválido falha por CHECK constraint', async () => {
    const s = suffix();
    const hash = dedupHash(`I20-invalid-${s}`);
    await expect(pool.query(
      `INSERT INTO encuadres
         (worker_id, job_posting_id, worker_raw_name, worker_raw_phone,
          rejection_reason_category, dedup_hash, obs_adicionales)
       VALUES ($1, $2, 'Test Worker', '+5491100000000', 'INVALID_VALUE', $3, 'I20-e2e-test')`,
      [workerId, jobPostingId, hash],
    )).rejects.toThrow();
  });
});

// ── I21: upsert não referencia llm_* ──────────────────────────────────────────

describe('I21 — upsert de encuadre não usa mais campos llm_*', () => {
  let jobPostingId: string;

  beforeAll(async () => {
    const s = suffix();
    const res = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status)
       VALUES ($1, 'I21 e2e test', 'AR', 'SEARCHING') RETURNING id`,
      [`I21-JP-${s}`],
    );
    jobPostingId = res.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM encuadres WHERE obs_adicionales = 'I21-e2e-test'`);
    await pool.query(`DELETE FROM job_postings WHERE description = 'I21 e2e test'`);
  });

  it('upsert via SQL (sem llm_*) funciona e retorna encuadre', async () => {
    const s = suffix();
    const hash = dedupHash(`I21-upsert-${s}`);
    const res = await pool.query(
      `INSERT INTO encuadres (
         job_posting_id, worker_raw_name, worker_raw_phone,
         recruiter_name, recruitment_date,
         dedup_hash, obs_adicionales
       ) VALUES ($1, 'AT Test', '+5491199990000', 'Recrutador', NOW()::date, $2, 'I21-e2e-test')
       ON CONFLICT (dedup_hash) DO UPDATE SET
         obs_reclutamiento = EXCLUDED.obs_reclutamiento,
         updated_at = NOW()
       RETURNING id, dedup_hash`,
      [jobPostingId, hash],
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].id).toBeTruthy();
    expect(res.rows[0].dedup_hash).toBe(hash);
  });

  it('re-upsert do mesmo dedup_hash não falha (ON CONFLICT)', async () => {
    const s = suffix();
    const hash = dedupHash(`I21-reinsert-${s}`);

    // First insert
    await pool.query(
      `INSERT INTO encuadres (job_posting_id, worker_raw_name, worker_raw_phone, dedup_hash, obs_adicionales)
       VALUES ($1, 'AT Test 2', '+5491100000001', $2, 'I21-e2e-test')`,
      [jobPostingId, hash],
    );

    // Second insert — should hit ON CONFLICT path
    const res = await pool.query(
      `INSERT INTO encuadres (job_posting_id, worker_raw_name, worker_raw_phone, dedup_hash, obs_adicionales)
       VALUES ($1, 'AT Test 2', '+5491100000001', $2, 'I21-e2e-test')
       ON CONFLICT (dedup_hash) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [jobPostingId, hash],
    );
    expect(res.rows).toHaveLength(1);
  });
});

// ── I22: hard filter SQL não referencia llm_* ────────────────────────────────

describe('I22 — hard filter SQL (MatchmakingService) não crashar por colunas dropadas', () => {
  let jobPostingId: string;
  let workerId: string;

  beforeAll(async () => {
    const s = suffix();

    const jpRes = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, country, status)
       VALUES ($1, 'I22 e2e test', 'AR', 'SEARCHING') RETURNING id`,
      [`I22-JP-${s}`],
    );
    jobPostingId = jpRes.rows[0].id;

    // auth_uid and email are NOT NULL in workers table
    const wPhone = `+549${(Date.now() + 1).toString().slice(-10)}`;
    const wRes = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, occupation, status, country)
       VALUES ($1, $2, $3, 'AT', 'REGISTERED', 'AR') RETURNING id`,
      [`i22-${s}`, `i22-${s}@e2e.test`, wPhone],
    );
    workerId = wRes.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM encuadres WHERE obs_adicionales = 'I22-e2e-test'`);
    await pool.query(`DELETE FROM job_postings WHERE description = 'I22 e2e test'`);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
  });

  it('hard filter SQL (sem llm_* subqueries) executa sem erro', async () => {
    // This replicates the core of MatchmakingService.hardFilter() SELECT.
    // If any removed column is still referenced, this query would fail.
    const res = await pool.query(
      `SELECT
         w.id AS worker_id,
         w.phone,
         w.occupation,
         w.status AS worker_status,
         COALESCE(w.diagnostic_preferences, '{}') AS diagnostic_preferences,
         w.sex_encrypted,
         w.first_name_encrypted,
         w.last_name_encrypted,
         wsa.work_zone,
         wsa.address_line AS worker_address,
         wsa.interest_zone,
         wsa.latitude AS worker_lat,
         wsa.longitude AS worker_lng,
         (
           SELECT COALESCE(json_agg(json_build_object(
             'case_number', jp2.case_number,
             'schedule_text', jp2.schedule_days_hours
           )), '[]'::json)
           FROM encuadres ea
           JOIN job_postings jp2 ON jp2.id = ea.job_posting_id
           WHERE ea.worker_id = w.id
             AND ea.resultado = 'SELECCIONADO'
             AND jp2.is_covered = false
         ) AS active_cases,
         EXISTS (
           SELECT 1 FROM worker_job_applications wja
           WHERE wja.worker_id = w.id AND wja.job_posting_id = $1
         ) AS already_applied,
         (
           SELECT COALESCE(json_object_agg(rej.cat, rej.cnt), '{}'::json)
           FROM (
             SELECT rejection_reason_category AS cat, COUNT(*)::integer AS cnt
             FROM encuadres e_rej
             WHERE e_rej.worker_id = w.id
               AND e_rej.rejection_reason_category IS NOT NULL
             GROUP BY rejection_reason_category
           ) rej
         ) AS rejection_history,
         w.avg_quality_rating
       FROM workers w
       LEFT JOIN blacklist bl ON bl.worker_id = w.id
       LEFT JOIN worker_service_areas wsa ON wsa.worker_id = w.id AND wsa.deleted_at IS NULL
       WHERE w.id = $2
         AND w.merged_into_id IS NULL
         AND bl.id IS NULL
       GROUP BY w.id, wsa.work_zone, wsa.address_line, wsa.interest_zone, wsa.latitude, wsa.longitude`,
      [jobPostingId, workerId],
    );

    // Query should execute without error
    expect(Array.isArray(res.rows)).toBe(true);
  });

  it('encuadre upsert para o worker não referencia llm_* dropadas', async () => {
    const hash = dedupHash(`I22-enc-${workerId}-${jobPostingId}`);
    const res = await pool.query(
      `INSERT INTO encuadres (
         worker_id, job_posting_id, worker_raw_phone,
         resultado, dedup_hash, obs_adicionales
       ) VALUES ($1, $2, '+5491100000002', 'SELECCIONADO', $3, 'I22-e2e-test')
       ON CONFLICT (dedup_hash) DO UPDATE SET resultado = EXCLUDED.resultado, updated_at = NOW()
       RETURNING id`,
      [workerId, jobPostingId, hash],
    );
    expect(res.rows).toHaveLength(1);
  });
});
