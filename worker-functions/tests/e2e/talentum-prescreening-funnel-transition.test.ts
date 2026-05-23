/**
 * talentum-prescreening-funnel-transition.test.ts
 *
 * Regressão bug #4: WJAs presas em 'INITIATED' após ANALYZED.
 *
 * Casos cobertos:
 *   A — Caso 342: vaga SEARCHING_REPLACEMENT (bug real de produção) — FAIL esperado sem fix
 *   B — Caso 713: vaga CLOSED — FAIL esperado sem fix
 *   C — Profile ID drift (hipótese de causa raiz) — FAIL esperado sem fix
 *
 * Happy paths:
 *   #1 — INITIATED puro: WJA criada com stage=INITIATED
 *   #2 — INITIATED → IN_PROGRESS
 *   #3 — IN_PROGRESS → COMPLETED
 *   #4 — COMPLETED → ANALYZED+NOT_QUALIFIED
 *   #5 — COMPLETED → ANALYZED+IN_DOUBT
 *
 * Regressões out-of-order → talentum-prescreening-funnel-regression.test.ts
 * Edge cases e side effects → talentum-prescreening-funnel-edge-cases.test.ts
 */

import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope, type ResponseBlock } from '../fixtures/talentumPayload';

type AnalyzedResponseBlock = ResponseBlock & {
  score: number;
  statusLabel: 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT' | 'PENDING';
};

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ENDPOINT = '/api/webhooks/talentum/prescreening';

// External IDs para prescreenings (bug cases A/B/C + happy paths 1-5)
const PSC = {
  A: 'tr-casoa-psc-001', B: 'tr-casob-psc-001', C: 'tr-casoc-psc-001',
  HP1: 'tr-hp1-psc-001', HP2: 'tr-hp2-psc-001', HP3: 'tr-hp3-psc-001',
  HP4: 'tr-hp4-psc-001', HP5: 'tr-hp5-psc-001',
};
const PROF = {
  A: 'tr-casoa-prof', B: 'tr-casob-prof', C_INIT: 'tr-casoc-prof-init',
  C_ANALYZED: 'tr-casoc-prof-analyzed',
  HP1: 'tr-hp1-prof', HP2: 'tr-hp2-prof', HP3: 'tr-hp3-prof',
  HP4: 'tr-hp4-prof', HP5: 'tr-hp5-prof',
};
const EMAIL = {
  A: 'tr.casoa@test.local', B: 'tr.casob@test.local', C: 'tr.casoc@test.local',
  HP1: 'tr.hp1@test.local', HP2: 'tr.hp2@test.local', HP3: 'tr.hp3@test.local',
  HP4: 'tr.hp4@test.local', HP5: 'tr.hp5@test.local',
};
const JOB = {
  A: 'CASO 342 TR Test A', B: 'CASO 713 TR Test B', C: 'CASO 999 TR Test C',
  HP1: 'CASO 400 TR HP1', HP2: 'CASO 401 TR HP2', HP3: 'CASO 402 TR HP3',
  HP4: 'CASO 403 TR HP4', HP5: 'CASO 404 TR HP5',
};

const ALL_PSC_IDS = Object.values(PSC);
const ALL_EMAILS  = Object.values(EMAIL);
const ALL_JOBS    = Object.values(JOB);

describe('Talentum funnel — transições bug #4 + happy paths', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;

  const wid: Record<string, string> = {};
  const jid: Record<string, string> = {};

  async function cleanWjas() {
    const wids = Object.values(wid).filter(Boolean);
    const jids = Object.values(jid).filter(Boolean);
    if (!wids.length) return;
    await pool.query(
      `DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[]) OR job_posting_id = ANY($2::uuid[])`,
      [wids, jids],
    );
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [wids]);
    await pool.query(
      `DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[]))`,
      [ALL_PSC_IDS],
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`,
      [ALL_PSC_IDS],
    );
    await pool.query(`DELETE FROM workers WHERE auth_uid = $1`, [`talentum_${PROF.C_ANALYZED}`]);
    await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`, [wids]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = createApiClient();
    await waitForBackend(api);

    await pool.query(`DELETE FROM workers WHERE email = ANY($1::text[])`, [ALL_EMAILS]);
    await pool.query(`DELETE FROM job_postings WHERE title = ANY($1::text[])`, [ALL_JOBS]);
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id = ANY($1::text[])`,
      [ALL_PSC_IDS],
    );

    const mkW = async (profId: string, email: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, status) VALUES ($1, $2, 'INCOMPLETE_REGISTER') RETURNING id`,
        [`talentum_${profId}`, email],
      );
      return rows[0].id;
    };
    const mkJ = async (title: string, status = 'SEARCHING_REPLACEMENT') => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, description, status) VALUES ($1, 'test', $2) RETURNING id`,
        [title, status],
      );
      return rows[0].id;
    };

    wid.A  = await mkW(PROF.A, EMAIL.A);  jid.A  = await mkJ(JOB.A, 'SEARCHING_REPLACEMENT');
    wid.B  = await mkW(PROF.B, EMAIL.B);  jid.B  = await mkJ(JOB.B, 'CLOSED');
    wid.C  = await mkW(PROF.C_INIT, EMAIL.C); jid.C = await mkJ(JOB.C);
    wid.HP1 = await mkW(PROF.HP1, EMAIL.HP1); jid.HP1 = await mkJ(JOB.HP1);
    wid.HP2 = await mkW(PROF.HP2, EMAIL.HP2); jid.HP2 = await mkJ(JOB.HP2);
    wid.HP3 = await mkW(PROF.HP3, EMAIL.HP3); jid.HP3 = await mkJ(JOB.HP3);
    wid.HP4 = await mkW(PROF.HP4, EMAIL.HP4); jid.HP4 = await mkJ(JOB.HP4);
    wid.HP5 = await mkW(PROF.HP5, EMAIL.HP5); jid.HP5 = await mkJ(JOB.HP5);
  });

  afterEach(cleanWjas);

  afterAll(async () => {
    await cleanWjas();
    const wids = Object.values(wid).filter(Boolean);
    const jids = Object.values(jid).filter(Boolean);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [jids]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [wids]);
    await pool.end();
  });

  // ── Bug #4 regressions ───────────────────────────────────────────

  it('[A] caso 342 (SEARCHING_REPLACEMENT): ANALYZED+QUALIFIED promove INITIATED → QUALIFIED', async () => {
    await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: PSC.A, name: JOB.A },
      profile: { id: PROF.A, email: EMAIL.A, phoneNumber: '+5491133420001', cuil: '20-33420001-1' },
    }));

    const res = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC.A, name: JOB.A },
      profile: { id: PROF.A, email: EMAIL.A, phoneNumber: '+5491133420001', cuil: '20-33420001-1' },
      response: { id: 'bug4-342-analyzed', state: [], score: 85, statusLabel: 'QUALIFIED' } as AnalyzedResponseBlock,
    }));
    expect(res.status).toBe(200);
    expect(res.data.workerId).toBe(wid.A);
    expect(res.data.jobPostingId).toBe(jid.A);

    const { rows } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.A, jid.A],
    );
    expect(rows).toHaveLength(1);
    // BUG #4: produção mostra 'INITIATED' — DEVE FALHAR sem fix.
    expect(rows[0].application_funnel_stage).toBe('QUALIFIED');
  });

  it('[B] caso 713 (CLOSED): ANALYZED+QUALIFIED promove INITIATED → QUALIFIED', async () => {
    await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: PSC.B, name: JOB.B },
      profile: { id: PROF.B, email: EMAIL.B, phoneNumber: '+5491171300001', cuil: '20-71300001-1' },
    }));

    const res = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC.B, name: JOB.B },
      profile: { id: PROF.B, email: EMAIL.B, phoneNumber: '+5491171300001', cuil: '20-71300001-1' },
      response: { id: 'bug4-713-analyzed', state: [], score: 72, statusLabel: 'QUALIFIED' } as AnalyzedResponseBlock,
    }));
    expect(res.status).toBe(200);

    const { rows } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.B, jid.B],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('QUALIFIED');
  });

  it('[C] profile_id drift: ANALYZED com profile_id diferente NÃO deve deixar WJA presa em INITIATED', async () => {
    await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: PSC.C, name: JOB.C },
      profile: { id: PROF.C_INIT, email: EMAIL.C, phoneNumber: '+5491199900001', cuil: '20-99900001-1' },
    }));

    const res = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC.C, name: JOB.C },
      profile: { id: PROF.C_ANALYZED, email: EMAIL.C, phoneNumber: '+5491199900001', cuil: '20-99900001-1' },
      response: { id: 'bug4-casoc-analyzed', state: [], score: 90, statusLabel: 'QUALIFIED' } as AnalyzedResponseBlock,
    }));
    expect(res.status).toBe(200);

    const { rows } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.C, jid.C],
    );
    expect(rows).toHaveLength(1);
    // BUG #4: drift cria nova prescreening row com nulls → guard skipou → FAIL.
    expect(rows[0].application_funnel_stage).toBe('QUALIFIED');
  });

  // ── Happy paths ──────────────────────────────────────────────────

  it('[#1 happy] INITIATED → WJA criada com stage=INITIATED', async () => {
    const res = await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: PSC.HP1, name: JOB.HP1 },
      profile: { id: PROF.HP1, email: EMAIL.HP1, phoneNumber: '+5491140000001', cuil: '20-40000001-1' },
    }));
    expect(res.status).toBe(200);
    expect(res.data.workerId).toBe(wid.HP1);
    expect(res.data.jobPostingId).toBe(jid.HP1);

    const { rows } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.HP1, jid.HP1],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('INITIATED');
  });

  it('[#2 happy] INITIATED → IN_PROGRESS: WJA avança para IN_PROGRESS', async () => {
    await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED', prescreening: { id: PSC.HP2, name: JOB.HP2 },
      profile: { id: PROF.HP2, email: EMAIL.HP2, phoneNumber: '+5491141000001', cuil: '20-41000001-1' },
    }));
    await api.post(ENDPOINT, envelope({
      subtype: 'IN_PROGRESS', prescreening: { id: PSC.HP2, name: JOB.HP2 },
      profile: { id: PROF.HP2, email: EMAIL.HP2, phoneNumber: '+5491141000001', cuil: '20-41000001-1' },
    }));

    const { rows } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.HP2, jid.HP2],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('IN_PROGRESS');
  });

  it('[#3 happy] IN_PROGRESS → COMPLETED: WJA avança para COMPLETED', async () => {
    await api.post(ENDPOINT, envelope({
      subtype: 'IN_PROGRESS', prescreening: { id: PSC.HP3, name: JOB.HP3 },
      profile: { id: PROF.HP3, email: EMAIL.HP3, phoneNumber: '+5491142000001', cuil: '20-42000001-1' },
    }));
    await api.post(ENDPOINT, envelope({
      subtype: 'COMPLETED', prescreening: { id: PSC.HP3, name: JOB.HP3 },
      profile: { id: PROF.HP3, email: EMAIL.HP3, phoneNumber: '+5491142000001', cuil: '20-42000001-1' },
    }));

    const { rows } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.HP3, jid.HP3],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('COMPLETED');
  });

  it('[#4 happy] COMPLETED → ANALYZED+NOT_QUALIFIED: WJA finaliza em NOT_QUALIFIED', async () => {
    await api.post(ENDPOINT, envelope({
      subtype: 'COMPLETED', prescreening: { id: PSC.HP4, name: JOB.HP4 },
      profile: { id: PROF.HP4, email: EMAIL.HP4, phoneNumber: '+5491143000001', cuil: '20-43000001-1' },
    }));
    await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED', prescreening: { id: PSC.HP4, name: JOB.HP4 },
      profile: { id: PROF.HP4, email: EMAIL.HP4, phoneNumber: '+5491143000001', cuil: '20-43000001-1' },
      response: { id: 'hp4-analyzed', state: [], score: 35, statusLabel: 'NOT_QUALIFIED' } as AnalyzedResponseBlock,
    }));

    const { rows } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.HP4, jid.HP4],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('NOT_QUALIFIED');
  });

  it('[#5 happy] COMPLETED → ANALYZED+IN_DOUBT: WJA finaliza em IN_DOUBT', async () => {
    await api.post(ENDPOINT, envelope({
      subtype: 'COMPLETED', prescreening: { id: PSC.HP5, name: JOB.HP5 },
      profile: { id: PROF.HP5, email: EMAIL.HP5, phoneNumber: '+5491144000001', cuil: '20-44000001-1' },
    }));
    await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED', prescreening: { id: PSC.HP5, name: JOB.HP5 },
      profile: { id: PROF.HP5, email: EMAIL.HP5, phoneNumber: '+5491144000001', cuil: '20-44000001-1' },
      response: { id: 'hp5-analyzed', state: [], score: 60, statusLabel: 'IN_DOUBT' } as AnalyzedResponseBlock,
    }));

    const { rows } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.HP5, jid.HP5],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].application_funnel_stage).toBe('IN_DOUBT');
  });
});
