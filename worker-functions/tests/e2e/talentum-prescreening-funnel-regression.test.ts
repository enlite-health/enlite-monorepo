/**
 * talentum-prescreening-funnel-regression.test.ts
 *
 * Regressões out-of-order para o bug #4.
 * Todos os testes marcados com "BUG esperado" DEVEM FALHAR até o fix.
 *
 * Casos cobertos:
 *   D — ANALYZED+QUALIFIED chega antes de INITIATED → INITIATED tardio regride WJA
 *   E — COMPLETED chega antes de IN_PROGRESS → IN_PROGRESS tardio regride WJA
 *   #6 — QUALIFIED + IN_PROGRESS tardio → deve manter QUALIFIED (FAIL esperado)
 *   #7 — NOT_QUALIFIED + COMPLETED tardio → deve manter NOT_QUALIFIED (FAIL esperado)
 */

import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope, type ResponseBlock } from '../fixtures/talentumPayload';

type AnalyzedResponseBlock = ResponseBlock & {
  score: number;
  statusLabel: 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT' | 'PENDING';
};

// ─────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const ENDPOINT = '/api/webhooks/talentum/prescreening';

const PSC_EXT_ID_D  = 'funnel-reg-d-psc-001';
const PSC_EXT_ID_E  = 'funnel-reg-e-psc-001';
const PSC_EXT_ID_F6 = 'funnel-reg-f6-psc-001';
const PSC_EXT_ID_F7 = 'funnel-reg-f7-psc-001';

const PROFILE_ID_D  = 'funnel-reg-d-prof-001';
const PROFILE_ID_E  = 'funnel-reg-e-prof-001';
const PROFILE_ID_F6 = 'funnel-reg-f6-prof-001';
const PROFILE_ID_F7 = 'funnel-reg-f7-prof-001';

const EMAIL_D  = 'funnel.reg.d@test.local';
const EMAIL_E  = 'funnel.reg.e@test.local';
const EMAIL_F6 = 'funnel.reg.f6@test.local';
const EMAIL_F7 = 'funnel.reg.f7@test.local';

// ─────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────

describe('BUG #4 — regressões out-of-order', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;

  let workerIdD: string;
  let jobPostingIdD: string;
  let workerIdE: string;
  let jobPostingIdE: string;
  let workerIdF6: string;
  let jobPostingIdF6: string;
  let workerIdF7: string;
  let jobPostingIdF7: string;

  const JOB_TITLE_D  = 'CASO 200 Funnel Regression D';
  const JOB_TITLE_E  = 'CASO 201 Funnel Regression E';
  const JOB_TITLE_F6 = 'CASO 202 Funnel Regression F6';
  const JOB_TITLE_F7 = 'CASO 203 Funnel Regression F7';

  const ALL_PSC_IDS = [PSC_EXT_ID_D, PSC_EXT_ID_E, PSC_EXT_ID_F6, PSC_EXT_ID_F7];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = createApiClient();
    await waitForBackend(api);

    // Limpa runs anteriores
    await pool.query(`DELETE FROM workers WHERE email = ANY($1::text[])`, [
      [EMAIL_D, EMAIL_E, EMAIL_F6, EMAIL_F7],
    ]);
    await pool.query(`DELETE FROM job_postings WHERE title = ANY($1::text[])`, [
      [JOB_TITLE_D, JOB_TITLE_E, JOB_TITLE_F6, JOB_TITLE_F7],
    ]);
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`,
      [ALL_PSC_IDS],
    );

    // Caso D
    const { rows: wD } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status)
       VALUES ($1, $2, 'INCOMPLETE_REGISTER') RETURNING id`,
      [`talentum_${PROFILE_ID_D}`, EMAIL_D],
    );
    workerIdD = wD[0].id;
    const { rows: jpD } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, status)
       VALUES ($1, 'Regression D', 'SEARCHING_REPLACEMENT') RETURNING id`,
      [JOB_TITLE_D],
    );
    jobPostingIdD = jpD[0].id;

    // Caso E
    const { rows: wE } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status)
       VALUES ($1, $2, 'INCOMPLETE_REGISTER') RETURNING id`,
      [`talentum_${PROFILE_ID_E}`, EMAIL_E],
    );
    workerIdE = wE[0].id;
    const { rows: jpE } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, status)
       VALUES ($1, 'Regression E', 'SEARCHING_REPLACEMENT') RETURNING id`,
      [JOB_TITLE_E],
    );
    jobPostingIdE = jpE[0].id;

    // Caso F6
    const { rows: wF6 } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status)
       VALUES ($1, $2, 'INCOMPLETE_REGISTER') RETURNING id`,
      [`talentum_${PROFILE_ID_F6}`, EMAIL_F6],
    );
    workerIdF6 = wF6[0].id;
    const { rows: jpF6 } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, status)
       VALUES ($1, 'Regression F6', 'SEARCHING_REPLACEMENT') RETURNING id`,
      [JOB_TITLE_F6],
    );
    jobPostingIdF6 = jpF6[0].id;

    // Caso F7
    const { rows: wF7 } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status)
       VALUES ($1, $2, 'INCOMPLETE_REGISTER') RETURNING id`,
      [`talentum_${PROFILE_ID_F7}`, EMAIL_F7],
    );
    workerIdF7 = wF7[0].id;
    const { rows: jpF7 } = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, description, status)
       VALUES ($1, 'Regression F7', 'SEARCHING_REPLACEMENT') RETURNING id`,
      [JOB_TITLE_F7],
    );
    jobPostingIdF7 = jpF7[0].id;
  });

  afterAll(async () => {
    const allWorkerIds = [workerIdD, workerIdE, workerIdF6, workerIdF7];
    const allJobIds = [jobPostingIdD, jobPostingIdE, jobPostingIdF6, jobPostingIdF7];

    await pool.query(
      `DELETE FROM worker_job_applications
       WHERE worker_id = ANY($1::uuid[]) OR job_posting_id = ANY($2::uuid[])`,
      [allWorkerIds, allJobIds],
    );
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [allWorkerIds]);
    await pool.query(
      `DELETE FROM talentum_prescreening_responses
       WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings
         WHERE talentum_prescreening_id = ANY($1::text[])
       )`,
      [ALL_PSC_IDS],
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`,
      [ALL_PSC_IDS],
    );
    await pool.query(
      `DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`,
      [allWorkerIds],
    );
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [allJobIds]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [allWorkerIds]);
    await pool.end();
  });

  afterEach(async () => {
    const allWorkerIds = [workerIdD, workerIdE, workerIdF6, workerIdF7];
    const allJobIds = [jobPostingIdD, jobPostingIdE, jobPostingIdF6, jobPostingIdF7];

    await pool.query(
      `DELETE FROM worker_job_applications
       WHERE worker_id = ANY($1::uuid[]) OR job_posting_id = ANY($2::uuid[])`,
      [allWorkerIds, allJobIds],
    );
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [allWorkerIds]);
    await pool.query(
      `DELETE FROM talentum_prescreening_responses
       WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings
         WHERE talentum_prescreening_id = ANY($1::text[])
       )`,
      [ALL_PSC_IDS],
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`,
      [ALL_PSC_IDS],
    );
    await pool.query(
      `DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`,
      [allWorkerIds],
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // TESTE D — out-of-order: ANALYZED chega antes de INITIATED
  //
  // Step 1: POST ANALYZED+QUALIFIED sem INITIATED prévio → WJA criada com QUALIFIED.
  // Step 2: POST INITIATED (fora de ordem) → BUG: regride para INITIATED.
  // Comportamento correto: stage deve permanecer QUALIFIED.
  // DEVE FALHAR enquanto o bug não for corrigido.
  // ─────────────────────────────────────────────────────────────────

  it('[BUG #4 / TESTE D] out-of-order: INITIATED tardio NÃO deve regredir WJA de QUALIFIED para INITIATED', async () => {
    const res1 = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC_EXT_ID_D, name: JOB_TITLE_D },
      profile: { id: PROFILE_ID_D, email: EMAIL_D, phoneNumber: '+5491188880001', cuil: '20-88880001-1' },
      response: { id: 'reg-d-analyzed', state: [], score: 85, statusLabel: 'QUALIFIED' } as AnalyzedResponseBlock,
    }));
    expect(res1.status).toBe(200);
    expect(res1.data.workerId).toBe(workerIdD);
    expect(res1.data.jobPostingId).toBe(jobPostingIdD);

    const { rows: r1 } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerIdD, jobPostingIdD],
    );
    expect(r1).toHaveLength(1);
    expect(r1[0].application_funnel_stage).toBe('QUALIFIED');

    // INITIATED chega fora de ordem (atrasado)
    const res2 = await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: PSC_EXT_ID_D, name: JOB_TITLE_D },
      profile: { id: PROFILE_ID_D, email: EMAIL_D, phoneNumber: '+5491188880001', cuil: '20-88880001-1' },
    }));
    expect(res2.status).toBe(200);

    const { rows: r2 } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerIdD, jobPostingIdD],
    );
    expect(r2).toHaveLength(1);
    // BUG #4: UPSERT sobrescreve QUALIFIED com INITIATED — DEVE FALHAR sem fix.
    expect(r2[0].application_funnel_stage).toBe('QUALIFIED');
  });

  // ─────────────────────────────────────────────────────────────────
  // TESTE E — out-of-order: IN_PROGRESS chega depois de COMPLETED
  //
  // Step 1: POST COMPLETED → WJA criada com COMPLETED.
  // Step 2: POST IN_PROGRESS (fora de ordem) → BUG: regride para IN_PROGRESS.
  // Comportamento correto: stage deve permanecer COMPLETED.
  // DEVE FALHAR enquanto o bug não for corrigido.
  // ─────────────────────────────────────────────────────────────────

  it('[BUG #4 / TESTE E] out-of-order: IN_PROGRESS tardio NÃO deve regredir WJA de COMPLETED para IN_PROGRESS', async () => {
    const res1 = await api.post(ENDPOINT, envelope({
      subtype: 'COMPLETED',
      prescreening: { id: PSC_EXT_ID_E, name: JOB_TITLE_E },
      profile: { id: PROFILE_ID_E, email: EMAIL_E, phoneNumber: '+5491177770001', cuil: '20-77770001-1' },
    }));
    expect(res1.status).toBe(200);
    expect(res1.data.workerId).toBe(workerIdE);
    expect(res1.data.jobPostingId).toBe(jobPostingIdE);

    const { rows: r1 } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerIdE, jobPostingIdE],
    );
    expect(r1).toHaveLength(1);
    expect(r1[0].application_funnel_stage).toBe('COMPLETED');

    // IN_PROGRESS chega fora de ordem (atrasado)
    const res2 = await api.post(ENDPOINT, envelope({
      subtype: 'IN_PROGRESS',
      prescreening: { id: PSC_EXT_ID_E, name: JOB_TITLE_E },
      profile: { id: PROFILE_ID_E, email: EMAIL_E, phoneNumber: '+5491177770001', cuil: '20-77770001-1' },
    }));
    expect(res2.status).toBe(200);

    const { rows: r2 } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerIdE, jobPostingIdE],
    );
    expect(r2).toHaveLength(1);
    // BUG #4: UPSERT sobrescreve COMPLETED com IN_PROGRESS — DEVE FALHAR sem fix.
    expect(r2[0].application_funnel_stage).toBe('COMPLETED');
  });

  // ─────────────────────────────────────────────────────────────────
  // TESTE #6 — QUALIFIED + IN_PROGRESS tardio → deve manter QUALIFIED
  //
  // Stage order: INITIATED < IN_PROGRESS < COMPLETED < ANALYZED variants.
  // IN_PROGRESS é anterior a QUALIFIED na ordem lógica do funil.
  // Se chegar depois, deve ser ignorado: WJA permanece em QUALIFIED.
  // DEVE FALHAR enquanto o bug não for corrigido.
  // ─────────────────────────────────────────────────────────────────

  it('[BUG #4 / TESTE #6] QUALIFIED + IN_PROGRESS tardio NÃO deve regredir WJA para IN_PROGRESS', async () => {
    // Step 1: ANALYZED+QUALIFIED estabelece WJA em QUALIFIED
    const res1 = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC_EXT_ID_F6, name: JOB_TITLE_F6 },
      profile: { id: PROFILE_ID_F6, email: EMAIL_F6, phoneNumber: '+5491155550001', cuil: '20-55550001-1' },
      response: { id: 'reg-f6-analyzed', state: [], score: 88, statusLabel: 'QUALIFIED' } as AnalyzedResponseBlock,
    }));
    expect(res1.status).toBe(200);

    const { rows: r1 } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerIdF6, jobPostingIdF6],
    );
    expect(r1).toHaveLength(1);
    expect(r1[0].application_funnel_stage).toBe('QUALIFIED');

    // Step 2: IN_PROGRESS chega fora de ordem (retransimissão atrasada)
    const res2 = await api.post(ENDPOINT, envelope({
      subtype: 'IN_PROGRESS',
      prescreening: { id: PSC_EXT_ID_F6, name: JOB_TITLE_F6 },
      profile: { id: PROFILE_ID_F6, email: EMAIL_F6, phoneNumber: '+5491155550001', cuil: '20-55550001-1' },
    }));
    expect(res2.status).toBe(200);

    const { rows: r2 } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerIdF6, jobPostingIdF6],
    );
    expect(r2).toHaveLength(1);
    // BUG #4: UPSERT sobrescreve QUALIFIED com IN_PROGRESS — DEVE FALHAR sem fix.
    expect(r2[0].application_funnel_stage).toBe('QUALIFIED');
  });

  // ─────────────────────────────────────────────────────────────────
  // TESTE #7 — NOT_QUALIFIED + COMPLETED tardio → deve manter NOT_QUALIFIED
  //
  // COMPLETED é anterior a NOT_QUALIFIED na ordem do funil.
  // Se chegar depois, deve ser ignorado: WJA permanece em NOT_QUALIFIED.
  // DEVE FALHAR enquanto o bug não for corrigido.
  // ─────────────────────────────────────────────────────────────────

  it('[BUG #4 / TESTE #7] REJECTED (NOT_QUALIFIED pós-191) + COMPLETED tardio NÃO deve regredir WJA para COMPLETED', async () => {
    // F3 (mig 191): NOT_QUALIFIED do Talentum → auto-rejeição → WJA gravada como REJECTED.
    // Step 1: ANALYZED+NOT_QUALIFIED estabelece WJA em REJECTED (comportamento pós-migration 191).
    const res1 = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC_EXT_ID_F7, name: JOB_TITLE_F7 },
      profile: { id: PROFILE_ID_F7, email: EMAIL_F7, phoneNumber: '+5491144440001', cuil: '20-44440001-1' },
      response: { id: 'reg-f7-analyzed', state: [], score: 42, statusLabel: 'NOT_QUALIFIED' } as AnalyzedResponseBlock,
    }));
    expect(res1.status).toBe(200);

    const { rows: r1 } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerIdF7, jobPostingIdF7],
    );
    expect(r1).toHaveLength(1);
    // Pós-migration 191: NOT_QUALIFIED é convertido para REJECTED
    expect(r1[0].application_funnel_stage).toBe('REJECTED');

    // Step 2: COMPLETED chega fora de ordem (retransmissão atrasada)
    const res2 = await api.post(ENDPOINT, envelope({
      subtype: 'COMPLETED',
      prescreening: { id: PSC_EXT_ID_F7, name: JOB_TITLE_F7 },
      profile: { id: PROFILE_ID_F7, email: EMAIL_F7, phoneNumber: '+5491144440001', cuil: '20-44440001-1' },
    }));
    expect(res2.status).toBe(200);

    const { rows: r2 } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerIdF7, jobPostingIdF7],
    );
    expect(r2).toHaveLength(1);
    // O guard out-of-order deve impedir que COMPLETED regride REJECTED → COMPLETED.
    expect(r2[0].application_funnel_stage).toBe('REJECTED');
  });
});
