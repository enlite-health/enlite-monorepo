/**
 * talentum-prescreening-funnel-edge-cases.test.ts
 *
 * Edge cases, side effects e idempotência do webhook Talentum.
 *
 *   #8  — ANALYZED+NOT_QUALIFIED dispara encuadre.resultado='RECHAZADO'
 *   #9  — Idempotência: INITIATED 2x → 1 prescreening, 1 WJA
 *   #10 — Email órfão: worker auto-criado com auth_uid='talentum_{profile_id}'
 *   #11 — Prescreening name órfã: jobPostingId=null, WJA não criada
 *   #12 — ANALYZED sem statusLabel: funnelStage='ANALYZED' → WJA não criada
 *   #13 — ANALYZED+QUALIFIED dispara domain_event 'funnel_stage.qualified'
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

const PROF = {
  P8: 'edge-8-prof', P9: 'edge-9-prof', P10: 'edge-10-prof',
  P11: 'edge-11-prof', P12: 'edge-12-prof', P13: 'edge-13-prof',
};
const PSC = {
  P8: 'edge-8-psc', P9: 'edge-9-psc', P10: 'edge-10-psc',
  P11: 'edge-11-psc', P12: 'edge-12-psc', P13: 'edge-13-psc',
};
const EMAIL = {
  P8: 'edge.8@test.local', P9: 'edge.9@test.local',
  P10: 'edge.orphan10@test.local',  // não existe no banco antes
  P11: 'edge.11@test.local', P12: 'edge.12@test.local', P13: 'edge.13@test.local',
};
const JOB = {
  P8: 'CASO 300 Edge 8', P9: 'CASO 301 Edge 9',
  // P10: sem job_posting — usa título inexistente no teste
  P11_ORPHAN: 'CASO INEXISTENTE XYZ999 Edge 11',
  P12: 'CASO 302 Edge 12', P13: 'CASO 303 Edge 13',
};

const ALL_PSC_IDS = Object.values(PSC);
const ALL_EMAILS  = Object.values(EMAIL);

describe('Talentum webhook — edge cases e side effects', () => {
  let api: ReturnType<typeof createApiClient>;
  let pool: Pool;

  const wid: Record<string, string> = {};
  const jid: Record<string, string> = {};

  async function cleanWjas() {
    const wids = Object.values(wid).filter(Boolean);
    const jids = Object.values(jid).filter(Boolean);
    if (!wids.length) return;
    await pool.query(
      `DELETE FROM worker_job_applications WHERE worker_id=ANY($1::uuid[]) OR job_posting_id=ANY($2::uuid[])`,
      [wids, jids],
    );
    await pool.query(`DELETE FROM encuadres WHERE worker_id=ANY($1::uuid[])`, [wids]);
    await pool.query(
      `DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (
         SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id=ANY($1::text[]))`,
      [ALL_PSC_IDS],
    );
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id=ANY($1::text[])`,
      [ALL_PSC_IDS],
    );
    await pool.query(`DELETE FROM workers WHERE auth_uid=$1`, [`talentum_${PROF.P10}`]);
    await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId'=ANY($1::text[])`, [wids]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    api = createApiClient();
    await waitForBackend(api);

    await pool.query(`DELETE FROM workers WHERE email=ANY($1::text[])`, [ALL_EMAILS]);
    await pool.query(`DELETE FROM workers WHERE auth_uid=$1`, [`talentum_${PROF.P10}`]);
    await pool.query(`DELETE FROM job_postings WHERE title=ANY($1::text[])`, [
      [JOB.P8, JOB.P9, JOB.P12, JOB.P13],
    ]);
    await pool.query(
      `DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id=ANY($1::text[])`,
      [ALL_PSC_IDS],
    );

    const mkW = async (profId: string, email: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, status) VALUES ($1, $2, 'INCOMPLETE_REGISTER') RETURNING id`,
        [`talentum_${profId}`, email],
      );
      return rows[0].id;
    };
    const mkJ = async (title: string) => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, description, status) VALUES ($1, 'test', 'SEARCHING_REPLACEMENT') RETURNING id`,
        [title],
      );
      return rows[0].id;
    };

    wid.P8  = await mkW(PROF.P8, EMAIL.P8);   jid.P8  = await mkJ(JOB.P8);
    wid.P9  = await mkW(PROF.P9, EMAIL.P9);   jid.P9  = await mkJ(JOB.P9);
    wid.P11 = await mkW(PROF.P11, EMAIL.P11); // sem job_posting para P11
    wid.P12 = await mkW(PROF.P12, EMAIL.P12); jid.P12 = await mkJ(JOB.P12);
    wid.P13 = await mkW(PROF.P13, EMAIL.P13); jid.P13 = await mkJ(JOB.P13);
    // P10 não tem worker pré-criado — auto-criação é o que se testa
  });

  afterEach(cleanWjas);

  afterAll(async () => {
    await cleanWjas();
    const jids = Object.values(jid).filter(Boolean);
    const wids = Object.values(wid).filter(Boolean);
    await pool.query(`DELETE FROM job_postings WHERE id=ANY($1::uuid[])`, [jids]);
    await pool.query(`DELETE FROM workers WHERE id=ANY($1::uuid[])`, [wids]);
    await pool.end();
  });

  // ─────────────────────────────────────────────────────────────────
  // #8 — ANALYZED+NOT_QUALIFIED dispara encuadre.resultado='RECHAZADO'
  //
  // handleNotQualifiedTransition: encuadre com resultado=NULL → RECHAZADO.
  // O encuadre é criado por ensureEncuadre na mesma requisição.
  // ─────────────────────────────────────────────────────────────────

  it('[#8] ANALYZED+NOT_QUALIFIED: encuadre.resultado=RECHAZADO', async () => {
    const res = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC.P8, name: JOB.P8 },
      profile: { id: PROF.P8, email: EMAIL.P8, phoneNumber: '+5491166660001', cuil: '20-66660001-1',
        firstName: 'Ana', lastName: 'Edge8' },
      response: { id: 'edge-8-analyzed', state: [], score: 30, statusLabel: 'NOT_QUALIFIED' } as AnalyzedResponseBlock,
    }));
    expect(res.status).toBe(200);
    expect(res.data.workerId).toBe(wid.P8);
    expect(res.data.jobPostingId).toBe(jid.P8);

    const { rows } = await pool.query<{ resultado: string; rejection_reason_category: string }>(
      `SELECT resultado, rejection_reason_category FROM encuadres WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.P8, jid.P8],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].resultado).toBe('RECHAZADO');
    expect(rows[0].rejection_reason_category).toBe('TALENTUM_NOT_QUALIFIED');
  });

  // ─────────────────────────────────────────────────────────────────
  // #9 — Idempotência: INITIATED 2x → 1 prescreening, 1 WJA, sem duplicatas
  // ─────────────────────────────────────────────────────────────────

  it('[#9] idempotência: INITIATED 2x → 1 prescreening, 1 WJA', async () => {
    const p = envelope({
      subtype: 'INITIATED',
      prescreening: { id: PSC.P9, name: JOB.P9 },
      profile: { id: PROF.P9, email: EMAIL.P9, phoneNumber: '+5491122220001', cuil: '20-22220001-1' },
    });

    expect((await api.post(ENDPOINT, p)).status).toBe(200);
    expect((await api.post(ENDPOINT, p)).status).toBe(200);

    const { rows: pscs } = await pool.query(
      `SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id=$1`,
      [PSC.P9],
    );
    expect(pscs).toHaveLength(1);

    const { rows: wjas } = await pool.query(
      `SELECT id FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.P9, jid.P9],
    );
    expect(wjas).toHaveLength(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // #10 — Email órfão: worker auto-criado com auth_uid='talentum_{profile_id}'
  //
  // autoCreateWorker (linha 110): INSERT workers com auth_uid=talentum_{id},
  // status='INCOMPLETE_REGISTER'. Conflito 23505 → busca por auth_uid OR email.
  // ─────────────────────────────────────────────────────────────────

  it('[#10] email órfão: worker auto-criado com auth_uid=talentum_{profile_id}', async () => {
    const { rows: pre } = await pool.query(
      `SELECT id FROM workers WHERE email=$1 OR auth_uid=$2`,
      [EMAIL.P10, `talentum_${PROF.P10}`],
    );
    expect(pre).toHaveLength(0);

    const res = await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: PSC.P10, name: 'CASO INEXISTENTE AUTO999 Edge 10' },
      profile: { id: PROF.P10, email: EMAIL.P10, phoneNumber: '+5491111110001', cuil: '20-11110001-1' },
    }));
    expect(res.status).toBe(200);
    expect(res.data.workerId).not.toBeNull();
    expect(res.data.resolved.worker).toBe(true);

    const { rows } = await pool.query<{ auth_uid: string; status: string }>(
      `SELECT auth_uid, status FROM workers WHERE id=$1`,
      [res.data.workerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].auth_uid).toBe(`talentum_${PROF.P10}`);
    expect(rows[0].status).toBe('INCOMPLETE_REGISTER');

    // Título não casa nenhum job_posting → jobPostingId=null
    expect(res.data.jobPostingId).toBeNull();
    expect(res.data.resolved.jobPosting).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────
  // #11 — Prescreening name órfã: jobPostingId=null, WJA não criada
  //
  // resolveJobPosting → null quando findByTitleILike não acha match.
  // syncFunnelAndEncuadre: guard `!jobPostingId` → early return (linha 186).
  // ─────────────────────────────────────────────────────────────────

  it('[#11] prescreening name órfã: jobPostingId=null, WJA não criada', async () => {
    const res = await api.post(ENDPOINT, envelope({
      subtype: 'INITIATED',
      prescreening: { id: PSC.P11, name: JOB.P11_ORPHAN },
      profile: { id: PROF.P11, email: EMAIL.P11, phoneNumber: '+5491133330001', cuil: '20-33330001-1' },
    }));
    expect(res.status).toBe(200);
    expect(res.data.jobPostingId).toBeNull();
    expect(res.data.resolved.jobPosting).toBe(false);

    const { rows: pscs } = await pool.query<{ job_posting_id: string | null }>(
      `SELECT job_posting_id FROM talentum_prescreenings WHERE talentum_prescreening_id=$1`,
      [PSC.P11],
    );
    expect(pscs).toHaveLength(1);
    expect(pscs[0].job_posting_id).toBeNull();

    const { rows: wjas } = await pool.query(
      `SELECT id FROM worker_job_applications WHERE worker_id=$1`,
      [wid.P11],
    );
    expect(wjas).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────
  // #12 — ANALYZED sem statusLabel: funnelStage='ANALYZED' → WJA não criada
  //
  // deriveFunnelStage (linha 208): subtype='ANALYZED' e statusLabel ausente
  // → retorna 'ANALYZED'. syncFunnelAndEncuadre: funnelStage==='ANALYZED'
  // → skip upsert WJA (linha 194).
  // ─────────────────────────────────────────────────────────────────

  it('[#12] ANALYZED sem statusLabel: WJA não criada, prescreening.status=ANALYZED', async () => {
    const { rows: pre } = await pool.query(
      `SELECT id FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.P12, jid.P12],
    );
    expect(pre).toHaveLength(0);

    const res = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC.P12, name: JOB.P12 },
      profile: { id: PROF.P12, email: EMAIL.P12, phoneNumber: '+5491177710001', cuil: '20-77710001-1' },
      response: { id: 'edge-12-no-label', state: [] }, // sem statusLabel
    }));
    expect(res.status).toBe(200);

    const { rows: post } = await pool.query(
      `SELECT id FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.P12, jid.P12],
    );
    expect(post).toHaveLength(0);

    const { rows: pscs } = await pool.query<{ status: string }>(
      `SELECT status FROM talentum_prescreenings WHERE talentum_prescreening_id=$1`,
      [PSC.P12],
    );
    expect(pscs).toHaveLength(1);
    // effectiveStatus = payload.subtype = 'ANALYZED' (sem override por statusLabel ausente)
    expect(pscs[0].status).toBe('ANALYZED');
  });

  // ─────────────────────────────────────────────────────────────────
  // #13 — ANALYZED+QUALIFIED dispara domain_event 'funnel_stage.qualified'
  //
  // handleQualifiedTransition (linha 248): INSERT INTO domain_events quando
  // funnelStage='QUALIFIED' e previousStage !== 'QUALIFIED'.
  // Tabela domain_events confirmada em ProcessTalentumPrescreening.ts linha 253.
  // ─────────────────────────────────────────────────────────────────

  it('[#13] ANALYZED+QUALIFIED: domain_event funnel_stage.qualified inserido', async () => {
    await pool.query(
      `DELETE FROM domain_events WHERE event='funnel_stage.qualified'
         AND payload->>'workerId'=$1 AND payload->>'jobPostingId'=$2`,
      [wid.P13, jid.P13],
    );

    const res = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: PSC.P13, name: JOB.P13 },
      profile: { id: PROF.P13, email: EMAIL.P13, phoneNumber: '+5491188880013', cuil: '20-88880013-1',
        firstName: 'Lucas', lastName: 'Edge13' },
      response: { id: 'edge-13-analyzed', state: [], score: 92, statusLabel: 'QUALIFIED' } as AnalyzedResponseBlock,
    }));
    expect(res.status).toBe(200);
    expect(res.data.workerId).toBe(wid.P13);
    expect(res.data.jobPostingId).toBe(jid.P13);

    const { rows: wjas } = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`,
      [wid.P13, jid.P13],
    );
    expect(wjas).toHaveLength(1);
    expect(wjas[0].application_funnel_stage).toBe('QUALIFIED');

    const { rows: events } = await pool.query<{
      event: string;
      payload: { workerId: string; jobPostingId: string };
    }>(
      `SELECT event, payload FROM domain_events
       WHERE event='funnel_stage.qualified'
         AND payload->>'workerId'=$1 AND payload->>'jobPostingId'=$2`,
      [wid.P13, jid.P13],
    );
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('funnel_stage.qualified');
    expect(events[0].payload.workerId).toBe(wid.P13);
    expect(events[0].payload.jobPostingId).toBe(jid.P13);
  });
});
