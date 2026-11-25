/**
 * `getOwn.accessDenial`: derivado da ÚLTIMA tentativa de vínculo na trilha (change tactiq-vinculo-valida-acesso, F3/T030).
 */
import type { Pool } from 'pg';
import { TactiqLinkRepository } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { TactiqLinkService } from '../TactiqLinkService';

const HOST = 'host.fake@enlite.test';
const T1 = new Date('2026-11-19T10:00:00Z');
const T2 = new Date('2026-11-19T11:00:00Z');
type Attempt = { kind: string; outcome: string | null; reason: string | null; ref: Record<string, unknown> | null; at: Date };

/**
 * Repo REAL sobre um banco de mentira que OBEDECE a direção do `ORDER BY` da consulta (DESC → mais nova primeiro): é a
 * consulta que decide qual tentativa vale, então ordenar errado tem de reprovar aqui.
 */
function build(trail: Attempt[]) {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (!sql.includes('admission_events')) return { rows: [] };
    const asc = /ORDER BY at ASC/i.test(sql);
    // `kind = ANY($2::text[])`: o banco de mentira também obedece a lista de kinds que a consulta pede (a lista é o que se prova).
    const wanted = Array.isArray(params[1]) ? (params[1] as string[]) : null;
    const rows = trail.filter((a) => !wanted || wanted.includes(a.kind)).sort((x, y) => (asc ? 1 : -1) * (x.at.getTime() - y.at.getTime()));
    return { rows: /LIMIT 1/i.test(sql) ? rows.slice(0, 1) : rows };
  });
  const repo = new TactiqLinkRepository({ query } as unknown as Pool);
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new TactiqLinkService({
    repo,
    chromeReports: { findByEmail: jest.fn().mockResolvedValue(null) } as unknown as ChromeReportRepository,
    oauth: new FakeTactiqOAuth(),
    mcp: new FakeTactiqMcp(),
    db: {} as Pool,
    publisher: {} as SystemNotificationPublisher,
    cipher: { encrypt: jest.fn(), decrypt: jest.fn() },
    log,
  });
  return { service, query, log, repo };
}
const rej = (outcome: string, reason: string, ref: Record<string, unknown> | null = null, at = T1): Attempt => ({
  kind: 'tactiq_link.link_rejected', outcome, reason, ref, at,
});
const linked = (at: Date): Attempt => ({ kind: 'tactiq_link.linked', outcome: 'linked', reason: null, ref: null, at });
const reactivated = (at: Date): Attempt => ({ kind: 'tactiq_link.reactivated', outcome: 'linked', reason: null, ref: { from: 'broken' }, at });

describe('getOwn.accessDenial', () => {
  it('último link_rejected por acesso → objeto {reason, title, at} (título sanitizado)', async () => {
    const t = build([rej('access_denied', 'access_action:request_seat', { title: 'Ask your team admin <img src=x>' })]);
    const own = await t.service.getOwn(HOST);
    expect(own.accessDenial).toEqual({
      reason: 'access_action:request_seat', title: 'Ask your team admin img srcx', at: T1.toISOString(),
      seatMissing: true, adminNotified: false, autoReactivates: false, // sem linha de vínculo (legado): nada volta sozinho; sem aviso ao Master na trilha
    });
    expect(JSON.stringify(own)).not.toContain(HOST);
  });

  it('scope_without_details, access_unrecognized e mcp_transport_401_403 → objeto com o reason exato, título nulo', async () => {
    for (const [outcome, reason] of [
      ['access_denied', 'scope_without_details'],
      ['access_unrecognized', 'access_unrecognized'],
      ['access_denied', 'mcp_transport_401_403'],
    ] as const) {
      const own = await build([rej(outcome, reason)]).service.getOwn(HOST);
      expect(own.accessDenial).toEqual({ reason, title: null, at: T1.toISOString(), seatMissing: false, adminNotified: false, autoReactivates: false });
    }
  });

  it('`linked` mais novo que a recusa → null', async () => {
    const own = await build([rej('access_denied', 'access_action:upgrade', null, T1), linked(T2)]).service.getOwn(HOST);
    expect(own.accessDenial).toBeNull();
  });

  it('`link_rejected` depois `reactivated` → null (a reativação do re-teste limpa a negativa, F17)', async () => {
    const own = await build([rej('access_denied', 'access_action:request_seat', null, T1), reactivated(T2)]).service.getOwn(HOST);
    expect(own.accessDenial).toBeNull();
  });

  it('`reactivated` e depois nova recusa → objeto (a ÚLTIMA decide)', async () => {
    const own = await build([reactivated(T1), rej('access_denied', 'access_action:upgrade', null, T2)]).service.getOwn(HOST);
    expect(own.accessDenial).toMatchObject({ reason: 'access_action:upgrade', at: T2.toISOString() });
  });

  it('recusa mais nova que um `linked` → objeto (a ÚLTIMA decide)', async () => {
    const own = await build([linked(T1), rej('access_denied', 'access_action:upgrade', null, T2)]).service.getOwn(HOST);
    expect(own.accessDenial).toMatchObject({ reason: 'access_action:upgrade', at: T2.toISOString() });
  });

  it('só exchange_failed → null; ping_transient → null', async () => {
    expect((await build([rej('exchange_failed', 'token_endpoint_401_403')]).service.getOwn(HOST)).accessDenial).toBeNull();
    expect((await build([rej('ping_transient', 'mcp_http_503')]).service.getOwn(HOST)).accessDenial).toBeNull();
  });

  it('sem evento → null', async () => {
    expect((await build([]).service.getOwn(HOST)).accessDenial).toBeNull();
  });

  describe('falta de assento: seatMissing, adminNotified, autoReactivates (D13)', () => {
    const OWN = 'mcp:meetings:own';
    const DETAILS = 'mcp:meetings:own mcp:meetings:details';
    const brokenEv = (reason: string, source: string, at = T1): Attempt => ({
      kind: 'tactiq_link.broken', outcome: 'broken', reason, ref: { source }, at,
    });
    /** Trilha de mentira + o que a linha, a última queda, o escopo e o aviso ao Master respondem (a consulta SQL é o e2e que prova). */
    function seat(trail: Attempt[], o: { status?: string; masterNotified?: boolean; scope?: string | null; frozen?: boolean } = {}) {
      const t = build(trail);
      const status = o.status ?? 'broken';
      const lastBroken = [...trail].reverse().find((a) => a.kind === 'tactiq_link.broken');
      jest.spyOn(t.repo, 'findByEmail').mockResolvedValue(rowOf(status));
      jest.spyOn(t.repo, 'lastDegrade').mockResolvedValue(
        lastBroken ? { kind: lastBroken.kind, reason: lastBroken.reason, source: String(lastBroken.ref?.source ?? '') || null } : null,
      );
      jest.spyOn(t.repo, 'seatEpisodeNotified').mockResolvedValue(o.masterNotified ?? false);
      jest.spyOn(t.repo, 'lastLinkScope').mockResolvedValue(o.scope === undefined ? null : o.scope);
      return t;
    }
    const rowOf = (status: string) => ({ status, linked_at: null, last_check_at: null, status_changed_at: T1 }) as never;
    const own = (t: ReturnType<typeof seat>) => t.service.getOwn(HOST);

    it('recusa por assento no vínculo + Master avisado + escopo com details → seatMissing, adminNotified e autoReactivates verdadeiros', async () => {
      const t = seat([brokenEv('access_action:request_seat', 'link'), rej('access_denied', 'access_action:request_seat', { scope: DETAILS })], { masterNotified: true, scope: DETAILS });
      expect((await own(t)).accessDenial).toMatchObject({ reason: 'access_action:request_seat', seatMissing: true, adminNotified: true, autoReactivates: true });
    });

    it('queda por assento no teste diário (`broken` mais novo) → negativa de assento, sem título', async () => {
      const t = seat([brokenEv('access_action:request_seat', 'daily_check')], { masterNotified: true });
      expect((await own(t)).accessDenial).toEqual({
        reason: 'access_action:request_seat', title: null, at: T1.toISOString(), seatMissing: true, adminNotified: true, autoReactivates: true,
      });
    });

    it('escopo congelado + último escopo `own` → autoReactivates falso (o Tactiq não amplia a autorização); não congelado → verdadeiro', async () => {
      const trail = [brokenEv('access_action:request_seat', 'link'), rej('access_denied', 'access_action:request_seat', { scope: OWN })];
      expect((await own(seat(trail, { scope: OWN }))).accessDenial).toMatchObject({ seatMissing: true, autoReactivates: false });
      const t = build(trail);
      const unfrozen = new TactiqLinkService({
        repo: t.repo, chromeReports: { findByEmail: jest.fn().mockResolvedValue(null) } as unknown as ChromeReportRepository,
        oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp(), db: {} as Pool, publisher: {} as SystemNotificationPublisher,
        cipher: { encrypt: jest.fn(), decrypt: jest.fn() }, consentScopeFrozen: false,
      });
      jest.spyOn(t.repo, 'findByEmail').mockResolvedValue(rowOf('broken'));
      jest.spyOn(t.repo, 'lastDegrade').mockResolvedValue({ kind: 'tactiq_link.broken', reason: 'access_action:request_seat', source: 'link' });
      jest.spyOn(t.repo, 'seatEpisodeNotified').mockResolvedValue(true);
      jest.spyOn(t.repo, 'lastLinkScope').mockResolvedValue(OWN);
      expect((await unfrozen.getOwn(HOST)).accessDenial).toMatchObject({ seatMissing: true, autoReactivates: true });
    });

    it('Master NÃO avisado (sem membro vivo) → adminNotified falso (a tela manda pedir a um administrador)', async () => {
      const t = seat([rej('access_denied', 'access_action:request_seat')], { masterNotified: false });
      expect((await own(t)).accessDenial).toMatchObject({ seatMissing: true, adminNotified: false });
    });

    it('causa que NÃO é assento (`upgrade`) → seatMissing falso; nenhuma consulta de assento é feita', async () => {
      const t = seat([rej('access_denied', 'access_action:upgrade')], { masterNotified: true });
      const r = (await own(t)).accessDenial;
      expect(r).toMatchObject({ reason: 'access_action:upgrade', seatMissing: false, adminNotified: false, autoReactivates: false });
      expect(t.repo.seatEpisodeNotified).not.toHaveBeenCalled();
    });

    it('queda `unauthorized` (não é assento) mais nova que a recusa → null', async () => {
      const t = seat([rej('access_denied', 'access_action:request_seat', null, T1), brokenEv('unauthorized', 'daily_check', T2)]);
      expect((await own(t)).accessDenial).toBeNull();
    });

    it('`reactivated` depois da queda por assento → null', async () => {
      const t = seat([brokenEv('access_action:request_seat', 'daily_check', T1), reactivated(T2)]);
      expect((await own(t)).accessDenial).toBeNull();
    });
  });

  it('o log não recebe e-mail', async () => {
    const t = build([rej('access_denied', 'access_action:upgrade')]);
    await t.service.getOwn(HOST);
    expect(JSON.stringify([t.log.info.mock.calls, t.log.warn.mock.calls])).not.toContain(HOST);
  });
});
