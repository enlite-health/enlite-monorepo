/**
 * 069-fix-qa-caca-alerta.e2e.test.ts @integration — conserto do D2 da QA caça da spec 069 (aviso operacional NÃO pode ser best-effort silencioso).
 * Postgres real; o caso de uso roda em processo com o repositório de despacho REAL (a migration 549 aplicada pelo stack).
 *
 *  (a) a rotina TERMINADA com `failures > 0` aparece no health (`itineraryDailyRun.failed`) — HTTP real;
 *  (b) o e-mail pendente/falho de DIAS ANTERIORES (janela de 3 dias) é retomado, só na linha mais nova de cada destinatário;
 *  (c) a linha é REIVINDICADA antes de enviar: duas execuções concorrentes mandam UM e-mail só (`SENDING`, migration 549).
 *
 * Teste nunca toca canal real: o e-mail é um dublê (nunca o SendGrid) e os destinatários são `qa.*@enlite.test`.
 */
import axios from 'axios';
import { Pool, type PoolClient } from 'pg';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { UncoveredShiftsAlertUseCase } from '../../src/modules/case/application/UncoveredShiftsAlertUseCase';
import { SystemNotificationPublisher } from '../../src/modules/inapp-notification/application/SystemNotificationPublisher';
import { UncoveredAlertDispatchRepository, CLAIM_STALE_MINUTES } from '../../src/modules/case/infrastructure/UncoveredAlertDispatchRepository';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const RUN = Date.now();
const PREFIX = `ps069al-${RUN}-`;

describe('069 · QA caça D2: aviso operacional que não pode falhar em silêncio @integration', () => {
  let pool: Pool;
  let hoje = '';
  const repo = new UncoveredAlertDispatchRepository();
  const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
  const day = async (n: number): Promise<string> => (await q<{ d: string }>(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [hoje, n]))[0].d;
  let savedRun: Array<Record<string, unknown>> = [];

  /** Notificação (FK composta do despacho) + a linha de despacho. */
  async function dispatch(uid: string, date: string, status: string, errorCode: string | null = null, minutesAgo = 0): Promise<void> {
    const eventId = (
      await q<{ id: string }>(`INSERT INTO notification_events (type_code, actor_uid, payload) VALUES ('ITINERARY_UNCOVERED_SHIFTS', 'system:itinerary-daily', '{}') RETURNING id`)
    )[0].id;
    await pool.query(`INSERT INTO notifications (event_id, recipient_uid) VALUES ($1, $2)`, [eventId, uid]);
    await pool.query(
      `INSERT INTO itinerary_uncovered_alert_dispatch (operation_date, recipient_uid, event_id, email_status, email_error_code, updated_at)
       VALUES ($1::date, $2, $3, $4, $5, now() - make_interval(mins => $6::int))`,
      [date, uid, eventId, status, errorCode, minutesAgo],
    );
  }
  const statusOf = async (uid: string, date: string): Promise<{ email_status: string; email_error_code: string | null }> =>
    (await q<{ email_status: string; email_error_code: string | null }>(`SELECT email_status, email_error_code FROM itinerary_uncovered_alert_dispatch WHERE recipient_uid = $1 AND operation_date = $2::date`, [uid, date]))[0];
  const withClient = async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      return await fn(c);
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    hoje = (await q<{ d: string }>(`SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS d`))[0].d;
    savedRun = await q(`SELECT * FROM itinerary_daily_run WHERE country = 'AR' AND operation_date = $1::date`, [hoje]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM itinerary_uncovered_alert_dispatch WHERE recipient_uid LIKE $1`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM notification_events WHERE id IN (SELECT event_id FROM notifications WHERE recipient_uid LIKE $1)`, [`${PREFIX}%`]);
    await pool.query(`DELETE FROM itinerary_daily_run WHERE country = 'AR' AND operation_date = $1::date`, [hoje]);
    for (const r of savedRun) {
      await pool.query(`INSERT INTO itinerary_daily_run (country, operation_date, started_at, finished_at, failures) VALUES ($1, $2, $3, $4, $5)`, [r.country, hoje, r.started_at, r.finished_at, r.failures]);
    }
    await pool.end();
    await DatabaseConnection.getInstance().getPool().end();
  });

  // ── (a) health ─────────────────────────────────────────────────────────────────────────────────
  it('(a) rotina TERMINADA com failures > 0 → /events/health lista em `failed` (country, operationDate, failures); com failures = 0 não lista (controle)', async () => {
    const health = async () =>
      (await axios.get(`${API_URL}/api/internal/events/health`, { headers: { 'X-Internal-Secret': SECRET }, validateStatus: () => true })).data.itineraryDailyRun as {
        failed: Array<{ country: string; operationDate: string; failures: number }>;
      };
    const seed = async (failures: number) => {
      await pool.query(`DELETE FROM itinerary_daily_run WHERE country = 'AR' AND operation_date = $1::date`, [hoje]);
      await pool.query(`INSERT INTO itinerary_daily_run (country, operation_date, finished_at, failures) VALUES ('AR', $1::date, now(), $2)`, [hoje, failures]);
    };
    await seed(0);
    expect((await health()).failed.filter((f) => f.country === 'AR')).toEqual([]);
    await seed(2);
    expect((await health()).failed.filter((f) => f.country === 'AR')).toEqual([{ country: 'AR', operationDate: hoje, failures: 2 }]);
  });

  // ── (c) reivindicação ──────────────────────────────────────────────────────────────────────────
  it('(c) claimEmail: duas reivindicações simultâneas da MESMA linha → exatamente uma ganha; SENDING sem código de erro; FAILED é reivindicável (código zerado)', async () => {
    const uid = `${PREFIX}claim`;
    await dispatch(uid, hoje, 'PENDING');
    const [a, b] = await Promise.all([
      withClient((c) => repo.claimEmail(c, { operationDate: hoje, recipientUid: uid })),
      withClient((c) => repo.claimEmail(c, { operationDate: hoje, recipientUid: uid })),
    ]);
    expect([a, b].sort()).toEqual([false, true]);
    expect(await statusOf(uid, hoje)).toEqual({ email_status: 'SENDING', email_error_code: null });
    expect(await withClient((c) => repo.claimEmail(c, { operationDate: hoje, recipientUid: uid }))).toBe(false); // já reivindicada há instantes

    const falho = `${PREFIX}falho`;
    await dispatch(falho, hoje, 'FAILED', 'ETIMEDOUT');
    expect(await withClient((c) => repo.claimEmail(c, { operationDate: hoje, recipientUid: falho }))).toBe(true);
    expect(await statusOf(falho, hoje)).toEqual({ email_status: 'SENDING', email_error_code: null });

    const abandonado = `${PREFIX}abandonado`; // a execução morreu entre reivindicar e marcar
    await dispatch(abandonado, hoje, 'SENDING', null, CLAIM_STALE_MINUTES + 5);
    expect(await withClient((c) => repo.claimEmail(c, { operationDate: hoje, recipientUid: abandonado }))).toBe(true);
    const enviado = `${PREFIX}enviado`;
    await dispatch(enviado, hoje, 'SENT');
    expect(await withClient((c) => repo.claimEmail(c, { operationDate: hoje, recipientUid: enviado }))).toBe(false); // SENT nunca volta
  });

  // ── (b) janela ─────────────────────────────────────────────────────────────────────────────────
  it('(b) listRetryable: dias anteriores dentro da janela de 3 dias entram; fora da janela, SENT e linhas superadas por uma mais nova do mesmo destinatário NÃO', async () => {
    const u = (n: string) => `${PREFIX}j-${n}`;
    await dispatch(u('ontem'), await day(-1), 'FAILED', 'X'); // entra
    await dispatch(u('anteontem'), await day(-2), 'PENDING'); // entra (limite da janela)
    await dispatch(u('antes3'), await day(-3), 'PENDING'); // fora da janela
    await dispatch(u('superada'), await day(-1), 'PENDING'); // superada pela de hoje (já SENT)
    await dispatch(u('superada'), hoje, 'SENT');
    await dispatch(u('duas'), await day(-1), 'FAILED', 'Y'); // superada pela de hoje, que também é retomável
    await dispatch(u('duas'), hoje, 'PENDING');
    const lista = (await withClient((c) => repo.listRetryable(c, hoje))).filter((r) => r.recipientUid.startsWith(`${PREFIX}j-`));
    const chave = (r: { recipientUid: string; operationDate: string }) => `${r.recipientUid.slice(PREFIX.length)}@${r.operationDate}`;
    const esperadas = [`j-ontem@${await day(-1)}`, `j-anteontem@${await day(-2)}`, `j-duas@${hoje}`];
    expect(lista.map(chave).sort()).toEqual(esperadas.sort());
  });

  // ── (b)(c) pelo caso de uso ────────────────────────────────────────────────────────────────────
  const faixa = (serviceId: string) => ({
    slots: [{ slotId: `slot-${serviceId}`, serviceId, weekday: 1, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null }],
    assignments: [],
    absences: [],
  });
  const montar = (uid: string, over: { publisherFails?: boolean; emailDelayMs?: number } = {}) => {
    const reader = {
      readUniverse: async () => [{ patientId: `${PREFIX}pac`, facts: { itineraryAssembled: true, patientStatus: 'ACTIVE' }, inputs: faixa(`${PREFIX}srv`) }],
      readLabels: async () => [],
    };
    const recipients = { resolve: async () => ({ recipients: [{ uid, email: `qa.${uid}@enlite.test`, countries: ['AR'] }], skippedNoCountry: 0 }) };
    const sent: string[] = [];
    const email = {
      sendItineraryUncoveredShiftsDigest: async (to: string) => {
        await new Promise((r) => setTimeout(r, over.emailDelayMs ?? 0));
        sent.push(to);
      },
    };
    const real = new SystemNotificationPublisher();
    const publisher = {
      publishItineraryUncoveredShifts: async (...args: Parameters<SystemNotificationPublisher['publishItineraryUncoveredShifts']>) => {
        if (over.publisherFails) throw new Error('in-app fora do ar');
        return real.publishItineraryUncoveredShifts(...args);
      },
    };
    const uc = new UncoveredShiftsAlertUseCase(reader as never, recipients as never, repo, publisher as never, email as never);
    return { uc, sent };
  };

  it('(c) duas execuções SIMULTÂNEAS da rotina de alerta → UM e-mail só (a linha é reivindicada antes de enviar) e o despacho termina SENT', async () => {
    const uid = `${PREFIX}conc`;
    const a = montar(uid, { emailDelayMs: 400 });
    const b = montar(uid, { emailDelayMs: 400 });
    const [ra, rb] = await Promise.all([a.uc.execute({ now: new Date(), countries: ['AR'] }), b.uc.execute({ now: new Date(), countries: ['AR'] })]);
    expect(a.sent.length + b.sent.length).toBe(1);
    expect(ra.emailsSent + rb.emailsSent).toBe(1);
    expect(ra.failures + rb.failures).toBe(0);
    expect(await statusOf(uid, hoje)).toEqual({ email_status: 'SENT', email_error_code: null });
  });

  it('(b) e-mail FALHO de ontem + a in-app de hoje falhou → a rotina de hoje retoma o de ontem (payload com a cobertura de AGORA) e o marca SENT NA CHAVE DE ONTEM; falha da in-app fica contada', async () => {
    const uid = `${PREFIX}retoma`;
    await dispatch(uid, await day(-1), 'FAILED', 'ETIMEDOUT');
    const t = montar(uid, { publisherFails: true });
    const r = await t.uc.execute({ now: new Date(), countries: ['AR'] });
    expect(t.sent).toEqual([`qa.${uid}@enlite.test`]);
    expect(r).toMatchObject({ emailsSent: 1, notified: 0 });
    expect(r.failures).toBe(1); // a in-app de hoje: contada, nunca em silêncio
    expect(await statusOf(uid, await day(-1))).toEqual({ email_status: 'SENT', email_error_code: null });
    // controle: sem a linha de ontem, a mesma execução (in-app falhando) não manda nada
    const sem = montar(`${PREFIX}retoma-sem`, { publisherFails: true });
    await sem.uc.execute({ now: new Date(), countries: ['AR'] });
    expect(sem.sent).toEqual([]);
  });
});
