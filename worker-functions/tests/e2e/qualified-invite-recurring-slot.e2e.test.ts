/**
 * qualified-invite-recurring-slot.e2e.test.ts @integration — D211.4
 *
 * PONTA A PONTA contra a API real (Docker) + Postgres real: webhook da Talentum
 * (INITIATED → IN_PROGRESS → COMPLETED → ANALYZED/QUALIFIED) → domain_event
 * `funnel_stage.qualified` → `POST /api/internal/events/process` → o
 * QualifiedInterviewHandler de verdade.
 *
 * O que prova:
 *   1. Vaga só com slot RECORRENTE (segundas 08:30 AR) → outbox com as 2
 *      próximas segundas, rótulo no fuso da vaga; o ORÁCULO é o Postgres
 *      (generate_series no fuso), não o resolvedor de novo.
 *   2. Vaga sem slot nenhum → NENHUMA outbox e UMA linha em
 *      interview_invite_skips com NO_FUTURE_SLOT (antes: console.warn).
 *   3. 2º `qualified` do mesmo par → ALREADY_INVITED, continua 1 outbox (lex C1).
 *   4. Worker em opt-out → OPT_OUT e zero outbox (lex C2); DISABLED → WORKER_DISABLED (C3).
 *   5. Fixo às 11:30Z → rótulo '08:30' (fuso da vaga, não UTC).
 * Nenhuma mensagem sai: Twilio não está configurado no compose de teste — a
 * outbox fica `pending` (regra: teste nunca toca canal real).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { envelope } from '../fixtures/talentumPayload';
import type { AnalyzedBlock } from './wja-full-flow-types';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const ENDPOINT = '/api/webhooks/talentum/prescreening';
const TZ = 'America/Argentina/Buenos_Aires';
const ROOM = 'https://meet.google.com/rec-urri-ngx';

const RS = {
  caseRecurring: 99970, caseNoSlot: 99971, caseFixed: 99972,
  emails: ['rs-recurring@e2e.local', 'rs-noslot@e2e.local', 'rs-optout@e2e.local', 'rs-disabled@e2e.local', 'rs-fixed@e2e.local'],
  phones: ['+5491199970001', '+5491199970002', '+5491199970003', '+5491199970004', '+5491199970005'],
};

describe('Convite de entrevista com slot RECORRENTE + pulos contáveis (D211.4) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  const workers: Record<string, string> = {};
  const jobs: Record<string, string> = {};

  async function driveToQualified(email: string, phone: string, caseNumber: number, tag: string): Promise<void> {
    for (const [subtype, suffix] of [['INITIATED', 'i'], ['IN_PROGRESS', 'p'], ['COMPLETED', 'c']] as const) {
      const res = await api.post(ENDPOINT, envelope({
        subtype,
        prescreening: { id: `rs-psc-${tag}-${suffix}`, name: `CASO ${caseNumber} RS E2E` },
        profile: { id: `rs-prof-${tag}`, email, phoneNumber: phone },
      }));
      expect(res.status).toBe(200);
    }
    const res = await api.post(ENDPOINT, envelope({
      subtype: 'ANALYZED',
      prescreening: { id: `rs-psc-${tag}-q`, name: `CASO ${caseNumber} RS E2E` },
      profile: { id: `rs-prof-${tag}`, email, phoneNumber: phone },
      response: { id: `rs-resp-${tag}`, state: [], score: 90, statusLabel: 'QUALIFIED' } as AnalyzedBlock,
    }));
    expect(res.status).toBe(200);
  }

  async function processLatestQualifiedEvent(workerId: string): Promise<string> {
    const { rows } = await pool.query(
      `SELECT id FROM domain_events WHERE event = 'funnel_stage.qualified' AND payload @> $1::jsonb ORDER BY created_at DESC LIMIT 1`,
      [JSON.stringify({ workerId })],
    );
    expect(rows).toHaveLength(1);
    const eventId = rows[0].id as string;
    const res = await api.post('/api/internal/events/process', {
      message: { data: Buffer.from(JSON.stringify({ eventId })).toString('base64'), messageId: `rs-${eventId}`, publishTime: new Date().toISOString() },
      subscription: 'test-sub',
    }, { headers: { 'X-Internal-Secret': INTERNAL_SECRET } });
    expect(res.status).toBe(200);
    return eventId;
  }

  async function reprocessEvent(eventId: string): Promise<void> {
    // O processor pula evento já `processed`; para simular o 2º qualified, o evento volta a pending.
    await pool.query(`UPDATE domain_events SET status = 'pending', processed_at = NULL WHERE id = $1`, [eventId]);
    const res = await api.post('/api/internal/events/process', {
      message: { data: Buffer.from(JSON.stringify({ eventId })).toString('base64'), messageId: `rs-again-${eventId}`, publishTime: new Date().toISOString() },
      subscription: 'test-sub',
    }, { headers: { 'X-Internal-Secret': INTERNAL_SECRET } });
    expect(res.status).toBe(200);
  }

  const outboxFor = (workerId: string) => pool.query(
    `SELECT variables, status FROM messaging_outbox WHERE worker_id = $1 AND template_slug = 'qualified_worker_request' ORDER BY created_at`,
    [workerId],
  );
  const skipsFor = (workerId: string) => pool.query<{ reason: string; country: string; job_posting_id: string | null }>(
    `SELECT reason, country, job_posting_id FROM interview_invite_skips WHERE worker_id = $1 ORDER BY created_at`,
    [workerId],
  );

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM job_postings WHERE case_number = ANY($1::int[])`, [[RS.caseRecurring, RS.caseNoSlot, RS.caseFixed]]);
    await pool.query(`DELETE FROM workers WHERE email = ANY($1::text[])`, [RS.emails]);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE 'rs-psc-%'`);

    for (const [i, key] of ['recurring', 'noslot', 'optout', 'disabled', 'fixed'].entries()) {
      const r = await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, phone, status, country) VALUES ($1, $2, $3, $4, 'AR') RETURNING id`,
        [`rs-uid-${key}`, RS.emails[i], RS.phones[i], key === 'disabled' ? 'DISABLED' : 'REGISTERED'],
      );
      workers[key] = r.rows[0].id;
    }
    await pool.query(`INSERT INTO messaging_opt_out (worker_id, phone, opted_out_at) VALUES ($1, $2, NOW())`, [workers.optout, RS.phones[2]]);

    const jr = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, title, status, country, timezone, meet_recurring_weekday, meet_recurring_time, meet_recurring_link)
       VALUES ($1, $2, 'SEARCHING', 'AR', $3, 1, '08:30', $4) RETURNING id`,
      [RS.caseRecurring, `CASO ${RS.caseRecurring} RS E2E`, TZ, ROOM],
    );
    jobs.recurring = jr.rows[0].id;
    const jn = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, title, status, country, timezone) VALUES ($1, $2, 'SEARCHING', 'AR', $3) RETURNING id`,
      [RS.caseNoSlot, `CASO ${RS.caseNoSlot} RS E2E`, TZ],
    );
    jobs.noslot = jn.rows[0].id;
    const jf = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, title, status, country, timezone, meet_link_1, meet_datetime_1)
       VALUES ($1, $2, 'SEARCHING', 'AR', $3, $4, '2099-08-10T11:30:00Z') RETURNING id`,
      [RS.caseFixed, `CASO ${RS.caseFixed} RS E2E`, TZ, 'https://meet.google.com/fix-edsl-otx'],
    );
    jobs.fixed = jf.rows[0].id;

    await pool.query(`
      INSERT INTO message_templates (slug, name, body, is_active, created_at, updated_at) VALUES
        ('qualified_worker_request', 'Convite Entrevista', '{{slot_1}}{{slot_2}}{{slot_3}}', true, NOW(), NOW())
      ON CONFLICT (slug) DO NOTHING`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('vaga só com recorrente (segundas 08:30 AR): outbox com as 2 próximas segundas — o oráculo é o Postgres', async () => {
    await driveToQualified(RS.emails[0], RS.phones[0], RS.caseRecurring, 'recurring');
    await processLatestQualifiedEvent(workers.recurring);

    const { rows } = await outboxFor(workers.recurring);
    expect(rows).toHaveLength(1);
    const v = rows[0].variables as Record<string, string>;
    expect(rows[0].status).toBe('pending');

    // Oráculo independente: as duas próximas segundas às 08:30 no fuso da vaga, estritamente depois de agora.
    const oracle = await pool.query<{ label: string }>(
      `SELECT 'Lun ' || to_char(d, 'DD/MM') || ' 08:30' AS label
       FROM generate_series((NOW() AT TIME ZONE $1)::date, (NOW() AT TIME ZONE $1)::date + 21, '1 day') d
       WHERE EXTRACT(DOW FROM d) = 1
         AND ((d + TIME '08:30') AT TIME ZONE $1) > NOW()
       ORDER BY d LIMIT 2`,
      [TZ],
    );
    expect(oracle.rows).toHaveLength(2);
    expect(v.slot_1).toBe(oracle.rows[0].label);
    expect(v.slot_2).toBe(oracle.rows[1].label);
    expect(v.slot_3).toBe(oracle.rows[1].label); // <3 opções repetem a última
    expect(v.job_posting_id).toBe(jobs.recurring);
    expect(JSON.stringify(v)).not.toContain('meet.google.com');

    const wja = await pool.query(`SELECT interview_response FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`, [workers.recurring, jobs.recurring]);
    expect(wja.rows[0].interview_response).toBe('pending');
    expect((await skipsFor(workers.recurring)).rows).toEqual([]);
  });

  it('2º qualified do mesmo par → ALREADY_INVITED e continua 1 outbox (lex C1)', async () => {
    const { rows: ev } = await pool.query(`SELECT id FROM domain_events WHERE event = 'funnel_stage.qualified' AND payload @> $1::jsonb ORDER BY created_at DESC LIMIT 1`, [JSON.stringify({ workerId: workers.recurring })]);
    await reprocessEvent(ev[0].id as string);
    expect((await outboxFor(workers.recurring)).rows).toHaveLength(1);
    const skips = (await skipsFor(workers.recurring)).rows;
    expect(skips).toEqual([{ reason: 'ALREADY_INVITED', country: 'AR', job_posting_id: jobs.recurring }]);
  });

  it('vaga sem slot nenhum → zero outbox e NO_FUTURE_SLOT contável', async () => {
    await driveToQualified(RS.emails[1], RS.phones[1], RS.caseNoSlot, 'noslot');
    await processLatestQualifiedEvent(workers.noslot);
    expect((await outboxFor(workers.noslot)).rows).toHaveLength(0);
    expect((await skipsFor(workers.noslot)).rows).toEqual([{ reason: 'NO_FUTURE_SLOT', country: 'AR', job_posting_id: jobs.noslot }]);
  });

  it('worker em opt-out → OPT_OUT, zero outbox (lex C2 — e a base do opt-out continua intacta)', async () => {
    await driveToQualified(RS.emails[2], RS.phones[2], RS.caseRecurring, 'optout');
    await processLatestQualifiedEvent(workers.optout);
    expect((await outboxFor(workers.optout)).rows).toHaveLength(0);
    expect((await skipsFor(workers.optout)).rows).toEqual([{ reason: 'OPT_OUT', country: 'AR', job_posting_id: jobs.recurring }]);
    const oo = await pool.query(`SELECT COUNT(*)::int AS n FROM messaging_opt_out WHERE worker_id = $1 AND opted_in_at IS NULL`, [workers.optout]);
    expect(oo.rows[0].n).toBe(1);
  });

  it('worker DISABLED → WORKER_DISABLED, zero outbox (lex C3)', async () => {
    await driveToQualified(RS.emails[3], RS.phones[3], RS.caseRecurring, 'disabled');
    await processLatestQualifiedEvent(workers.disabled);
    expect((await outboxFor(workers.disabled)).rows).toHaveLength(0);
    expect((await skipsFor(workers.disabled)).rows).toEqual([{ reason: 'WORKER_DISABLED', country: 'AR', job_posting_id: jobs.recurring }]);
  });

  it('slot fixo às 11:30Z → rótulo "08:30" (fuso da vaga, não UTC)', async () => {
    await driveToQualified(RS.emails[4], RS.phones[4], RS.caseFixed, 'fixed');
    await processLatestQualifiedEvent(workers.fixed);
    const { rows } = await outboxFor(workers.fixed);
    expect(rows).toHaveLength(1);
    expect((rows[0].variables as Record<string, string>).slot_1).toBe('Lun 10/08 08:30');
  });

  it('retenção: archive_old_messages() apaga pulos antigos e preserva os recentes (lex C4)', async () => {
    await pool.query(`INSERT INTO interview_invite_skips (worker_id, job_posting_id, country, reason, created_at) VALUES ($1, $2, 'AR', 'NO_FUTURE_SLOT', NOW() - INTERVAL '200 days')`, [workers.noslot, jobs.noslot]);
    await pool.query(`SELECT archive_old_messages()`);
    const { rows } = await skipsFor(workers.noslot);
    expect(rows).toHaveLength(1); // só a linha recente do teste anterior
  });
});
