/**
 * funnel-stage-messages.e2e.test.ts @integration — PEND-14 / DEC-12
 *
 * PONTA A PONTA contra a API real (Docker, USE_MOCK_AUTH) + Postgres real:
 * configurar a etapa pelo painel (PUT) → arrastar a tarjeta (PUT /encuadres/:id/move)
 * → evento `funnel_stage.<etapa>` em domain_events (mesma transação) →
 * `POST /api/internal/events/process` → StageMessageHandler real → outbox + trilha.
 *
 * O que prova (e as condições do lex 29/08):
 *   1. etapa ligada com template elegível → 1 linha em messaging_outbox com o template,
 *      variáveis só da allowlist, e log `queued` com o uid de QUEM MOVEU (autoria);
 *   2. mover para a MESMA etapa → nenhum evento novo (não é movimento);
 *   3. bounce (COMPLETED → IN_PROGRESS → COMPLETED em segundos) → 2ª vez é ALREADY_SENT,
 *      continua 1 outbox (C3);
 *   4. etapa sem template → log `skipped:DISABLED`, zero outbox;
 *   5. worker em opt-out → OPT_OUT, zero outbox, base do opt-out intacta (C2);
 *   6. PUT de config por recruiter → 403 (C7); template MARKETING → 400 (C5); deny-list → 400 (C6);
 *      config auditada; QUALIFIED → 409;
 *   7. canal WhatsApp pausado durante o ensaio (kill-switch) e Twilio desconfigurado: nada sai (C12).
 * Nenhuma mensagem real: outbox fica `pending`.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const ADMIN_UID = 'fsm-admin-uid';
const RECRUITER_UID = 'fsm-recruiter-uid';
const TEMPLATE = 'fsm_e2e_stage_notice';
const CASE_A = 99990; const CASE_B = 99991;

function mockToken(uid: string, role: string): string {
  return 'mock_' + Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role })).toString('base64');
}

describe('Mensagem por etapa do Kanban (PEND-14 / DEC-12) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  const asAdmin = { headers: { Authorization: `Bearer ${mockToken(ADMIN_UID, 'admin')}` } };
  const asRecruiter = { headers: { Authorization: `Bearer ${mockToken(RECRUITER_UID, 'recruiter')}` } };
  let workerA = ''; let workerOptOut = ''; let jobA = ''; let encA = ''; let encOpt = '';

  async function processLatestEvent(eventName: string, workerId: string): Promise<string | null> {
    const { rows } = await pool.query(
      `SELECT id FROM domain_events WHERE event = $1 AND payload @> $2::jsonb ORDER BY created_at DESC LIMIT 1`,
      [eventName, JSON.stringify({ workerId })],
    );
    if (rows.length === 0) return null;
    const eventId = rows[0].id as string;
    const res = await api.post('/api/internal/events/process', {
      message: { data: Buffer.from(JSON.stringify({ eventId })).toString('base64'), messageId: `fsm-${eventId}`, publishTime: new Date().toISOString() },
      subscription: 'test-sub',
    }, { headers: { 'X-Internal-Secret': INTERNAL_SECRET } });
    expect(res.status).toBe(200);
    return eventId;
  }

  const outboxFor = (workerId: string) => pool.query(`SELECT template_slug, variables, status FROM messaging_outbox WHERE worker_id = $1 AND template_slug = $2 ORDER BY created_at`, [workerId, TEMPLATE]);
  const logFor = (workerId: string) => pool.query<{ stage: string; status: string; skip_reason: string | null; actor_uid: string | null; source: string; country: string; template_slug: string | null }>(
    `SELECT stage, status, skip_reason, actor_uid, source, country, template_slug FROM funnel_stage_message_log WHERE worker_id = $1 ORDER BY created_at`, [workerId],
  );

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM job_postings WHERE case_number = ANY($1::int[])`, [[CASE_A, CASE_B]]);
    await pool.query(`DELETE FROM workers WHERE email LIKE 'fsm-%@e2e.local'`);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1::text[])`, [[ADMIN_UID, RECRUITER_UID]]);
    await pool.query(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ($1, $2, 'FSM Admin', 'admin', true, true), ($3, $4, 'FSM Recruiter', 'recruiter', true, true) ON CONFLICT (firebase_uid) DO NOTHING`, [ADMIN_UID, `${ADMIN_UID}@e2e.local`, RECRUITER_UID, `${RECRUITER_UID}@e2e.local`]);
    // C12: kill-switch do canal durante o ensaio (além do Twilio desconfigurado)
    await pool.query(`INSERT INTO messaging_channel_pause (channel, paused, paused_at, paused_by) VALUES ('whatsapp', true, NOW(), 'e2e-fsm') ON CONFLICT (channel) DO UPDATE SET paused = true, paused_at = NOW(), paused_by = 'e2e-fsm'`);
    // Template elegível (UTILITY, allowlist) + um MARKETING para o 400
    await pool.query(`INSERT INTO message_templates (slug, name, body, category, is_active, created_at, updated_at) VALUES
      ($1, 'FSM aviso de etapa', 'Hola {{worker_name}}, tu candidatura al caso {{case_number}} avanzó.', 'UTILITY', true, NOW(), NOW()),
      ('fsm_e2e_marketing', 'FSM marketing', 'Hola', 'MARKETING', true, NOW(), NOW())
      ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body, category = EXCLUDED.category, is_active = true`, [TEMPLATE]);

    const w = async (tag: string) => (await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid, email, phone, status, country) VALUES ($1, $2, $3, 'REGISTERED', 'AR') RETURNING id`, [`fsm-uid-${tag}`, `fsm-${tag}@e2e.local`, `+54911999900${tag === 'a' ? '01' : '02'}`])).rows[0].id;
    workerA = await w('a'); workerOptOut = await w('o');
    await pool.query(`INSERT INTO messaging_opt_out (worker_id, phone, opted_out_at) VALUES ($1, '+5491199990002', NOW())`, [workerOptOut]);
    jobA = (await pool.query<{ id: string }>(`INSERT INTO job_postings (case_number, title, status, country) VALUES ($1, $2, 'SEARCHING', 'AR') RETURNING id`, [CASE_A, `CASO ${CASE_A} FSM`])).rows[0].id;
    // encuadres + candidatura em INVITED (o card existe no Kanban)
    for (const [wid, key] of [[workerA, 'a'], [workerOptOut, 'o']] as const) {
      await pool.query(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'INVITED', 'manual') ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET application_funnel_stage = 'INVITED'`, [wid, jobA]);
      // O encuadre nasce por TRIGGER no INSERT da candidatura (trg_ensure_encuadre_on_wja_insert) — só ler.
      const e = await pool.query<{ id: string }>(`SELECT id FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2 LIMIT 1`, [wid, jobA]);
      if (key === 'a') encA = e.rows[0].id; else encOpt = e.rows[0].id;
    }
    // O setup do e2e trunca tabelas entre suítes e leva o seed da migration 292 junto:
    // (re)semear as 9 etapas AR (mesmo INSERT da migration) e zerar a config.
    await pool.query(`INSERT INTO funnel_stage_messages (country, stage, builtin) VALUES
      ('AR','INVITED',NULL),('AR','PRE_SCREENING',NULL),('AR','IN_PROGRESS',NULL),('AR','COMPLETED',NULL),('AR','QUALIFIED','interview_invite'),
      ('AR','IN_DOUBT',NULL),('AR','CONFIRMED',NULL),('AR','SELECTED',NULL),('AR','REJECTED',NULL)
      ON CONFLICT (country, stage) DO NOTHING`);
    await pool.query(`UPDATE funnel_stage_messages SET template_slug = NULL, enabled = false WHERE country = 'AR'`);
  });

  afterAll(async () => {
    await pool.query(`UPDATE funnel_stage_messages SET template_slug = NULL, enabled = false WHERE country = 'AR'`);
    await pool.query(`UPDATE messaging_channel_pause SET paused = false WHERE channel = 'whatsapp' AND paused_by = 'e2e-fsm'`);
    await pool.end();
  });

  it('config: recruiter → 403; QUALIFIED → 409; MARKETING → 400; deny-list → 400; admin liga COMPLETED e fica auditado', async () => {
    expect((await api.put('/api/admin/funnel-stage-messages/COMPLETED', { template_slug: TEMPLATE, enabled: true }, asRecruiter)).status).toBe(403);
    expect((await api.put('/api/admin/funnel-stage-messages/QUALIFIED', { template_slug: TEMPLATE, enabled: true }, asAdmin)).status).toBe(409);
    const mkt = await api.put('/api/admin/funnel-stage-messages/COMPLETED', { template_slug: 'fsm_e2e_marketing', enabled: true }, asAdmin);
    expect(mkt.status).toBe(400); expect(mkt.data.details.reason).toBe('CATEGORY');
    const deny = await api.put('/api/admin/funnel-stage-messages/COMPLETED', { template_slug: 'talentum_incomplete_reminder', enabled: true }, asAdmin);
    expect(deny.status).toBe(400);
    const ok = await api.put('/api/admin/funnel-stage-messages/COMPLETED', { template_slug: TEMPLATE, enabled: true }, asAdmin);
    expect(ok.status).toBe(200);
    const list = await api.get('/api/admin/funnel-stage-messages', asRecruiter);
    expect(list.status).toBe(200);
    const completed = list.data.data.stages.find((s: { stage: string }) => s.stage === 'COMPLETED');
    expect(completed).toMatchObject({ templateSlug: TEMPLATE, enabled: true, updatedBy: 'FSM Admin' });
    const audit = await pool.query(`SELECT template_slug, enabled, actor_uid FROM funnel_stage_messages_audit WHERE stage = 'COMPLETED' ORDER BY created_at DESC LIMIT 1`);
    expect(audit.rows[0]).toEqual({ template_slug: TEMPLATE, enabled: true, actor_uid: ADMIN_UID });
    const tpl = list.data.data.templates.find((x: { slug: string }) => x.slug === 'fsm_e2e_marketing');
    expect(tpl).toMatchObject({ eligible: false, reason: 'CATEGORY' });
  });

  it('mover a tarjeta para COMPLETED → evento na mesma transação → outbox com o template e log queued com quem moveu', async () => {
    const mv = await api.put(`/api/admin/encuadres/${encA}/move`, { targetStage: 'COMPLETED' }, asRecruiter);
    expect(mv.status).toBe(200);
    const stage = await pool.query(`SELECT application_funnel_stage FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`, [workerA, jobA]);
    expect(stage.rows[0].application_funnel_stage).toBe('COMPLETED');
    const eventId = await processLatestEvent('funnel_stage.completed', workerA);
    expect(eventId).not.toBeNull();
    const ev = await pool.query(`SELECT payload, status FROM domain_events WHERE id = $1`, [eventId]);
    expect(ev.rows[0].payload).toMatchObject({ workerId: workerA, jobPostingId: jobA, previousStage: 'INVITED', source: 'kanban', actorUid: RECRUITER_UID });
    expect(ev.rows[0].status).toBe('processed');

    const { rows } = await outboxFor(workerA);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    const vars = rows[0].variables as Record<string, string>;
    expect(Object.keys(vars).sort()).toEqual(['case_number', 'worker_name']);
    expect(vars.case_number).toBe(String(CASE_A));
    expect(vars.worker_name).toMatch(/^tk_/); // nome vai como TOKEN, nunca o valor
    const log = (await logFor(workerA)).rows;
    expect(log).toEqual([{ stage: 'COMPLETED', status: 'queued', skip_reason: null, actor_uid: RECRUITER_UID, source: 'kanban', country: 'AR', template_slug: TEMPLATE }]);
  });

  it('mover para a MESMA etapa → nenhum evento novo; bounce (→IN_PROGRESS→COMPLETED) → ALREADY_SENT, continua 1 outbox (lex C3)', async () => {
    const before = await pool.query(`SELECT COUNT(*)::int AS n FROM domain_events WHERE event = 'funnel_stage.completed' AND payload @> $1::jsonb`, [JSON.stringify({ workerId: workerA })]);
    expect((await api.put(`/api/admin/encuadres/${encA}/move`, { targetStage: 'COMPLETED' }, asAdmin)).status).toBe(200);
    const after = await pool.query(`SELECT COUNT(*)::int AS n FROM domain_events WHERE event = 'funnel_stage.completed' AND payload @> $1::jsonb`, [JSON.stringify({ workerId: workerA })]);
    expect(after.rows[0].n).toBe(before.rows[0].n);

    expect((await api.put(`/api/admin/encuadres/${encA}/move`, { targetStage: 'IN_PROGRESS' }, asAdmin)).status).toBe(200);
    await processLatestEvent('funnel_stage.in_progress', workerA); // etapa sem template → DISABLED
    expect((await api.put(`/api/admin/encuadres/${encA}/move`, { targetStage: 'COMPLETED' }, asAdmin)).status).toBe(200);
    await processLatestEvent('funnel_stage.completed', workerA);
    expect((await outboxFor(workerA)).rows).toHaveLength(1);
    const log = (await logFor(workerA)).rows.map((r) => `${r.stage}:${r.status}:${r.skip_reason ?? ''}`);
    expect(log).toEqual(['COMPLETED:queued:', 'IN_PROGRESS:skipped:DISABLED', 'COMPLETED:skipped:ALREADY_SENT']);
  });

  it('worker em opt-out → OPT_OUT, zero outbox, base do opt-out intacta (lex C2)', async () => {
    expect((await api.put(`/api/admin/encuadres/${encOpt}/move`, { targetStage: 'COMPLETED' }, asAdmin)).status).toBe(200);
    await processLatestEvent('funnel_stage.completed', workerOptOut);
    expect((await outboxFor(workerOptOut)).rows).toHaveLength(0);
    expect((await logFor(workerOptOut)).rows.map((r) => `${r.status}:${r.skip_reason}`)).toEqual(['skipped:OPT_OUT']);
    const oo = await pool.query(`SELECT COUNT(*)::int AS n FROM messaging_opt_out WHERE worker_id = $1 AND opted_in_at IS NULL`, [workerOptOut]);
    expect(oo.rows[0].n).toBe(1);
  });

  it('o funil da vaga expõe o último envio por pessoa (lastStageMessage) e o canal ficou pausado (C12)', async () => {
    const funnel = await api.get(`/api/admin/vacancies/${jobA}/funnel`, asAdmin);
    expect(funnel.status).toBe(200);
    const all = Object.values(funnel.data.data.stages as Record<string, Array<{ workerId: string; lastStageMessage: { stage: string; templateSlug: string } | null }>>).flat();
    const me = all.find((c) => c.workerId === workerA);
    expect(me?.lastStageMessage).toMatchObject({ stage: 'COMPLETED', templateSlug: TEMPLATE });
    const paused = await pool.query(`SELECT paused FROM messaging_channel_pause WHERE channel = 'whatsapp'`);
    expect(paused.rows[0].paused).toBe(true);
  });
});
