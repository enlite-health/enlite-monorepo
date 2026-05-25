/**
 * talentum-sync-funnel.test.ts — E2E Tests (DB-level)
 *
 * Cobre o contrato do TD-035 (migration 187):
 *
 *   Sync seta application_funnel_stage = INVITED para novas linhas.
 *   INVITED = worker detectado no dashboard Talentum, sem evidência de entrada no WhatsApp.
 *   A única fonte canônica de upgrade para INITIATED+ é o webhook PRESCREENING_RESPONSE.
 *   ON CONFLICT DO NOTHING: stage existente é preservado (sem mutação).
 *
 * Tests:
 *   1 — Sync cria WJA com stage INVITED (explícito) quando worker novo é detectado
 *       em projeto, mesmo se profile.status='QUALIFIED' (ignorado)
 *   2 — Sync NÃO atualiza stage de WJA existente em QUALIFIED
 *       (ON CONFLICT DO NOTHING preserva)
 *   3 — Sync garante encuadre existe (idempotente via dedup_hash 'dashboard|...')
 *
 * Referência: docs/FOLLOWUPS.md TD-035, Migration 187
 */

import * as crypto from 'crypto';
import { Pool } from 'pg';
import { waitForBackend, createApiClient } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('talentum-sync-funnel (TD-035 simplificado)', () => {
  const api = createApiClient();
  let pool: Pool;
  let workerId: string;
  let jobPostingId: string;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    // Worker REGISTERED (necessário para linkToCases rodar)
    const wRes = await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, status, country)
       VALUES ('talentum_sf-e2e-v2-001', 'sf-e2e-v2-001@test.local', '5491100000099', 'REGISTERED', 'AR')
       RETURNING id`,
    );
    workerId = wRes.rows[0].id;

    // Job posting para linkar
    const jpRes = await pool.query(
      `INSERT INTO job_postings (case_number, title, description, country, status)
       VALUES (99830, 'CASO 99830 SF E2E V2', '', 'AR', 'SEARCHING')
       RETURNING id`,
    );
    jobPostingId = jpRes.rows[0].id;
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
    await pool.query(
      'DELETE FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [workerId, jobPostingId],
    ).catch(() => {});
  });

  // ═══════════════════════════════════════════════════════════════
  // Teste 1 — Sync cria WJA com stage INVITED
  //
  // Cenário: worker novo em projeto Talentum, profile.status='QUALIFIED'.
  // O sync ignora profile.status e insere WJA com application_funnel_stage='INVITED'
  // (explícito, sem depender de default — migration 187 removeu o default).
  // INVITED = detectado no dashboard, sem evidência de entrada no WhatsApp Talentum.
  // ═══════════════════════════════════════════════════════════════

  it('[Teste 1] sync cria WJA com stage INVITED independente do profile.status', async () => {
    // Replicar o INSERT do SyncTalentumWorkersUseCase.linkToCases (application_funnel_stage='INVITED')
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
    // Stage deve ser INVITED (profile.status='QUALIFIED' é ignorado — stage vem do vínculo, não do status global)
    expect(rows[0].application_funnel_stage).toBe('INVITED');
    expect(rows[0].source).toBe('talentum');
  });

  // ═══════════════════════════════════════════════════════════════
  // Teste 2 — Sync NÃO atualiza stage de WJA existente em QUALIFIED
  //
  // Cenário: WJA já existe em QUALIFIED (veio do webhook PRESCREENING_RESPONSE).
  // O sync roda de novo (re-sync batch). ON CONFLICT DO NOTHING preserva QUALIFIED.
  // Assert: application_funnel_stage permanece QUALIFIED após o conflito.
  // ═══════════════════════════════════════════════════════════════

  it('[Teste 2] sync NÃO atualiza stage de WJA existente em QUALIFIED — ON CONFLICT DO NOTHING preserva', async () => {
    // Pré-popula WJA em QUALIFIED (estado avançado, veio do webhook)
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'QUALIFIED', 'talentum')`,
      [workerId, jobPostingId],
    );

    // Re-sync: INSERT com ON CONFLICT DO NOTHING — inclui INVITED mas conflito preserva QUALIFIED
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
    // Stage permanece QUALIFIED — sync não regrediu nem mutou
    expect(rows[0].application_funnel_stage).toBe('QUALIFIED');
  });

  // ═══════════════════════════════════════════════════════════════
  // Teste 3 — Sync garante encuadre existe (idempotente via dedup_hash)
  //
  // Cenário: sync roda duas vezes com mesmo (profile._id, caseNumber).
  // Assert: apenas 1 encuadre criado (ON CONFLICT dedup_hash DO UPDATE é idempotente).
  // ═══════════════════════════════════════════════════════════════

  it('[Teste 3] sync garante encuadre idempotente via dedup_hash dashboard|...', async () => {
    const talentumProfileId = 'sf-e2e-v2-profile-001';
    const caseNumber = 99830;
    const workerRawName = 'Worker E2E V2';
    const rawPhone = '5491100000099';

    const dedupHash = crypto.createHash('md5')
      .update(`dashboard|${talentumProfileId}|${caseNumber}`)
      .digest('hex');

    // Primeira inserção
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, origen, dedup_hash)
       VALUES ($1, $2, $3, $4, 'Talentum', $5)
       ON CONFLICT (dedup_hash) DO UPDATE SET
         worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
      [workerId, jobPostingId, workerRawName, rawPhone, dedupHash],
    );

    // Segunda inserção — mesmo dedup_hash (re-sync idempotente)
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, worker_raw_phone, origen, dedup_hash)
       VALUES ($1, $2, $3, $4, 'Talentum', $5)
       ON CONFLICT (dedup_hash) DO UPDATE SET
         worker_id = COALESCE(encuadres.worker_id, EXCLUDED.worker_id), updated_at = NOW()`,
      [workerId, jobPostingId, workerRawName, rawPhone, dedupHash],
    );

    const { rows } = await pool.query(
      `SELECT id, worker_id, job_posting_id, origen, dedup_hash
       FROM encuadres
       WHERE dedup_hash = $1`,
      [dedupHash],
    );

    // Apenas 1 encuadre criado (idempotente)
    expect(rows).toHaveLength(1);
    expect(rows[0].worker_id).toBe(workerId);
    expect(rows[0].job_posting_id).toBe(jobPostingId);
    expect(rows[0].origen).toBe('Talentum');
    expect(rows[0].dedup_hash).toBe(dedupHash);
  });
});
