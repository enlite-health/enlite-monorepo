/**
 * Trava de licença antes do 1º vínculo (change tactiq-vinculo-resiliente, F5/T503, design D16): `canStartLink` é a regra ÚNICA;
 * `startLink` lança 409 e `getOwn.canStartLink` lê da mesma regra. Repositório em memória; a prova em SQL real é o e2e `tactiq-seat-gate`.
 */
import type { Pool } from 'pg';
import type { TactiqLinkRepository, TactiqLinkRow } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { canStartLink } from '../../domain/tactiqSeatGate';
import { TactiqLinkService, TactiqSeatNotDeclaredError } from '../TactiqLinkService';

const HOST = 'host.fake@enlite.test';
const row = (status: TactiqLinkRow['status']): TactiqLinkRow => ({
  id: 'l1', host_email: HOST, firebase_uid: 'u1', status, client_id: null, linked_at: null, last_check_at: null,
  last_check_outcome: null, status_changed_at: new Date('2026-11-01T00:00:00Z'), last_notified_status: null, missing_since: null,
});

function build(o: { row?: TactiqLinkRow | null; declared?: boolean } = {}) {
  const repo = {
    findByEmail: jest.fn(async () => o.row ?? null),
    seatDeclared: jest.fn(async () => o.declared ?? false),
    insertOAuthState: jest.fn().mockResolvedValue(undefined),
    latestLinkAttempt: jest.fn(async () => null),
  };
  const service = new TactiqLinkService({
    repo: repo as unknown as TactiqLinkRepository,
    chromeReports: { findByEmail: jest.fn(async () => null) } as unknown as ChromeReportRepository,
    oauth: new FakeTactiqOAuth(),
    mcp: new FakeTactiqMcp(),
    db: {} as Pool,
    publisher: {} as SystemNotificationPublisher,
    cipher: { encrypt: jest.fn(async (s: string) => `enc:${s}`), decrypt: jest.fn(async () => 'x') },
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  });
  return { service, repo };
}

describe('canStartLink — a regra única (D16)', () => {
  it.each([
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ])('hasRow=%s seatDeclared=%s → %s', (hasRow, seatDeclared, expected) => {
    expect(canStartLink({ hasRow, seatDeclared })).toBe(expected);
  });
});

describe('TactiqLinkService.startLink — trava 409 (T503)', () => {
  it('sem linha e sem declaração → lança TACTIQ_SEAT_NOT_DECLARED e nada é gravado', async () => {
    const t = build();
    const err = await t.service.startLink({ uid: 'u1', email: HOST }).catch((e) => e);
    expect(err).toBeInstanceOf(TactiqSeatNotDeclaredError);
    expect(err.code).toBe('TACTIQ_SEAT_NOT_DECLARED');
    expect(t.repo.insertOAuthState).not.toHaveBeenCalled();
  });

  it('com declaração (sem linha) → passa e devolve a URL', async () => {
    const t = build({ declared: true });
    await expect(t.service.startLink({ uid: 'u1', email: HOST })).resolves.toHaveProperty('authorizeUrl');
    expect(t.repo.insertOAuthState).toHaveBeenCalledTimes(1);
  });

  it.each(['linked', 'broken', 'wrong_account', 'revoked'] as const)('com linha `%s` e SEM declaração (legado) → passa: nunca é travado', async (status) => {
    const t = build({ row: row(status) });
    await expect(t.service.startLink({ uid: 'u1', email: HOST })).resolves.toHaveProperty('authorizeUrl');
  });
});

describe('TactiqLinkService.getOwn.canStartLink — a tela lê da API (T503)', () => {
  it('sem linha e sem declaração → false; com declaração → true; com linha → true', async () => {
    expect((await build().service.getOwn(HOST)).canStartLink).toBe(false);
    expect((await build({ declared: true }).service.getOwn(HOST)).canStartLink).toBe(true);
    const legado = await build({ row: row('broken') }).service.getOwn(HOST);
    expect(legado.canStartLink).toBe(true);
    expect(legado.status).toBe('broken');
  });
});
