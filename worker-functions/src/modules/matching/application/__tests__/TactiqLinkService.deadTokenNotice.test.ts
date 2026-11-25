/**
 * Token MORTO avisa o Acesso Master (change tactiq-vinculo-resiliente, F3/T307, design D12): `invalid_grant` no teste diário e na importação
 * (`withHostAccess`) e `recheck_dead` → cópia `broken` 1× por evento de queda. Falta de assento NÃO entra aqui (é o T305).
 * Repositório e publicador em memória; trava e transação dublados.
 */
import type { Pool } from 'pg';
import type { TactiqLinkRepository } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { isRecheckable } from '../../domain/tactiqRecheck';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { TactiqUnauthorizedError } from '../ports/TactiqPorts';
import { TactiqLinkService } from '../TactiqLinkService';

jest.mock('@shared/database/sessionAdvisoryLock', () => ({
  withSessionAdvisoryLock: async (_db: unknown, _key: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));

const HOST = 'host.fake@enlite.test';
const HOST_UID = 'uid-host';
const HOST_NAME = 'Fulana Fake';
const TOKEN = 'rt-old';
type Ev = { email: string; kind: string; outcome?: string | null; reason?: string | null; at: Date; ref?: Record<string, unknown> | null };

function build(o: { status?: string; masters?: string[]; publishFails?: boolean; seedDegrade?: Ev } = {}) {
  const events: Ev[] = o.seedDegrade ? [o.seedDegrade] : [];
  const st = { status: o.status ?? 'linked', lastNotified: null as string | null };
  const masters = o.masters ?? ['m-1', 'm-2'];
  const lastDegrade = () => {
    const e = [...events].reverse().find((x) => ['tactiq_link.broken', 'tactiq_link.wrong_account', 'tactiq_link.recheck_dead'].includes(x.kind));
    return e ? { kind: e.kind, reason: e.reason ?? null, source: (e.ref?.source as string | undefined) ?? null } : null;
  };
  const repo = {
    listLinkedWithToken: jest.fn(async () => (st.status === 'linked' ? [{ id: 'link-1', host_email: HOST, refresh_token_encrypted: 'enc' }] : [])),
    findLinkedTokenByEmail: jest.fn(async () => (st.status === 'linked' ? { id: 'link-1', refresh_token_encrypted: 'enc' } : null)),
    listRecheckableWithToken: jest.fn(async () =>
      st.status === 'broken' ? [{ id: 'link-1', host_email: HOST, status: 'broken', refresh_token_encrypted: 'enc', lastDegrade: lastDegrade() }] : [],
    ),
    rotateToken: jest.fn().mockResolvedValue(undefined),
    rotateTokenIfUnchanged: jest.fn().mockResolvedValue(true),
    recordCheck: jest.fn().mockResolvedValue(undefined),
    lastLinkScope: jest.fn().mockResolvedValue(null),
    degrade: jest.fn(async (_e: string, to: string) => {
      if (st.status !== 'linked') return false;
      st.status = to;
      return true;
    }),
    appendEvent: jest.fn(async (e: Ev) => void events.push(e)),
    listActiveRoster: jest.fn().mockResolvedValue([]),
    findByEmail: jest.fn(async () => ({ status: st.status, firebase_uid: HOST_UID, missing_since: new Date(), status_changed_at: new Date() })),
    activeUserUidByEmail: jest.fn().mockResolvedValue(HOST_UID),
    claimNotification: jest.fn(async (_e: string, reason: string) => {
      if (st.lastNotified === reason) return false;
      st.lastNotified = reason;
      return true;
    }),
    lastDegrade: jest.fn(async () => lastDegrade()),
    activeMasterUids: jest.fn(async () => masters),
    hostDisplayName: jest.fn(async () => HOST_NAME),
  };
  const published: Array<Record<string, unknown>> = [];
  const publisher = {
    publishAdmissionTactiqLinkRequired: jest.fn(async (_c: unknown, input: Record<string, unknown>) => {
      if (o.publishFails && input.audience === 'master') throw Object.assign(new Error('boom'), { code: 'XX000' });
      published.push(input);
    }),
  };
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
    cipher: { encrypt: jest.fn(async (s: string) => `enc:${s}`), decrypt: jest.fn(async () => TOKEN) },
    log,
  });
  return { service, oauth, mcp, repo, events, published, log, st };
}

const masterCopies = (published: Array<Record<string, unknown>>) => published.filter((p) => p.audience === 'master');
const COPY = (uid: string) => ({ recipientUid: uid, reason: 'broken', audience: 'master', hostName: HOST_NAME });

describe('token morto avisa o Acesso Master (F3/T307)', () => {
  it('`invalid_grant` no teste diário → 1 cópia `broken` por master (com o nome, sem autoReactivates); repetir a rodada → 0', async () => {
    const t = build();
    t.oauth.invalidate(TOKEN);
    await t.service.runDailyCheck();
    expect(masterCopies(t.published)).toEqual([COPY('m-1'), COPY('m-2')]);
    await t.service.runDailyCheck();
    expect(masterCopies(t.published)).toHaveLength(2);
  });

  it('`invalid_grant` na importação (`withHostAccess`) → 1 cópia por master e o aviso `broken` ao host; a 2ª tentativa (sem vínculo vivo) → 0', async () => {
    const t = build();
    t.oauth.invalidate(TOKEN);
    expect(await t.service.withHostAccess(HOST, async () => 'x')).toEqual({ ok: false, reason: 'broken' });
    expect(masterCopies(t.published)).toEqual([COPY('m-1'), COPY('m-2')]);
    expect(t.published.filter((p) => p.recipientUid === HOST_UID)).toEqual([{ recipientUid: HOST_UID, reason: 'broken' }]);
    expect(await t.service.withHostAccess(HOST, async () => 'x')).toEqual({ ok: false, reason: 'no_link' });
    expect(masterCopies(t.published)).toHaveLength(2);
  });

  it('`recheck_dead` (token morto no re-teste) → 1 cópia por master; a 2ª rodada não re-testa nem avisa de novo', async () => {
    const t = build({
      status: 'broken',
      seedDegrade: { email: HOST, kind: 'tactiq_link.broken', outcome: 'broken', reason: 'access_action:request_seat', at: new Date(), ref: { source: 'link' } },
    });
    expect(isRecheckable({ status: 'broken', lastDegrade: await t.repo.lastDegrade() })).toBe(true);
    t.oauth.invalidate(TOKEN);
    await t.service.runDailyCheck();
    expect(t.events.map((e) => e.kind)).toEqual(['tactiq_link.broken', 'tactiq_link.recheck_dead']);
    expect(masterCopies(t.published)).toEqual([COPY('m-1'), COPY('m-2')]);
    await t.service.runDailyCheck();
    expect(masterCopies(t.published)).toHaveLength(2);
    expect(t.oauth.refreshCalls).toHaveLength(1);
  });

  it('queda `unauthorized` por ASSENTO no teste diário NÃO gera a cópia de token morto (duplicaria o aviso de assento do T305)', async () => {
    const t = build();
    t.mcp.verdict = { kind: 'denied', action: 'request_seat', title: null };
    await t.service.runDailyCheck();
    expect(t.events.find((e) => e.kind === 'tactiq_link.broken')).toMatchObject({ reason: 'access_action:request_seat' });
    expect(t.published).toEqual([]);
    expect(t.repo.activeMasterUids).not.toHaveBeenCalled();
  });

  it('queda `unauthorized` genérica no teste diário também não gera a cópia (só token morto)', async () => {
    const t = build();
    t.mcp.pingError = new TactiqUnauthorizedError();
    await t.service.runDailyCheck();
    expect(t.published).toEqual([]);
  });

  it('o host que é Master não recebe a cópia de Master', async () => {
    const t = build({ masters: ['m-1', HOST_UID] });
    t.oauth.invalidate(TOKEN);
    await t.service.runDailyCheck();
    expect(masterCopies(t.published).map((p) => p.recipientUid)).toEqual(['m-1']);
  });

  it('0 masters vivos → warn sem PII e nenhuma cópia; falha ao avisar vai ao log e NÃO derruba o job', async () => {
    const none = build({ masters: [] });
    none.oauth.invalidate(TOKEN);
    await none.service.runDailyCheck();
    expect(none.published).toEqual([]);
    expect(none.log.warn).toHaveBeenCalledWith({}, 'admission.tactiq_link.master_notice.no_recipient');

    const fail = build({ publishFails: true });
    fail.oauth.invalidate(TOKEN);
    await expect(fail.service.runDailyCheck()).resolves.toMatchObject({ broken: 1 });
    expect(fail.log.error).toHaveBeenCalledWith({ reason: 'XX000' }, 'admission.tactiq_link.master_notice.failed');
    const logged = JSON.stringify([fail.log.info.mock.calls, fail.log.warn.mock.calls, fail.log.error.mock.calls]);
    expect(logged).not.toContain(HOST);
    expect(logged).not.toContain(HOST_NAME);
  });
});
