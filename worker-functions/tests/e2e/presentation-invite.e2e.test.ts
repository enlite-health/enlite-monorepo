/**
 * presentation-invite.e2e.test.ts @integration — REQ-09 (planning 26/08)
 *
 * PONTA A PONTA contra a API real (Docker, USE_MOCK_AUTH) + Postgres real:
 * admin configura (PUT) → staff clica (POST) → messaging_outbox + presentation_invite_log.
 *
 * O que prova (e as condições do lex 29/08):
 *   - PUT: recruiter 403 (C10 admin-only); link que não é sala do Meet → 400; rótulo com termo
 *     clínico → 400 (C4); template sem cláusula de saída → 400 (C3); config auditada;
 *   - ficha IMPORTADA (@enlite.import) → SIN_VINCULO, zero outbox (C1);
 *   - self-cadastro SEM aceite → SIN_VINCULO (C1); com aceite → queued com o slug e as variáveis da allowlist;
 *   - telefone +55 com country='AR' → COUNTRY_MISMATCH (C2);
 *   - 2º clique em 7 d → ALREADY_INVITED, continua 1 outbox; opt-out → OPT_OUT, base do opt-out intacta (C8);
 *   - /last e /stats devolvem contagem/último — nunca lista de OPT_OUT (C9);
 *   - canal WhatsApp pausado (kill-switch) e Twilio desconfigurado: nada sai; o template ativo aqui é
 *     um fixture do e2e (em prod o placeholder nasce INATIVO).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const ADMIN_UID = 'pi-admin-uid'; const RECRUITER_UID = 'pi-recruiter-uid';
const TEMPLATE = 'pi_e2e_invite';
const MEET = 'https://meet.google.com/abc-defg-hij';

function mockToken(uid: string, role: string): string {
  return 'mock_' + Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role })).toString('base64');
}

describe('Convite à reunión de presentación (REQ-09) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  const asAdmin = { headers: { Authorization: `Bearer ${mockToken(ADMIN_UID, 'admin')}` } };
  const asRecruiter = { headers: { Authorization: `Bearer ${mockToken(RECRUITER_UID, 'recruiter')}` } };
  let wOk = ''; let wImported = ''; let wNoAccept = ''; let wBrPhone = ''; let wOptOut = '';

  const outboxFor = (w: string) => pool.query(`SELECT template_slug, variables, status FROM messaging_outbox WHERE worker_id = $1 AND template_slug = $2`, [w, TEMPLATE]);
  const logFor = (w: string) => pool.query<{ status: string; skip_reason: string | null; actor_uid: string; source: string; country: string }>(
    `SELECT status, skip_reason, actor_uid, source, country FROM presentation_invite_log WHERE worker_id = $1 ORDER BY created_at`, [w]);
  const invite = (w: string, who = asRecruiter, source = 'workers_list') => api.post(`/api/admin/workers/${w}/presentation-invite`, { source }, who);

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM workers WHERE email LIKE 'pi-%@e2e.local' OR email LIKE 'pi-%@enlite.import'`);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1::text[])`, [[ADMIN_UID, RECRUITER_UID]]);
    await pool.query(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ($1, $2, 'PI Admin', 'admin', true, true), ($3, $4, 'PI Recruiter', 'recruiter', true, true) ON CONFLICT (firebase_uid) DO NOTHING`, [ADMIN_UID, `${ADMIN_UID}@e2e.local`, RECRUITER_UID, `${RECRUITER_UID}@e2e.local`]);
    await pool.query(`INSERT INTO messaging_channel_pause (channel, paused, paused_at, paused_by) VALUES ('whatsapp', true, NOW(), 'e2e-pi') ON CONFLICT (channel) DO UPDATE SET paused = true, paused_at = NOW(), paused_by = 'e2e-pi'`);
    await pool.query(`INSERT INTO message_templates (slug, name, body, category, is_active, created_at, updated_at) VALUES
      ($1, 'PI e2e', 'Hola {{worker_name}}, {{schedule_label}} {{meet_link}}. Respondé BAJA para no recibir más.', 'UTILITY', true, NOW(), NOW()),
      ('pi_e2e_no_baja', 'PI sem saída', 'Hola {{worker_name}} {{meet_link}}', 'UTILITY', true, NOW(), NOW())
      ON CONFLICT (slug) DO UPDATE SET body = EXCLUDED.body, category = EXCLUDED.category, is_active = true`, [TEMPLATE]);
    // O setup do e2e trunca tabelas entre suítes (CASCADE) — re-semear a config da migration 293.
    await pool.query(`INSERT INTO presentation_invite_settings (country, enabled) VALUES ('AR', false) ON CONFLICT (country) DO NOTHING`);
    await pool.query(`UPDATE presentation_invite_settings SET template_slug = NULL, meet_link = NULL, schedule_label = NULL, enabled = false WHERE country = 'AR'`);

    const w = async (tag: string, o: { email?: string; auth?: string; phone?: string; accepted?: boolean }) =>
      (await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, phone, status, country, privacy_accepted_at) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', $4) RETURNING id`,
        [o.auth ?? `pi-uid-${tag}`, o.email ?? `pi-${tag}@e2e.local`, o.phone ?? `+54911777700${tag.length}${tag.charCodeAt(0) % 10}`, o.accepted === false ? null : new Date()],
      )).rows[0].id;
    wOk = await w('ok', {});
    wImported = await w('imp', { email: 'pi-imp@enlite.import', auth: 'base1import_pi_imp' });
    wNoAccept = await w('noacc', { accepted: false });
    wBrPhone = await w('br', { phone: '+5511999990001' });
    wOptOut = await w('opt', {});
    await pool.query(`INSERT INTO messaging_opt_out (worker_id, phone, opted_out_at) VALUES ($1, '+5491177770001', NOW())`, [wOptOut]);
  });

  afterAll(async () => {
    await pool.query(`UPDATE presentation_invite_settings SET template_slug = NULL, meet_link = NULL, schedule_label = NULL, enabled = false WHERE country = 'AR'`);
    await pool.query(`UPDATE messaging_channel_pause SET paused = false WHERE channel = 'whatsapp' AND paused_by = 'e2e-pi'`);
    await pool.end();
  });

  it('config: recruiter → 403; link não-Meet → 400; rótulo clínico → 400 (C4); template sem BAJA → 400 (C3); admin liga e fica auditado', async () => {
    const good = { template_slug: TEMPLATE, meet_link: MEET, schedule_label: 'Martes 18:00 (Buenos Aires)', enabled: true };
    expect((await api.put('/api/admin/presentation-invite/settings', good, asRecruiter)).status).toBe(403);
    expect((await api.put('/api/admin/presentation-invite/settings', { ...good, meet_link: 'https://zoom.us/j/123' }, asAdmin)).status).toBe(400);
    const denied = await api.put('/api/admin/presentation-invite/settings', { ...good, schedule_label: 'Martes, medicación del paciente' }, asAdmin);
    expect(denied.status).toBe(400); expect(denied.data.details).toEqual({ reason: 'SCHEDULE_LABEL_DENIED', term: 'paciente' });
    // rótulo ausente com template que usa {{schedule_label}} e enabled → 400 (nunca variável vazia na Twilio)
    const noLabel = await api.put('/api/admin/presentation-invite/settings', { ...good, schedule_label: null }, asAdmin);
    expect(noLabel.status).toBe(400); expect(noLabel.data.details.reason).toBe('SCHEDULE_LABEL_REQUIRED');
    const noBaja = await api.put('/api/admin/presentation-invite/settings', { ...good, template_slug: 'pi_e2e_no_baja' }, asAdmin);
    expect(noBaja.status).toBe(400); expect(noBaja.data.details.reason).toBe('OPT_OUT_CLAUSE');
    expect((await api.put('/api/admin/presentation-invite/settings', good, asAdmin)).status).toBe(200);
    const got = await api.get('/api/admin/presentation-invite/settings', asRecruiter);
    expect(got.status).toBe(200);
    expect(got.data.data).toMatchObject({ templateSlug: TEMPLATE, meetLink: MEET, enabled: true, updatedBy: 'PI Admin' });
    expect(got.data.data.templates.find((t: { slug: string }) => t.slug === 'pi_e2e_no_baja')).toMatchObject({ eligible: false, reason: 'OPT_OUT_CLAUSE' });
    const audit = await pool.query(`SELECT template_slug, enabled, actor_uid FROM presentation_invite_settings_audit ORDER BY created_at DESC LIMIT 1`);
    expect(audit.rows[0]).toEqual({ template_slug: TEMPLATE, enabled: true, actor_uid: ADMIN_UID });
  });

  it('ficha importada → SIN_VINCULO; self-cadastro sem aceite → SIN_VINCULO; telefone +55 → COUNTRY_MISMATCH — zero outbox (lex C1/C2)', async () => {
    for (const [w, reason] of [[wImported, 'SIN_VINCULO'], [wNoAccept, 'SIN_VINCULO'], [wBrPhone, 'COUNTRY_MISMATCH']] as const) {
      const r = await invite(w);
      expect(r.status).toBe(200); expect(r.data.data).toEqual({ status: 'skipped', skipReason: reason });
      expect((await outboxFor(w)).rows).toHaveLength(0);
      expect((await logFor(w)).rows[0]).toMatchObject({ status: 'skipped', skip_reason: reason, actor_uid: RECRUITER_UID, source: 'workers_list', country: 'AR' });
    }
  });

  it('clique do staff → 202 queued: outbox pending com o slug e as variáveis da allowlist (nome como TOKEN), log com autoria; 2º clique → ALREADY_INVITED', async () => {
    const r = await invite(wOk, asRecruiter, 'kanban');
    expect(r.status).toBe(202); expect(r.data.data.status).toBe('queued');
    const ob = (await outboxFor(wOk)).rows;
    expect(ob).toHaveLength(1); expect(ob[0].status).toBe('pending');
    const vars = ob[0].variables as Record<string, string>;
    expect(Object.keys(vars).sort()).toEqual(['meet_link', 'schedule_label', 'worker_name']);
    expect(vars.meet_link).toBe(MEET); expect(vars.worker_name).not.toMatch(/pi-ok/); expect(vars.worker_name).toMatch(/^tk_|^tok_|^\{/);
    expect((await logFor(wOk)).rows[0]).toMatchObject({ status: 'queued', actor_uid: RECRUITER_UID, source: 'kanban' });
    const again = await invite(wOk, asAdmin);
    expect(again.status).toBe(200); expect(again.data.data).toEqual({ status: 'skipped', skipReason: 'ALREADY_INVITED' });
    expect((await outboxFor(wOk)).rows).toHaveLength(1);
  });

  it('opt-out → OPT_OUT, zero outbox, messaging_opt_out intacta (lex C8)', async () => {
    const r = await invite(wOptOut);
    expect(r.data.data).toEqual({ status: 'skipped', skipReason: 'OPT_OUT' });
    expect((await outboxFor(wOptOut)).rows).toHaveLength(0);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM messaging_opt_out WHERE worker_id = $1 AND opted_in_at IS NULL`, [wOptOut])).rows[0].n).toBe(1);
  });

  it('/last devolve o último convite ENFILEIRADO por pessoa; /stats devolve só contagem; canal seguiu pausado (C9/C12)', async () => {
    const last = await api.get(`/api/admin/presentation-invite/last?workerIds=${wOk},${wOptOut},${wImported}`, asRecruiter);
    expect(last.status).toBe(200);
    expect(Object.keys(last.data.data)).toEqual([wOk]);
    expect(last.data.data[wOk].by).toBe('PI Recruiter');
    const stats = await api.get('/api/admin/presentation-invite/stats', asRecruiter);
    expect(stats.status).toBe(200);
    const rows = stats.data.data.rows as Array<{ status: string; skipReason: string | null; source: string; count: number }>;
    expect(rows.find((r) => r.status === 'queued' && r.source === 'kanban')?.count).toBeGreaterThanOrEqual(1);
    expect(rows.find((r) => r.skipReason === 'OPT_OUT')?.count).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(stats.data.data)).not.toContain(wOptOut);
    expect(stats.data.data.attended).toBe(0);
    expect((await pool.query(`SELECT paused FROM messaging_channel_pause WHERE channel = 'whatsapp'`)).rows[0].paused).toBe(true);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM messaging_outbox WHERE template_slug = $1 AND status <> 'pending'`, [TEMPLATE])).rows[0].n).toBe(0);
  });
});
