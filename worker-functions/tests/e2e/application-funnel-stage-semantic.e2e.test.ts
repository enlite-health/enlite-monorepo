/**
 * application-funnel-stage-semantic.e2e.test.ts — E2E Tests (DB-level)
 *
 * Valida a semântica correta pós-migration 187:
 *
 *   INVITED       = worker clicou no link público OU foi detectado via sync Talentum
 *                   (sem evidência de entrada no WhatsApp Talentum)
 *   PRE_SCREENING = ÚNICA fonte: worker entrou no WhatsApp Talentum
 *                   (webhook PRESCREENING_RESPONSE subtype=INITIATED ou drag manual no Kanban)
 *
 *   Migration 187: removeu DEFAULT 'INITIATED' + forçou NOT NULL.
 *   INSERT sem application_funnel_stage agora falha com not_null_violation (23502).
 *
 *   Migration 230 (2026-06-26): renomeou o stage canônico interno INITIATED→PRE_SCREENING
 *   (o subtype do webhook Talentum continua se chamando 'INITIATED' — é mapeado ANTES do
 *   INSERT, ver TalentumFunnelStageMapper). Migration 264/#95 (Fase-2) removeu 'INITIATED'
 *   do CHECK constraint definitivamente — por isso os testes abaixo usam PRE_SCREENING
 *   como o stage "já avançado" que o sync não deve regredir.
 *
 * Tests:
 *   S1 — trackChannel cria WJA com stage INVITED (não PRE_SCREENING)
 *   S2 — SyncTalentumWorkersUseCase cria WJA com stage INVITED
 *   S3 — Sync NÃO regride WJA já em PRE_SCREENING+ (ON CONFLICT DO NOTHING preserva)
 *   S4 — INSERT sem stage falha com NOT NULL constraint (schema test — migration 187)
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('application_funnel_stage semântica (migration 187)', () => {
  let pool: Pool;
  let workerId: string;
  let jobPostingId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    // Worker REGISTERED (necessário para trigger trg_enforce_worker_registered)
    const wRes = await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, status, country)
       VALUES ('stage-sem-e2e-001', 'stage-sem-001@test.local', '5491100099001', 'REGISTERED', 'AR')
       RETURNING id`,
    );
    workerId = wRes.rows[0].id as string;

    // Job posting para linkar
    const jpRes = await pool.query(
      `INSERT INTO job_postings (case_number, title, description, country, status)
       VALUES (99840, 'CASO 99840 Stage Sem E2E', '', 'AR', 'SEARCHING')
       RETURNING id`,
    );
    jobPostingId = jpRes.rows[0].id as string;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM worker_job_applications WHERE worker_id = $1', [workerId]).catch(() => {});
    await pool.query('DELETE FROM encuadres WHERE worker_id = $1', [workerId]).catch(() => {});
    await pool.query('DELETE FROM workers WHERE id = $1', [workerId]).catch(() => {});
    await pool.query('DELETE FROM job_postings WHERE id = $1', [jobPostingId]).catch(() => {});
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query(
      'DELETE FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2',
      [workerId, jobPostingId],
    ).catch(() => {});
  });

  // ═══════════════════════════════════════════════════════════════
  // S1 — trackChannel cria WJA com stage INVITED
  //
  // Replicar o INSERT do WorkerApplicationsController.trackChannel.
  // Worker clicou no link público → stage = INVITED, não INITIATED.
  // ═══════════════════════════════════════════════════════════════

  it('[S1] trackChannel: INSERT com stage=INVITED (worker clicou no link público, não PRE_SCREENING)', async () => {
    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, source, acquisition_channel, application_funnel_stage)
       VALUES ($1, $2, 'manual', 'site', 'INVITED')
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
         acquisition_channel = CASE
           WHEN worker_job_applications.acquisition_channel IS NULL THEN EXCLUDED.acquisition_channel
           ELSE worker_job_applications.acquisition_channel
         END,
         updated_at = NOW()`,
      [workerId, jobPostingId],
    );

    const { rows } = await pool.query(
      `SELECT application_funnel_stage, source, acquisition_channel
       FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, jobPostingId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('INVITED');
    expect(rows[0].source).toBe('manual');
    expect(rows[0].acquisition_channel).toBe('site');
  });

  // ═══════════════════════════════════════════════════════════════
  // S2 — SyncTalentumWorkersUseCase cria WJA com stage INVITED
  //
  // Replicar o INSERT do SyncTalentumWorkersUseCase.linkToCases.
  // Worker detectado no dashboard Talentum → stage = INVITED.
  // ═══════════════════════════════════════════════════════════════

  it('[S2] sync Talentum: INSERT com stage=INVITED (worker detectado no dashboard)', async () => {
    const result = await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'talentum')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING
       RETURNING id`,
      [workerId, jobPostingId],
    );

    expect(result.rowCount).toBe(1);

    const { rows } = await pool.query(
      `SELECT application_funnel_stage, source
       FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, jobPostingId],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('INVITED');
    expect(rows[0].source).toBe('talentum');
  });

  // ═══════════════════════════════════════════════════════════════
  // S3 — Sync NÃO regride WJA já em PRE_SCREENING+ (ON CONFLICT DO NOTHING preserva)
  //
  // Cenário: WJA já existe em PRE_SCREENING (veio do webhook PRESCREENING_RESPONSE,
  // que hoje mapeia subtype='INITIATED'→'PRE_SCREENING' — migration 230/#95).
  // O sync roda de novo. ON CONFLICT DO NOTHING preserva PRE_SCREENING.
  // ═══════════════════════════════════════════════════════════════

  it('[S3] sync não regride stage PRE_SCREENING para INVITED — ON CONFLICT DO NOTHING preserva', async () => {
    // Pré-popula WJA em PRE_SCREENING (veio do webhook)
    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'PRE_SCREENING', 'talentum')`,
      [workerId, jobPostingId],
    );

    // Re-sync tenta inserir INVITED — conflito ignora, PRE_SCREENING preservado
    const result = await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'talentum')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING
       RETURNING id`,
      [workerId, jobPostingId],
    );

    // Conflito detectado — nenhuma linha retornada (DO NOTHING)
    expect(result.rowCount).toBe(0);

    const { rows } = await pool.query(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, jobPostingId],
    );

    expect(rows).toHaveLength(1);
    // Stage permanece PRE_SCREENING — sync não regrediu
    expect(rows[0].application_funnel_stage).toBe('PRE_SCREENING');
  });

  // ═══════════════════════════════════════════════════════════════
  // S4 — Schema: INSERT sem application_funnel_stage falha com NOT NULL
  //
  // Migration 187 removeu o DEFAULT e forçou NOT NULL.
  // Qualquer INSERT que omita o stage deve falhar com código 23502.
  // ═══════════════════════════════════════════════════════════════

  it('[S4] INSERT sem application_funnel_stage viola NOT NULL constraint (migration 187)', async () => {
    await expect(
      pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, source)
         VALUES ($1, $2, 'manual')`,
        [workerId, jobPostingId],
      ),
    ).rejects.toMatchObject({ code: '23502' }); // not_null_violation
  });
});
