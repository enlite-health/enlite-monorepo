/**
 * migration597.repo.test.ts — Postgres REAL contra a migration 597 (emenda 077 §5.3: `coordination_alert` + `coordination_alert_delivery`).
 * Mede ESTADO (constraints e grants vivos), não a existência do arquivo.
 *
 *   docker run -d --name pg597 -p 127.0.0.1:5461:5432 -e POSTGRES_USER=enlite_admin -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e postgis/postgis:16-3.4
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5461/enlite_e2e node scripts/run-migrations-docker.js
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5461/enlite_e2e npx jest --config jest.config.repo.js migration597 --maxWorkers=2
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5461/enlite_e2e';

describe('migration 597 — coordination_alert (Postgres real)', () => {
  let pool: Pool;
  let eventId: string;
  const alertIds: string[] = [];

  const insertAlert = async (kind: string, occurrenceId: string): Promise<string> => {
    const r = await pool.query<{ alert_id: string }>(`INSERT INTO coordination_alert (kind, occurrence_id) VALUES ($1, $2) RETURNING alert_id`, [kind, occurrenceId]);
    alertIds.push(r.rows[0].alert_id);
    return r.rows[0].alert_id;
  };
  const insertDelivery = (alertId: string, over: Partial<{ uid: string; channel: string; status: string; error: string | null; event: string | null }> = {}) =>
    pool.query(
      `INSERT INTO coordination_alert_delivery (alert_id, recipient_uid, channel, status, error_code, notification_event_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [alertId, over.uid ?? 'uid-1', over.channel ?? 'EMAIL', over.status ?? 'PENDING', over.error ?? null, over.event ?? null],
    );
  /** SQLSTATE do erro (23505 unique, 23514 check) — o teste nunca compara a mensagem (pode ecoar valor). */
  const sqlstate = async (p: Promise<unknown>): Promise<string> => ((await p.then(() => ({ code: 'OK' }), (e) => e)) as { code: string }).code;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const ev = await pool.query<{ id: string }>(`INSERT INTO notification_events (type_code, actor_uid, payload) VALUES ('PRESENCE_OPEN_4H', 'system', '{}'::jsonb) RETURNING id`);
    eventId = ev.rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM coordination_alert_delivery WHERE alert_id = ANY($1::uuid[])`, [alertIds]);
    await pool.query(`DELETE FROM coordination_alert WHERE alert_id = ANY($1::uuid[])`, [alertIds]);
    await pool.query(`DELETE FROM notification_events WHERE id = $1`, [eventId]);
    await pool.end();
  });

  it('os 2 tipos existem em notification_types', async () => {
    const r = await pool.query(`SELECT code FROM notification_types WHERE code IN ('PRESENCE_OPEN_4H','CHECK_IN_REFUSED_NO_ENTRY') ORDER BY code`);
    expect(r.rows.map((x) => x.code)).toEqual(['CHECK_IN_REFUSED_NO_ENTRY', 'PRESENCE_OPEN_4H']);
  });

  it('UNIQUE (kind, occurrence_id): o mesmo turno e a mesma regra não entram 2×; outra regra OU outro turno entram', async () => {
    const occ = randomUUID();
    await insertAlert('PRESENCE_OPEN_4H', occ);
    expect(await sqlstate(insertAlert('PRESENCE_OPEN_4H', occ))).toBe('23505');
    expect(await sqlstate(insertAlert('CHECK_IN_REFUSED_NO_ENTRY', occ))).toBe('OK');
    expect(await sqlstate(insertAlert('PRESENCE_OPEN_4H', randomUUID()))).toBe('OK');
  });

  it('CHECK de kind: valor fora dos 2 tipos é recusado', async () => {
    expect(await sqlstate(insertAlert('OUTRO_TIPO', randomUUID()))).toBe('23514');
  });

  it('CHECKs de canal e status da entrega', async () => {
    const a = await insertAlert('PRESENCE_OPEN_4H', randomUUID());
    expect(await sqlstate(insertDelivery(a, { channel: 'WHATSAPP' }))).toBe('23514');
    expect(await sqlstate(insertDelivery(a, { status: 'ENVIADO' }))).toBe('23514');
    for (const [i, status] of ['PENDING', 'SENDING', 'SENT', 'SKIPPED_TEST', 'SKIPPED_NO_KEY', 'NO_ADDRESS'].entries()) {
      expect(await sqlstate(insertDelivery(a, { uid: `uid-ok-${i}`, status }))).toBe('OK');
    }
  });

  it('CHECK do erro: FAILED exige error_code e error_code só existe com FAILED', async () => {
    const a = await insertAlert('PRESENCE_OPEN_4H', randomUUID());
    expect(await sqlstate(insertDelivery(a, { status: 'FAILED', error: null }))).toBe('23514');
    expect(await sqlstate(insertDelivery(a, { status: 'SENT', error: 'E1' }))).toBe('23514');
    expect(await sqlstate(insertDelivery(a, { status: 'FAILED', error: 'E1' }))).toBe('OK');
  });

  it('CHECK do canal: IN_APP exige notification_event_id e EMAIL não tem', async () => {
    const a = await insertAlert('PRESENCE_OPEN_4H', randomUUID());
    expect(await sqlstate(insertDelivery(a, { channel: 'IN_APP', event: null }))).toBe('23514');
    expect(await sqlstate(insertDelivery(a, { channel: 'EMAIL', event: eventId }))).toBe('23514');
    expect(await sqlstate(insertDelivery(a, { channel: 'IN_APP', event: eventId }))).toBe('OK');
  });

  it('PK (alert, destinatário, canal): a mesma entrega não entra 2×; outro canal entra', async () => {
    const a = await insertAlert('PRESENCE_OPEN_4H', randomUUID());
    expect(await sqlstate(insertDelivery(a))).toBe('OK');
    expect(await sqlstate(insertDelivery(a))).toBe('23505');
    expect(await sqlstate(insertDelivery(a, { channel: 'IN_APP', event: eventId }))).toBe('OK');
  });

  it('grants: app_system escreve; app_runtime só LÊ (nenhuma escrita)', async () => {
    const privs = async (role: string, table: string) =>
      (await pool.query<{ p: string; ok: boolean }>(
        `SELECT p, has_table_privilege($1, $2, p) AS ok FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p`, [role, table])).rows.filter((r) => r.ok).map((r) => r.p);
    expect(await privs('app_runtime', 'coordination_alert')).toEqual(['SELECT']);
    expect(await privs('app_runtime', 'coordination_alert_delivery')).toEqual(['SELECT']);
    // `ALTER DEFAULT PRIVILEGES` do ambiente já dá mais ao app_system; o que a migration promete é o MÍNIMO (o que o use case usa)
    expect(await privs('app_system', 'coordination_alert')).toEqual(expect.arrayContaining(['SELECT', 'INSERT']));
    expect(await privs('app_system', 'coordination_alert_delivery')).toEqual(expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE']));
  });
});
