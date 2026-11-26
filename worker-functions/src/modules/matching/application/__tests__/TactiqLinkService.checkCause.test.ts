/**
 * Teste diário (`runDailyCheck` → `checkOne`): o evento `tactiq_link.broken` e o log carregam o MOTIVO tipado da recusa
 * (change tactiq-vinculo-valida-acesso, F1). Quem derruba o vínculo não muda; só o registro do porquê.
 */
import type { Pool } from 'pg';
import type { TactiqLinkRepository } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { TactiqInvalidGrantError, TactiqUnauthorizedError } from '../ports/TactiqPorts';
import { TactiqLinkService } from '../TactiqLinkService';

// A trava de sessão do Postgres não é o assunto aqui: executa `fn` direto.
jest.mock('@shared/database/sessionAdvisoryLock', () => ({
  withSessionAdvisoryLock: async (_db: unknown, _key: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));

const HOST = 'host.fake@enlite.test';
const ACCESS_TOKEN = 'tok-fake-access';
const REFRESH_TOKEN = 'tok-fake-refresh';

function build() {
  const oauth = new FakeTactiqOAuth();
  const mcp = new FakeTactiqMcp();
  const events: Array<Record<string, unknown>> = [];
  const repo = {
    listLinkedWithToken: jest.fn().mockResolvedValue([{ id: 'link-1', host_email: HOST }]),
    findLinkedTokenByEmail: jest.fn().mockResolvedValue({ id: 'link-1', refresh_token_encrypted: 'enc' }),
    recordCheck: jest.fn().mockResolvedValue(undefined),
    degrade: jest.fn().mockResolvedValue(true),
    rotateToken: jest.fn().mockResolvedValue(undefined),
    appendEvent: jest.fn(async (e: Record<string, unknown>) => void events.push(e)),
    listRecheckableWithToken: jest.fn().mockResolvedValue([]),
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
    cipher: { encrypt: jest.fn(async (s: string) => `enc:${s}`), decrypt: jest.fn(async () => REFRESH_TOKEN) },
    log,
  });
  return { service, oauth, mcp, repo, events, log };
}

const brokenEvent = (events: Array<Record<string, unknown>>) => events.find((e) => e.kind === 'tactiq_link.broken');
const brokenLog = (log: { warn: jest.Mock }) => log.warn.mock.calls.find((c) => c[1] === 'admission.tactiq_link.broken');

describe('checkOne — o motivo da queda vai ao evento e ao log', () => {
  it('as 3 origens geram 3 reasons distintos (access_action, token_endpoint, mcp_transport)', async () => {
    const reasons: string[] = [];
    const causes: string[] = [];

    // (a) o ping devolve `denied` (conta sem assento, F21)
    let t = build();
    t.mcp.verdict = { kind: 'denied', action: 'request_seat', title: null };
    expect((await t.service.runDailyCheck()).broken).toBe(1);
    reasons.push(String(brokenEvent(t.events)?.reason));
    causes.push(String((brokenLog(t.log)?.[0] as { cause: string }).cause));

    // (b) 401/403 do endpoint de token (no refresh)
    t = build();
    jest.spyOn(t.oauth, 'refresh').mockRejectedValue(new TactiqUnauthorizedError({ kind: 'token_endpoint' }));
    expect((await t.service.runDailyCheck()).broken).toBe(1);
    reasons.push(String(brokenEvent(t.events)?.reason));
    causes.push(String((brokenLog(t.log)?.[0] as { cause: string }).cause));

    // (c) 401/403 do transporte MCP
    t = build();
    t.mcp.pingError = new TactiqUnauthorizedError({ kind: 'mcp_transport' });
    expect((await t.service.runDailyCheck()).broken).toBe(1);
    reasons.push(String(brokenEvent(t.events)?.reason));
    causes.push(String((brokenLog(t.log)?.[0] as { cause: string }).cause));

    expect(reasons).toEqual(['access_action:request_seat', 'token_endpoint_401_403', 'mcp_transport_401_403']);
    expect(causes).toEqual(reasons);
    expect(new Set(reasons).size).toBe(3);
  });

  it('o log carrega { linkId, outcome, cause } e o evento mantém outcome=broken; o estado gravado segue `unauthorized`', async () => {
    const t = build();
    t.mcp.verdict = { kind: 'denied', action: 'upgrade', title: 'Upgrade needed' };
    await t.service.runDailyCheck();
    expect(brokenLog(t.log)?.[0]).toEqual({ linkId: 'link-1', outcome: 'unauthorized', cause: 'access_action:upgrade' });
    expect(brokenEvent(t.events)).toMatchObject({ email: HOST, kind: 'tactiq_link.broken', outcome: 'broken', reason: 'access_action:upgrade' });
    expect(t.repo.degrade).toHaveBeenCalledWith(HOST, 'broken', 'unauthorized', expect.any(Date));
  });

  it('invalid_grant segue como antes (reason=invalid_grant)', async () => {
    const t = build();
    jest.spyOn(t.oauth, 'refresh').mockRejectedValue(new TactiqInvalidGrantError());
    await t.service.runDailyCheck();
    expect(brokenEvent(t.events)?.reason).toBe('invalid_grant');
  });

  it('sem causa (zero argumento: dublês antigos, e2e) o reason segue o outcome, como antes', async () => {
    const t = build();
    t.mcp.pingError = new TactiqUnauthorizedError();
    await t.service.runDailyCheck();
    expect(brokenEvent(t.events)?.reason).toBe('unauthorized');
  });

  it('valor estranho de action não vaza: evento e log só têm unrecognized_value', async () => {
    const t = build();
    // o veredito real já chega sanitizado do `pingVerdict`; aqui prova que mesmo um action cru não chega ao reason
    t.mcp.verdict = { kind: 'denied', action: 'Texto livre do Tactiq com acentuação e mais de trinta e dois caracteres', title: null };
    await t.service.runDailyCheck();
    expect(brokenEvent(t.events)?.reason).toBe('access_action:unrecognized_value');
    expect(JSON.stringify([t.events, t.log.warn.mock.calls])).not.toContain('Texto livre');
  });

  it('o JSON do evento e do log NÃO contém access token, refresh token, e-mail nem texto livre do Tactiq', async () => {
    const t = build();
    t.mcp.verdict = { kind: 'denied', action: 'request_seat', title: 'Ask your team admin for a seat' };
    await t.service.runDailyCheck();
    const evento = JSON.stringify(brokenEvent(t.events)).replace(HOST, '<host>'); // o e-mail do HOST é a chave do evento; o resto não pode tê-lo
    const log = JSON.stringify(t.log.warn.mock.calls);
    for (const bruto of [ACCESS_TOKEN, REFRESH_TOKEN, `at-${REFRESH_TOKEN}`, 'Ask your team admin']) {
      expect(evento).not.toContain(bruto);
      expect(log).not.toContain(bruto);
    }
    expect(log).not.toContain(HOST);
    expect(log).not.toContain('@');
    expect(evento).not.toContain('@');
  });
});

describe('checkOne — unrecognized não derruba (como hoje) mas avisa', () => {
  it('unrecognized → ok + warn access_unrecognized; ready → ok sem warn', async () => {
    let t = build();
    t.mcp.verdict = { kind: 'unrecognized' };
    expect((await t.service.runDailyCheck()).ok).toBe(1);
    expect(t.repo.degrade).not.toHaveBeenCalled();
    expect(t.repo.recordCheck).toHaveBeenCalledWith(HOST, 'ok', expect.any(Date));
    expect(t.log.warn.mock.calls.map((c) => c[1])).toContain('admission.tactiq_link.access_unrecognized');

    t = build();
    expect((await t.service.runDailyCheck()).ok).toBe(1);
    expect(t.log.warn.mock.calls.map((c) => c[1])).not.toContain('admission.tactiq_link.access_unrecognized');
  });
});
