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
 *   7. o último passo ANTES do envio: OutboxProcessor → Routing → TwilioMessagingService →
 *      MessageTemplateRepository, tudo real contra o Postgres, cortando no cliente da Twilio.
 *
 * QUAL É A PROTEÇÃO VIVA (leia antes de mexer): o módulo `twilio` é falso NESTE arquivo
 * (nenhum SDK real no processo) e as credenciais são falsas. NÃO é o kill-switch: a linha
 * `messaging_channel_pause('whatsapp')` que o beforeAll insere não é lida por ninguém —
 * `isPaused` tem um único chamador e ele passa a constante 'periskope'. E NÃO é mais "o
 * Twilio está desconfigurado": o caso do último passo precisa de credencial presente (falsa)
 * para não abortar antes do findBySlug. O Periskope não é simulado em lugar nenhum: entra
 * como tripwire, que quebra o teste se o roteamento chegar nele.
 */
/**
 * O ÚNICO ponto de saída para a rede é o cliente da Twilio, e ele é falso aqui.
 * O teste vai até o último passo ANTES do envio — captura exatamente o payload
 * que sairia — e nada é enviado. Não há simulação de Periskope em lugar nenhum:
 * aquele caminho entra como TRIPWIRE (se alguém o alcançar, o teste quebra).
 */
const mockTwilioCreate = jest.fn();
jest.mock('twilio', () => jest.fn(() => ({ messages: { create: mockTwilioCreate } })));

import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { OutboxProcessor } from '@modules/notification/infrastructure/OutboxProcessor';
import { RoutingMessagingService } from '@modules/notification/infrastructure/RoutingMessagingService';
import { TwilioMessagingService } from '@modules/notification/infrastructure/TwilioMessagingService';
import { MessageTemplateRepository } from '@modules/notification/infrastructure/MessageTemplateRepository';
import { MessagingChannelPauseCache } from '@modules/notification/infrastructure/MessagingChannelPauseCache';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { IMessagingService } from '@modules/notification/domain/IMessagingService';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const ADMIN_UID = 'fsm-admin-uid';
const RECRUITER_UID = 'fsm-recruiter-uid';
const TEMPLATE = 'fsm_e2e_stage_notice';
const TEMPLATE_B = 'fsm_e2e_stage_notice_v2';
/** SIDs FALSOS, de propósito: nada aqui pode existir na conta real da Twilio. */
const SID_A = 'HXfakeaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SID_B = 'HXfakebbbbbbbbbbbbbbbbbbbbbbbbbbbb';
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
  let workerB = ''; let workerC = ''; let encB = ''; let encC = '';

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
    await pool.query(`INSERT INTO message_templates (slug, name, body, category, is_active, content_sid, created_at, updated_at) VALUES
      ($1, 'FSM aviso de etapa', 'Hola {{worker_name}}, tu candidatura al caso {{case_number}} avanzó.', 'UTILITY', true, $3, NOW(), NOW()),
      ($2, 'FSM aviso v2', 'Hola {{worker_name}}, novedades del caso {{case_number}}.', 'UTILITY', true, $4, NOW(), NOW()),
      ('fsm_e2e_marketing', 'FSM marketing', 'Hola', 'MARKETING', true, NULL, NOW(), NOW())
      ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body, category = EXCLUDED.category, is_active = true, content_sid = EXCLUDED.content_sid`,
      [TEMPLATE, TEMPLATE_B, SID_A, SID_B]);

    const w = async (tag: string) => (await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid, email, phone, status, country) VALUES ($1, $2, $3, 'REGISTERED', 'AR') RETURNING id`, [`fsm-uid-${tag}`, `fsm-${tag}@e2e.local`, `+549119999${{ a: '0001', o: '0002', b: '0003', c: '0004' }[tag] ?? '0009'}`])).rows[0].id;
    workerA = await w('a'); workerOptOut = await w('o'); workerB = await w('b'); workerC = await w('c');
    await pool.query(`INSERT INTO messaging_opt_out (worker_id, phone, opted_out_at) VALUES ($1, '+5491199990002', NOW())`, [workerOptOut]);
    jobA = (await pool.query<{ id: string }>(`INSERT INTO job_postings (case_number, title, status, country) VALUES ($1, $2, 'SEARCHING', 'AR') RETURNING id`, [CASE_A, `CASO ${CASE_A} FSM`])).rows[0].id;
    // encuadres + candidatura em INVITED (o card existe no Kanban)
    for (const [wid, key] of [[workerA, 'a'], [workerOptOut, 'o'], [workerB, 'b'], [workerC, 'c']] as const) {
      await pool.query(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'INVITED', 'manual') ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET application_funnel_stage = 'INVITED'`, [wid, jobA]);
      // O encuadre nasce por TRIGGER no INSERT da candidatura (trg_ensure_encuadre_on_wja_insert) — só ler.
      const e = await pool.query<{ id: string }>(`SELECT id FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2 LIMIT 1`, [wid, jobA]);
      if (key === 'a') encA = e.rows[0].id;
      else if (key === 'o') encOpt = e.rows[0].id;
      else if (key === 'b') encB = e.rows[0].id;
      else encC = e.rows[0].id;
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
    // O repositório real abre o pool do singleton; sem fechar, o jest fica pendurado.
    await DatabaseConnection.getInstance().getPool().end().catch(() => undefined);
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

  it('TROCAR a mensagem escolhida troca a que é enfileirada — a antiga não sai mais, e a já enviada não é reescrita', async () => {
    // Estado de partida: COMPLETED está com o TEMPLATE (o teste de config ligou).
    const cfg0 = await api.get('/api/admin/funnel-stage-messages', asAdmin);
    expect(cfg0.data.data.stages.find((x: { stage: string }) => x.stage === 'COMPLETED')).toMatchObject({ templateSlug: TEMPLATE, enabled: true });

    // 1) Arrasta a tarjeta do worker B → sai o TEMPLATE.
    expect((await api.put(`/api/admin/encuadres/${encB}/move`, { targetStage: 'COMPLETED' }, asAdmin)).status).toBe(200);
    await processLatestEvent('funnel_stage.completed', workerB);
    const outB = await pool.query(`SELECT template_slug FROM messaging_outbox WHERE worker_id = $1`, [workerB]);
    expect(outB.rows.map((r) => r.template_slug)).toEqual([TEMPLATE]);

    // 2) O admin TROCA a mensagem da etapa pelo painel (mesma rota que a modal usa).
    const troca = await api.put('/api/admin/funnel-stage-messages/COMPLETED', { template_slug: TEMPLATE_B, enabled: true }, asAdmin);
    expect(troca.status).toBe(200);

    // 3) Arrasta a tarjeta do worker C → tem de sair o NOVO, e só ele.
    expect((await api.put(`/api/admin/encuadres/${encC}/move`, { targetStage: 'COMPLETED' }, asAdmin)).status).toBe(200);
    await processLatestEvent('funnel_stage.completed', workerC);
    const outC = await pool.query(`SELECT template_slug, variables FROM messaging_outbox WHERE worker_id = $1`, [workerC]);
    expect(outC.rows.map((r) => r.template_slug)).toEqual([TEMPLATE_B]);
    expect(outC.rows.map((r) => r.template_slug)).not.toContain(TEMPLATE);

    // As variáveis são as do corpo do template NOVO (nome como token, caso cru).
    const vars = outC.rows[0].variables as Record<string, string>;
    expect(Object.keys(vars).sort()).toEqual(['case_number', 'worker_name']);
    expect(vars.case_number).toBe(String(CASE_A));

    // A trilha registra o slug de cada momento — e o envio de B não foi reescrito.
    expect((await logFor(workerB)).rows.map((r) => r.template_slug)).toEqual([TEMPLATE]);
    expect((await logFor(workerC)).rows.map((r) => r.template_slug)).toEqual([TEMPLATE_B]);
    expect((await pool.query(`SELECT template_slug FROM messaging_outbox WHERE worker_id = $1`, [workerB])).rows.map((r) => r.template_slug)).toEqual([TEMPLATE]);

    // 4) Desligar a etapa: a próxima ação não dispara mensagem nenhuma.
    expect((await api.put('/api/admin/funnel-stage-messages/COMPLETED', { template_slug: TEMPLATE_B, enabled: false }, asAdmin)).status).toBe(200);
    expect((await api.put(`/api/admin/encuadres/${encB}/move`, { targetStage: 'IN_DOUBT' }, asAdmin)).status).toBe(200);
    await processLatestEvent('funnel_stage.in_doubt', workerB);
    expect((await api.put(`/api/admin/encuadres/${encB}/move`, { targetStage: 'COMPLETED' }, asAdmin)).status).toBe(200);
    await processLatestEvent('funnel_stage.completed', workerB);
    expect((await pool.query(`SELECT template_slug FROM messaging_outbox WHERE worker_id = $1`, [workerB])).rows).toHaveLength(1);
    expect((await logFor(workerB)).rows.map((r) => `${r.stage}:${r.status}:${r.skip_reason ?? ''}`)).toEqual([
      'COMPLETED:queued:', 'IN_DOUBT:skipped:DISABLED', 'COMPLETED:skipped:DISABLED',
    ]);

    // Restaura o estado que os outros testes assumem.
    expect((await api.put('/api/admin/funnel-stage-messages/COMPLETED', { template_slug: TEMPLATE, enabled: true }, asAdmin)).status).toBe(200);
  });

  it('até o ÚLTIMO passo antes de sair: a corrente inteira roda de verdade e o payload que IRIA para a Twilio carrega o template ESCOLHIDO — nada é enviado', async () => {
    // A etapa está com o TEMPLATE_B? Não: o caso anterior restaurou para TEMPLATE.
    // Aqui interessa a linha que JÁ foi enfileirada com a escolha nova (worker C).
    const pend = await pool.query<{ id: string; template_slug: string }>(
      `SELECT id, template_slug FROM messaging_outbox WHERE worker_id = $1 AND status = 'pending'`, [workerC],
    );
    expect(pend.rows).toHaveLength(1);
    expect(pend.rows[0].template_slug).toBe(TEMPLATE_B);

    // O nome vai como token; para o envio chegar ao fim, o token tem de resolver.
    const kms = new KMSEncryptionService();
    await pool.query(`UPDATE workers SET first_name_encrypted = $1 WHERE id = $2`, [await kms.encrypt('Mariana'), workerC]);

    // O repositório real usa o singleton de conexão: ele lê DATABASE_URL do processo.
    process.env.DATABASE_URL = DATABASE_URL;

    // DUAS camadas para nada sair, não uma:
    //  (i)  o módulo `twilio` inteiro é falso neste arquivo — não existe SDK real no processo;
    //  (ii) as credenciais são falsas MAS PRESENTES, senão `isConfigured=false` aborta o envio
    //       na primeira linha e o teste ficaria verde sem nunca chegar no findBySlug.
    process.env.TWILIO_ACCOUNT_SID = 'ACfake0000000000000000000000000000';
    process.env.TWILIO_AUTH_TOKEN = 'fake-token-nunca-real';
    process.env.TWILIO_WHATSAPP_NUMBER = '+14155238886';
    mockTwilioCreate.mockReset();
    mockTwilioCreate.mockResolvedValue({ sid: 'SMfake123', status: 'queued' });

    // Periskope NÃO é simulado: entra como tripwire. Se o roteamento cair nele, o teste quebra.
    const periskopeTripwire: IMessagingService = {
      sendWhatsApp: async () => { throw new Error('TRIPWIRE: mensagem de etapa não pode ir para o Periskope em teste'); },
    } as unknown as IMessagingService;

    // Daqui para baixo é tudo real: repositório lendo message_templates do banco,
    // roteamento, resolução do token PII e o mapeamento posicional do corpo.
    const twilioSvc = new TwilioMessagingService(new MessageTemplateRepository(), null);
    const routing = new RoutingMessagingService(
      twilioSvc,
      periskopeTripwire,
      new MessagingChannelPauseCache(pool),
      'twilio',
    );
    await new OutboxProcessor(routing, pool).processById(pend.rows[0].id);

    // 1. Chegou ao último passo — uma vez — com o Content SID DO TEMPLATE ESCOLHIDO.
    expect(mockTwilioCreate).toHaveBeenCalledTimes(1);
    const payload = mockTwilioCreate.mock.calls[0][0];
    expect(payload.contentSid).toBe(SID_B);
    expect(payload.contentSid).not.toBe(SID_A);

    // 2. As variáveis viraram posicionais na ordem do corpo DE B ({{worker_name}}, {{case_number}}),
    //    com o token PII já resolvido — é exatamente o que a cuidadora leria.
    expect(JSON.parse(payload.contentVariables)).toEqual({ '1': 'Mariana', '2': String(CASE_A) });
    expect(payload.to).toBe('whatsapp:+5491199990004');

    // 3. Nada saiu de verdade, e por construção: SDK falso, credencial falsa, e o
    //    espelho do Chatwoot desligado (ele roda depois do create e também é outbound).
    expect(jest.isMockFunction(mockTwilioCreate)).toBe(true);
    expect(process.env.TWILIO_ACCOUNT_SID).toMatch(/^ACfake/);
    expect((twilioSvc as unknown as { chatwootClient: unknown }).chatwootClient).toBeNull();

    // 4. O outbox foi fechado com o id devolvido pelo cliente falso.
    const done = await pool.query(`SELECT status, error FROM messaging_outbox WHERE id = $1`, [pend.rows[0].id]);
    expect(done.rows[0]).toMatchObject({ status: 'sent', error: null });
  });
});
