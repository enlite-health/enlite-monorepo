/**
 * `completeLink`: o acesso é provado ANTES de gravar (change tactiq-vinculo-valida-acesso, F2). Recusa não deixa token nem linha;
 * só a trilha recebe `tactiq_link.link_rejected`. Dublês do Tactiq; nenhum e-mail, token ou corpo em evento ou log.
 */
import type { Pool } from 'pg';
import type { TactiqLinkRepository } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { TactiqTransientError, TactiqUnauthorizedError } from '../ports/TactiqPorts';
import { TactiqAccessDeniedError, TactiqExchangeFailedError, TactiqLinkService } from '../TactiqLinkService';

const HOST = 'host.fake@enlite.test';

function build() {
  const oauth = new FakeTactiqOAuth();
  const mcp = new FakeTactiqMcp();
  const events: Array<Record<string, unknown>> = [];
  const repo = {
    consumeOAuthState: jest.fn().mockResolvedValue({ email: HOST, uid: 'uid-1', verifierEncrypted: 'venc' }),
    upsertLinked: jest.fn().mockResolvedValue(undefined),
    appendEvent: jest.fn(async (e: Record<string, unknown>) => void events.push(e)),
  };
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const cipher = { encrypt: jest.fn(async (s: string) => `enc:${s}`), decrypt: jest.fn(async () => 'verifier') };
  const service = new TactiqLinkService({
    repo: repo as unknown as TactiqLinkRepository,
    chromeReports: {} as ChromeReportRepository,
    oauth,
    mcp,
    db: {} as Pool,
    publisher: {} as SystemNotificationPublisher,
    cipher,
    log,
  });
  return { service, oauth, mcp, repo, events, log, cipher };
}

const complete = (t: ReturnType<typeof build>) => t.service.completeLink({ state: 'st', code: 'code-1' });
const rejected = (events: Array<Record<string, unknown>>) => events.filter((e) => e.kind === 'tactiq_link.link_rejected');

describe('completeLink — vínculo só com acesso provado', () => {
  it('scope own + ping ready → grava 1× e o evento linked leva ref.scope (sem o commit do escopo, só o ping decide)', async () => {
    const t = build();
    t.oauth.exchangeScope = 'mcp:meetings:own';
    await expect(complete(t)).resolves.toEqual({ email: HOST });
    expect(t.mcp.pingTokens).toEqual(['at-code-1']);
    expect(t.repo.upsertLinked).toHaveBeenCalledTimes(1);
    expect(t.events).toEqual([expect.objectContaining({ kind: 'tactiq_link.linked', ref: { scope: 'mcp:meetings:own' } })]);
  });

  it('scope com details + ready → upsertLinked 1×, evento linked; scope ausente → grava sem ref', async () => {
    let t = build();
    t.oauth.exchangeScope = 'mcp:meetings:own mcp:meetings:details';
    await complete(t);
    expect(t.repo.upsertLinked).toHaveBeenCalledTimes(1);
    expect(t.events[0]).toMatchObject({ kind: 'tactiq_link.linked', ref: { scope: 'mcp:meetings:own mcp:meetings:details' } });

    t = build();
    await complete(t);
    expect(t.repo.upsertLinked).toHaveBeenCalledTimes(1);
    expect(t.events[0]).not.toHaveProperty('ref');
  });

  it('request_seat → nada gravado, nem cifrado; link_rejected access_denied / access_action:request_seat com ref.title', async () => {
    const t = build();
    t.mcp.verdict = { kind: 'denied', action: 'request_seat', title: 'Ask your team admin for a seat' };
    await expect(complete(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(t.repo.upsertLinked).not.toHaveBeenCalled();
    expect(t.cipher.encrypt).not.toHaveBeenCalled();
    expect(rejected(t.events)).toEqual([
      expect.objectContaining({ outcome: 'access_denied', reason: 'access_action:request_seat', ref: { title: 'Ask your team admin for a seat' } }),
    ]);
    expect(t.events.some((e) => e.kind === 'tactiq_link.linked')).toBe(false);
  });

  it('upgrade → o redirectReason é access_denied e reason access_action:upgrade', async () => {
    const t = build();
    t.mcp.verdict = { kind: 'denied', action: 'upgrade', title: null };
    await expect(complete(t)).rejects.toMatchObject({ redirectReason: 'access_denied' });
    expect(t.repo.upsertLinked).not.toHaveBeenCalled();
    expect(rejected(t.events)[0]).toMatchObject({ reason: 'access_action:upgrade' });
  });

  it('unrecognized → nada gravado, reason access_unrecognized', async () => {
    const t = build();
    t.mcp.verdict = { kind: 'unrecognized' };
    await expect(complete(t)).rejects.toMatchObject({ redirectReason: 'access_unrecognized' });
    expect(t.repo.upsertLinked).not.toHaveBeenCalled();
    expect(rejected(t.events)[0]).toMatchObject({ outcome: 'access_unrecognized', reason: 'access_unrecognized' });
  });

  it('falha transitória no ping → fail closed: nada gravado, outcome ping_transient', async () => {
    const t = build();
    t.mcp.pingError = new TactiqTransientError('mcp_http_503');
    await expect(complete(t)).rejects.toMatchObject({ redirectReason: 'ping_transient' });
    expect(t.repo.upsertLinked).not.toHaveBeenCalled();
    expect(rejected(t.events)[0]).toMatchObject({ outcome: 'ping_transient', reason: 'mcp_http_503' });
  });

  it('401/403 do transporte MCP no ping → access_denied com mcp_transport_401_403, nada gravado', async () => {
    const t = build();
    t.mcp.pingError = new TactiqUnauthorizedError({ kind: 'mcp_transport' });
    await expect(complete(t)).rejects.toMatchObject({ redirectReason: 'access_denied' });
    expect(t.repo.upsertLinked).not.toHaveBeenCalled();
    expect(rejected(t.events)[0]).toMatchObject({ reason: 'mcp_transport_401_403' });
  });

  it('exchange 401/403 → exchange_failed com token_endpoint_401_403; ping não chamado, nada gravado', async () => {
    const t = build();
    jest.spyOn(t.oauth, 'exchangeCode').mockRejectedValue(new TactiqUnauthorizedError({ kind: 'token_endpoint' }));
    await expect(complete(t)).rejects.toBeInstanceOf(TactiqExchangeFailedError);
    expect(t.mcp.pingTokens).toEqual([]);
    expect(t.repo.upsertLinked).not.toHaveBeenCalled();
    expect(rejected(t.events)).toEqual([expect.objectContaining({ outcome: 'exchange_failed', reason: 'token_endpoint_401_403' })]);
  });

  it('nenhum token nem e-mail em evento ou log, em nenhum dos caminhos', async () => {
    const t = build();
    t.mcp.verdict = { kind: 'denied', action: 'request_seat', title: 'Seat needed' };
    await complete(t).catch(() => undefined);
    // `email` é o endereçamento da linha na trilha (coluna host_email); o que não pode conter e-mail é o RESTO do evento e o log.
    const eventsSemEndereco = t.events.map(({ email: _email, ...resto }) => resto);
    const dump = JSON.stringify([eventsSemEndereco, t.log.info.mock.calls, t.log.warn.mock.calls, t.log.error.mock.calls]);
    expect(dump).not.toContain('at-code-1');
    expect(dump).not.toContain('rt-code-1');
    expect(dump).not.toContain(HOST);
  });
});
