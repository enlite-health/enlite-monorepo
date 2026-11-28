/**
 * Re-teste diário de `broken`/`wrong_account` (`runDailyCheck` → `recheckOne`) — change tactiq-vinculo-resiliente, F2 (design D3-D7).
 * Repositório em memória (sem SQL: a prova SQL real é o e2e `tactiq-recheck.e2e.test.ts`), dublês do Tactiq, KMS e trava dublados.
 */
import type { Pool } from 'pg';
import type { TactiqLinkRepository } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import type { LastDegrade } from '../../domain/tactiqRecheck';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { TactiqLinkService } from '../TactiqLinkService';

// A trava de sessão do Postgres não é o assunto aqui: executa `fn` direto.
jest.mock('@shared/database/sessionAdvisoryLock', () => ({
  withSessionAdvisoryLock: async (_db: unknown, _key: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));

const HOST = 'host.fake@enlite.test';
const OLD = 'rt-old-fake';
const NEW = 'rt-new-fake';
const OWN = 'mcp:meetings:own';
const DETAILS = 'mcp:meetings:own mcp:meetings:details';
const DEGRADE_KINDS = ['tactiq_link.broken', 'tactiq_link.wrong_account', 'tactiq_link.recheck_dead'];

interface Opts {
  status?: string;
  lastDegrade?: LastDegrade;
  lastLinkScope?: string | null;
  frozen?: boolean;
  casOk?: boolean;
}

function build(opts: Opts = {}) {
  const oauth = new FakeTactiqOAuth();
  const mcp = new FakeTactiqMcp();
  const events: Array<Record<string, unknown>> = [];
  const initial: LastDegrade = opts.lastDegrade ?? { kind: 'tactiq_link.broken', reason: 'access_action:request_seat', source: 'link' };
  const lastDegrade = (): LastDegrade => {
    const last = [...events].reverse().find((e) => DEGRADE_KINDS.includes(String(e.kind)));
    return last
      ? { kind: String(last.kind), reason: (last.reason as string | null) ?? null, source: (last.ref as { source?: string } | undefined)?.source ?? null }
      : initial;
  };
  const repo = {
    listLinkedWithToken: jest.fn().mockResolvedValue([]),
    listRecheckableWithToken: jest.fn(async () => [
      { id: 'link-1', host_email: HOST, status: opts.status ?? 'broken', refresh_token_encrypted: 'enc-old', lastDegrade: lastDegrade() },
    ]),
    lastLinkScope: jest.fn().mockResolvedValue(opts.lastLinkScope ?? null),
    rotateTokenIfUnchanged: jest.fn().mockResolvedValue(opts.casOk ?? true),
    rotateToken: jest.fn().mockResolvedValue(undefined),
    reactivate: jest.fn().mockResolvedValue(true),
    recordCheck: jest.fn().mockResolvedValue(undefined),
    degrade: jest.fn().mockResolvedValue(true),
    appendEvent: jest.fn(async (e: Record<string, unknown>) => void events.push(e)),
    listActiveRoster: jest.fn().mockResolvedValue([]),
  };
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new TactiqLinkService({
    repo: repo as unknown as TactiqLinkRepository,
    chromeReports: {} as ChromeReportRepository,
    oauth,
    mcp,
    db: {} as Pool,
    publisher: {} as SystemNotificationPublisher,
    cipher: { encrypt: jest.fn(async (s: string) => `enc:${s}`), decrypt: jest.fn(async () => OLD) },
    log,
    ...(opts.frozen !== undefined ? { consentScopeFrozen: opts.frozen } : {}),
  });
  return { service, oauth, mcp, repo, events, log };
}

const kinds = (events: Array<Record<string, unknown>>) => events.map((e) => e.kind);

describe('recheck — o teste diário reativa o vínculo sozinho (F2)', () => {
  it('(a) broken/request_seat + ready + escopo com details → reativa, rotaciona por CAS e grava `reactivated`', async () => {
    const t = build();
    t.oauth.refreshScope = DETAILS;
    t.oauth.rotateTo(NEW);
    const summary = await t.service.runDailyCheck();
    expect(summary).toMatchObject({ rechecked: 1, reactivated: 1 });
    expect(t.repo.rotateTokenIfUnchanged).toHaveBeenCalledWith('link-1', 'enc-old', `enc:${NEW}`);
    expect(t.repo.rotateToken).not.toHaveBeenCalled();
    expect(t.repo.reactivate).toHaveBeenCalledWith('link-1', expect.any(Date));
    expect(t.events).toEqual([
      expect.objectContaining({ kind: 'tactiq_link.reactivated', outcome: 'linked', ref: { from: 'broken', scope: DETAILS } }),
    ]);
    expect(t.mcp.pingTokens).toEqual([`at-${OLD}`]);
  });

  it('(a2) wrong_account legado, sem escopo em lugar nenhum → vale só o ready', async () => {
    const t = build({ status: 'wrong_account', lastDegrade: { kind: 'tactiq_link.wrong_account', reason: 'meeting_not_visible' } });
    await t.service.runDailyCheck();
    expect(t.repo.reactivate).toHaveBeenCalledTimes(1);
    expect(t.events).toEqual([expect.objectContaining({ kind: 'tactiq_link.reactivated', ref: { from: 'wrong_account' } })]);
  });

  it.each([
    ['denied', { kind: 'denied', action: 'request_seat', title: null } as const],
    ['unrecognized', { kind: 'unrecognized' } as const],
  ])('(b) %s → não reativa nem grava evento', async (_n, verdict) => {
    const t = build();
    t.mcp.verdict = verdict;
    const summary = await t.service.runDailyCheck();
    expect(summary).toMatchObject({ rechecked: 1, reactivated: 0 });
    expect(t.repo.reactivate).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  it('(b2) o 401/403 do ping no re-teste → não reativa', async () => {
    const t = build();
    const { TactiqUnauthorizedError } = await import('../ports/TactiqPorts');
    t.mcp.pingError = new TactiqUnauthorizedError({ kind: 'mcp_transport' });
    await t.service.runDailyCheck();
    expect(t.repo.reactivate).not.toHaveBeenCalled();
  });

  it('(c) escopo congelado + último escopo `own` + renovação sem escopo → não reativa', async () => {
    const t = build({ frozen: true, lastLinkScope: OWN });
    await t.service.runDailyCheck();
    expect(t.repo.reactivate).not.toHaveBeenCalled();
    expect(t.events).toEqual([]);
  });

  it('(d) escopo NÃO congelado + o mesmo caso → reativa (só o ready)', async () => {
    const t = build({ frozen: false, lastLinkScope: OWN });
    await t.service.runDailyCheck();
    expect(t.repo.reactivate).toHaveBeenCalledTimes(1);
  });

  it('(c2) o `scope` da renovação é autoritativo: `own` na renovação não reativa mesmo com `details` gravado', async () => {
    const t = build({ frozen: true, lastLinkScope: DETAILS });
    t.oauth.refreshScope = OWN;
    await t.service.runDailyCheck();
    expect(t.repo.reactivate).not.toHaveBeenCalled();
  });

  it('(e) invalid_grant na renovação → `recheck_dead`; a 2ª rodada não renova de novo', async () => {
    const t = build();
    t.oauth.invalidate(OLD);
    await t.service.runDailyCheck();
    expect(kinds(t.events)).toEqual(['tactiq_link.recheck_dead']);
    expect(t.events[0]).toMatchObject({ reason: 'invalid_grant' });
    expect(t.oauth.refreshCalls).toHaveLength(1);
    expect(t.repo.reactivate).not.toHaveBeenCalled();

    const second = await t.service.runDailyCheck();
    expect(t.oauth.refreshCalls).toHaveLength(1);
    expect(second.rechecked).toBe(0);
  });

  it('(e2) queda da importação (`source=import`) não é re-testada', async () => {
    const t = build({ lastDegrade: { kind: 'tactiq_link.broken', reason: 'unauthorized', source: 'import' } });
    const summary = await t.service.runDailyCheck();
    expect(t.oauth.refreshCalls).toHaveLength(0);
    expect(summary.rechecked).toBe(0);
  });

  it('(f) CAS com 0 linhas (revínculo concorrente) → não reativa e nem pinga', async () => {
    const t = build({ casOk: false });
    t.oauth.rotateTo(NEW);
    await t.service.runDailyCheck();
    expect(t.repo.rotateTokenIfUnchanged).toHaveBeenCalledTimes(1);
    expect(t.repo.reactivate).not.toHaveBeenCalled();
    expect(t.mcp.pingTokens).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('(g) log e evento sem e-mail nem token', async () => {
    const t = build();
    t.oauth.refreshScope = DETAILS;
    t.oauth.rotateTo(NEW);
    await t.service.runDailyCheck();
    const dead = build();
    dead.oauth.invalidate(OLD);
    await dead.service.runDailyCheck();
    for (const x of [t, dead]) {
      const payload = JSON.stringify([x.log.info.mock.calls, x.log.warn.mock.calls, x.events.map(({ email: _e, ...rest }) => rest)]);
      for (const secret of [HOST, OLD, NEW, 'enc-old', 'enc:']) expect(payload).not.toContain(secret);
    }
    expect(t.log.info.mock.calls.find((c) => c[1] === 'admission.tactiq_link.reactivated')?.[0]).toEqual({ linkId: 'link-1', from: 'broken' });
  });

  it('o teste diário que derruba grava `source=daily_check` (D7)', async () => {
    const t = build();
    t.repo.listLinkedWithToken.mockResolvedValue([{ id: 'link-9', host_email: HOST }]);
    (t.repo as unknown as { findLinkedTokenByEmail: jest.Mock }).findLinkedTokenByEmail = jest
      .fn()
      .mockResolvedValue({ id: 'link-9', refresh_token_encrypted: 'enc' });
    t.mcp.verdict = { kind: 'denied', action: 'request_seat', title: null };
    await t.service.runDailyCheck();
    expect(t.events.find((e) => e.kind === 'tactiq_link.broken')).toMatchObject({ reason: 'access_action:request_seat', ref: { source: 'daily_check' } });
  });
});
