/**
 * Diário: queda por ASSENTO → cópia ao Acesso Master + aviso ao host (change tactiq-vinculo-resiliente, F3/T305, design D11-D13).
 * Repositório e publicador em memória (a prova em SQL real é o e2e `tactiq-seat-notice.e2e.test.ts`); trava e transação dublados.
 */
import type { Pool } from 'pg';
import type { TactiqLinkRepository } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { TactiqUnauthorizedError } from '../ports/TactiqPorts';
import { TactiqLinkService } from '../TactiqLinkService';

// A trava de sessão e a transação do ator não são o assunto aqui: executam `fn` direto.
jest.mock('@shared/database/sessionAdvisoryLock', () => ({
  withSessionAdvisoryLock: async (_db: unknown, _key: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));

const HOST = 'host.fake@enlite.test';
const HOST_UID = 'uid-host';
const HOST_NAME = 'Fulana Fake';
const OWN = 'mcp:meetings:own';
type Ev = { email: string; kind: string; outcome?: string | null; reason?: string | null; at: Date; ref?: Record<string, unknown> | null };

function build(o: { masters?: string[]; scope?: string | null } = {}) {
  const events: Ev[] = [];
  const st = { status: 'linked', lastNotified: null as string | null };
  const masters = o.masters ?? ['m-1', 'm-2', 'm-3'];
  const lastDegrade = () => {
    const e = [...events].reverse().find((x) => ['tactiq_link.broken', 'tactiq_link.wrong_account', 'tactiq_link.recheck_dead'].includes(x.kind));
    return e ? { kind: e.kind, reason: e.reason ?? null, source: (e.ref?.source as string | undefined) ?? null } : null;
  };
  const episodeNotified = () => {
    const e = [...events].reverse().find(
      (x) => ['tactiq_link.linked', 'tactiq_link.reactivated'].includes(x.kind) || (x.kind === 'tactiq_link.notified' && x.reason === 'seat_missing_master' && x.outcome === 'sent'),
    );
    return e?.kind === 'tactiq_link.notified';
  };
  const repo = {
    listLinkedWithToken: jest.fn(async () => (st.status === 'linked' ? [{ id: 'link-1', host_email: HOST, refresh_token_encrypted: 'enc' }] : [])),
    findLinkedTokenByEmail: jest.fn(async () => (st.status === 'linked' ? { id: 'link-1', refresh_token_encrypted: 'enc' } : null)),
    listRecheckableWithToken: jest.fn().mockResolvedValue([]),
    rotateToken: jest.fn().mockResolvedValue(undefined),
    recordCheck: jest.fn().mockResolvedValue(undefined),
    degrade: jest.fn(async (_e: string, to: string) => {
      if (st.status !== 'linked') return false;
      st.status = to;
      return true;
    }),
    appendEvent: jest.fn(async (e: Ev) => void events.push(e)),
    listActiveRoster: jest.fn().mockResolvedValue([{ id: 'h-1', email: HOST, country: 'AR' }]),
    findByEmail: jest.fn(async () => ({ status: st.status, firebase_uid: HOST_UID, missing_since: new Date(), status_changed_at: new Date() })),
    activeUserUidByEmail: jest.fn().mockResolvedValue(HOST_UID),
    claimNotification: jest.fn(async (_e: string, reason: string) => {
      if (st.lastNotified === reason) return false;
      st.lastNotified = reason;
      return true;
    }),
    lastDegrade: jest.fn(async () => lastDegrade()),
    lastLinkScope: jest.fn(async () => o.scope ?? null),
    claimSeatEpisode: jest.fn(async () => !episodeNotified()),
    activeMasterUids: jest.fn(async () => masters),
    hostDisplayName: jest.fn(async () => HOST_NAME),
    firstEventAt: jest.fn().mockResolvedValue(null),
  };
  const published: Array<Record<string, unknown>> = [];
  const publisher = { publishAdmissionTactiqLinkRequired: jest.fn(async (_c: unknown, input: Record<string, unknown>) => void published.push(input)) };
  const oauth = new FakeTactiqOAuth();
  const mcp = new FakeTactiqMcp();
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new TactiqLinkService({
    repo: repo as unknown as TactiqLinkRepository,
    chromeReports: {} as ChromeReportRepository,
    oauth,
    mcp,
    db: {} as Pool,
    publisher: publisher as unknown as SystemNotificationPublisher,
    cipher: { encrypt: jest.fn(async (s: string) => `enc:${s}`), decrypt: jest.fn(async () => 'rt-old') },
    log,
  });
  return { service, mcp, repo, events, published, log, st };
}

const seatDenied = (t: ReturnType<typeof build>) => {
  t.mcp.verdict = { kind: 'denied', action: 'request_seat', title: null };
};
const toMasters = (published: Array<Record<string, unknown>>) => published.filter((p) => p.audience === 'master');
const toHost = (published: Array<Record<string, unknown>>) => published.filter((p) => p.recipientUid === HOST_UID);
const notified = (events: Ev[]) => events.filter((e) => e.kind === 'tactiq_link.notified');

describe('diário — queda por assento avisa o Acesso Master e o host (F3/T305)', () => {
  it('assento → 1 cópia por master vivo (com o nome e autoReactivates) + 1 aviso ao host com adminNotified; eventos `notified` registrados', async () => {
    const t = build();
    seatDenied(t);
    const summary = await t.service.runDailyCheck();
    expect(summary).toMatchObject({ broken: 1, notified: 1 });
    expect(toMasters(t.published)).toEqual([
      { recipientUid: 'm-1', reason: 'seat_missing', audience: 'master', hostName: HOST_NAME, autoReactivates: true },
      { recipientUid: 'm-2', reason: 'seat_missing', audience: 'master', hostName: HOST_NAME, autoReactivates: true },
      { recipientUid: 'm-3', reason: 'seat_missing', audience: 'master', hostName: HOST_NAME, autoReactivates: true },
    ]);
    expect(toHost(t.published)).toEqual([{ recipientUid: HOST_UID, reason: 'seat_missing', audience: 'host', adminNotified: true, autoReactivates: true }]);
    // a cópia do Master sai ANTES do aviso do host
    expect(t.published.map((p) => p.audience)).toEqual(['master', 'master', 'master', 'host']);
    expect(notified(t.events)).toEqual([
      expect.objectContaining({ outcome: 'sent', reason: 'seat_missing_master', ref: { source: 'daily_check', recipients: 3 } }),
      expect.objectContaining({ outcome: 'sent', reason: 'seat_missing' }),
    ]);
    expect(t.events.find((e) => e.kind === 'tactiq_link.broken')).toMatchObject({ reason: 'access_action:request_seat', ref: { source: 'daily_check' } });
  });

  it('2ª rodada com o mesmo estado → 0 avisos novos (nem Master, nem host)', async () => {
    const t = build();
    seatDenied(t);
    await t.service.runDailyCheck();
    const before = t.published.length;
    const second = await t.service.runDailyCheck();
    expect(t.published).toHaveLength(before);
    expect(second.notified).toBe(0);
    expect(notified(t.events)).toHaveLength(2);
  });

  it('0 masters vivos → host com adminNotified=false, evento `no_recipient` e warn sem e-mail nem nome', async () => {
    const t = build({ masters: [] });
    seatDenied(t);
    await t.service.runDailyCheck();
    expect(toMasters(t.published)).toEqual([]);
    expect(toHost(t.published)).toEqual([{ recipientUid: HOST_UID, reason: 'seat_missing', audience: 'host', adminNotified: false, autoReactivates: true }]);
    expect(notified(t.events)).toEqual([
      expect.objectContaining({ outcome: 'no_recipient', reason: 'seat_missing_master' }),
      expect.objectContaining({ outcome: 'sent', reason: 'seat_missing' }),
    ]);
    expect(t.log.warn).toHaveBeenCalledWith({}, 'admission.tactiq_link.master_notice.no_recipient');
  });

  it('host que é Master só recebe a cópia de host (nunca a de Master); os outros masters recebem a deles', async () => {
    const t = build({ masters: ['m-1', HOST_UID] });
    seatDenied(t);
    await t.service.runDailyCheck();
    expect(toMasters(t.published).map((p) => p.recipientUid)).toEqual(['m-1']);
    expect(toHost(t.published)).toEqual([expect.objectContaining({ audience: 'host', reason: 'seat_missing', adminNotified: true })]);
  });

  it('escopo congelado + último escopo `own` → autoReactivates=false nas duas cópias', async () => {
    const t = build({ scope: OWN });
    seatDenied(t);
    await t.service.runDailyCheck();
    expect(t.published.map((p) => p.autoReactivates)).toEqual([false, false, false, false]);
  });

  it('queda `unauthorized` (não é assento) → `broken` como hoje: 1 aviso ao host, sem cópia de Master, sem campos novos', async () => {
    const t = build();
    t.mcp.pingError = new TactiqUnauthorizedError();
    await t.service.runDailyCheck();
    expect(t.published).toEqual([{ recipientUid: HOST_UID, reason: 'broken' }]);
    expect(t.repo.activeMasterUids).not.toHaveBeenCalled();
    expect(notified(t.events)).toEqual([expect.objectContaining({ outcome: 'sent', reason: 'broken' })]);
  });

  it('o log não recebe e-mail nem nome da pessoa', async () => {
    const t = build();
    seatDenied(t);
    await t.service.runDailyCheck();
    const logged = JSON.stringify([t.log.info.mock.calls, t.log.warn.mock.calls, t.log.error.mock.calls]);
    expect(logged).not.toContain(HOST);
    expect(logged).not.toContain(HOST_NAME);
  });
});
