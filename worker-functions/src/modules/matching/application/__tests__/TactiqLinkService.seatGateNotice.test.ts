/**
 * Avisos da licença antes do 1º vínculo e a marcação falsa (change tactiq-vinculo-resiliente, F5/T505-T506, design D16).
 * Repositório em memória com a MESMA semântica da trilha (eventos, episódio); a prova em SQL real é o e2e `tactiq-seat-gate`.
 * Nenhum teste aqui revoga nada: a revogação automática (P-C4) NÃO existe nesta change — o grep do T506 prova.
 */
import type { Pool, PoolClient } from 'pg';
import type { TactiqLinkRepository, TactiqLinkRow } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { TactiqLinkService } from '../TactiqLinkService';

jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));
jest.mock('@shared/database/sessionAdvisoryLock', () => ({
  withSessionAdvisoryLock: async (_db: unknown, _key: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));

const HOST = 'host.fake@enlite.test';
const HOST_UID = 'uid-host';
const OWN = 'mcp:meetings:own';
const DETAILS = 'mcp:meetings:own mcp:meetings:details';
type Ev = { email: string; kind: string; outcome?: string | null; reason?: string | null; at: Date; ref?: Record<string, unknown> | null };

const brokenRow = (): TactiqLinkRow => ({
  id: 'link-1', host_email: HOST, firebase_uid: HOST_UID, status: 'broken', client_id: null, linked_at: null, last_check_at: null,
  last_check_outcome: 'unauthorized', status_changed_at: new Date('2026-11-01T00:00:00Z'), last_notified_status: null, missing_since: null,
});

function build(o: { row?: boolean; lastLinkScope?: string | null; masters?: string[]; frozen?: boolean; roster?: boolean; claimMissing?: boolean } = {}) {
  const events: Ev[] = [];
  let tick = 0;
  const last = (kinds: string[]) => [...events].reverse().find((e) => kinds.includes(e.kind));
  const repo = {
    appendEvent: jest.fn(async (e: Ev) => void events.push({ ...e, at: new Date(Date.UTC(2026, 10, 25, 0, 0, tick++)) })),
    seatDeclared: jest.fn(async () => last(['tactiq_link.seat_declared', 'tactiq_link.seat_undeclared'])?.kind === 'tactiq_link.seat_declared'),
    lockSeatTopic: jest.fn().mockResolvedValue(undefined),
    oneTimeNoticeSent: jest.fn(async (_e: string, reason: string) =>
      events.some((e) => e.kind === 'tactiq_link.notified' && e.reason === reason && e.outcome === 'sent')),
    seatArrivedInEpisode: jest.fn(async () => last(['tactiq_link.linked', 'tactiq_link.reactivated', 'tactiq_link.seat_arrived'])?.kind === 'tactiq_link.seat_arrived'),
    findByEmail: jest.fn(async () => (o.row ? brokenRow() : null)),
    lastLinkScope: jest.fn(async () => o.lastLinkScope ?? null),
    activeUserUidByEmail: jest.fn(async () => HOST_UID),
    activeMasterUids: jest.fn(async () => o.masters ?? ['m-1', 'm-2']),
    hostDisplayName: jest.fn(async () => 'Fulana Fake'),
    claimSeatEpisode: jest.fn(async () => {
      const e = [...events].reverse().find(
        (x) => ['tactiq_link.linked', 'tactiq_link.reactivated'].includes(x.kind) || (x.kind === 'tactiq_link.notified' && x.reason === 'seat_missing_master' && x.outcome === 'sent'),
      );
      return e?.kind !== 'tactiq_link.notified';
    }),
    lastDegrade: jest.fn().mockResolvedValue(null),
    consumeOAuthState: jest.fn().mockResolvedValue({ email: HOST, uid: HOST_UID, verifierEncrypted: 'venc' }),
    insertBrokenFromRejection: jest.fn().mockResolvedValue(true),
    // runDailyCheck
    listLinkedWithToken: jest.fn().mockResolvedValue([]),
    listRecheckableWithToken: jest.fn(async () =>
      o.row ? [{ id: 'link-1', host_email: HOST, status: 'broken', refresh_token_encrypted: 'enc-old', lastDegrade: { kind: 'tactiq_link.broken', reason: 'access_action:request_seat', source: 'link' } }] : []),
    listActiveRoster: jest.fn(async () => (o.roster ? [{ id: 'h1', email: HOST, country: 'AR' }] : [])),
    firstEventAt: jest.fn(async () => new Date()),
    claimMissingNotification: jest.fn().mockResolvedValue(o.claimMissing ?? false),
    claimNotification: jest.fn().mockResolvedValue(false),
    rotateTokenIfUnchanged: jest.fn().mockResolvedValue(true),
    recordCheck: jest.fn().mockResolvedValue(undefined),
    reactivate: jest.fn().mockResolvedValue(true),
  };
  const published: Array<Record<string, unknown>> = [];
  const publisher = { publishAdmissionTactiqLinkRequired: jest.fn(async (_c: unknown, i: Record<string, unknown>) => void published.push(i)) };
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
    cipher: { encrypt: jest.fn(async (s: string) => `enc:${s}`), decrypt: jest.fn(async () => 'x') },
    log,
    consentScopeFrozen: o.frozen ?? true,
  });
  return { service, oauth, mcp, repo, events, published, log };
}
const cli = {} as PoolClient;
const declare = (t: ReturnType<typeof build>, assigned: boolean) => t.service.declareSeat({ email: HOST, assigned, actorUid: 'master-1' }, cli);
const kindsOf = (events: Ev[]) => events.map((e) => e.kind);
const ready = (p: Array<Record<string, unknown>>) => p.filter((x) => x.reason === 'seat_ready');
const pending = (p: Array<Record<string, unknown>>) => p.filter((x) => x.reason === 'seat_pending');

describe('T505 — a declaração: evento + aviso ao host 1× (firstLink=true)', () => {
  it('declarar sem linha → `seat_declared` com o ator + host `seat_ready firstLink=true`; repetir a mesma marcação → 0', async () => {
    const t = build();
    await expect(declare(t, true)).resolves.toEqual({ changed: true });
    expect(t.events[0]).toMatchObject({ kind: 'tactiq_link.seat_declared', outcome: 'declared', ref: { actorUid: 'master-1' } });
    expect(JSON.stringify(t.events.map((e) => e.ref))).not.toContain('@'); // a trilha guarda o ator por uid, nunca e-mail
    expect(ready(t.published)).toEqual([{ recipientUid: HOST_UID, reason: 'seat_ready', audience: 'host', firstLink: true }]);
    await expect(declare(t, true)).resolves.toEqual({ changed: false });
    expect(ready(t.published)).toHaveLength(1);
    expect(t.events.filter((e) => e.kind === 'tactiq_link.seat_declared')).toHaveLength(1);
  });

  it('desmarcar e marcar de novo → 2 eventos de declaração, mas o aviso ao host segue 1× por pessoa', async () => {
    const t = build();
    await declare(t, true);
    await declare(t, false);
    await declare(t, true);
    expect(kindsOf(t.events).filter((k) => k.startsWith('tactiq_link.seat_'))).toEqual([
      'tactiq_link.seat_declared', 'tactiq_link.seat_undeclared', 'tactiq_link.seat_declared',
    ]);
    expect(ready(t.published)).toHaveLength(1);
  });

  it('desmarcar quem nunca foi marcado não grava nada', async () => {
    const t = build();
    await expect(declare(t, false)).resolves.toEqual({ changed: false });
    expect(t.events).toEqual([]);
  });
});

describe('T505 — `seat_pending` ao Master no teste diário: 1× por pessoa', () => {
  it('roster sem linha e sem declaração → 1 aviso por master (sem o host), com o nome; repetir a rodada → 0', async () => {
    const t = build({ roster: true, masters: ['m-1', HOST_UID] });
    await t.service.runDailyCheck();
    expect(pending(t.published)).toEqual([{ recipientUid: 'm-1', reason: 'seat_pending', audience: 'master', hostName: 'Fulana Fake' }]);
    await t.service.runDailyCheck();
    expect(pending(t.published)).toHaveLength(1);
  });

  it('com a licença já declarada → 0 avisos de pendência', async () => {
    const t = build({ roster: true });
    await declare(t, true);
    await t.service.runDailyCheck();
    expect(pending(t.published)).toEqual([]);
  });

  it('sem nenhum master vivo → warn sem PII, nada carimbado (tenta de novo amanhã)', async () => {
    const t = build({ roster: true, masters: [] });
    await t.service.runDailyCheck();
    expect(pending(t.published)).toEqual([]);
    expect(t.events.filter((e) => e.reason === 'seat_pending_master')).toEqual([]);
    expect(t.log.warn).toHaveBeenCalledWith({}, 'admission.tactiq_link.master_notice.no_recipient');
  });

  it('quem já tem linha (legado) não gera pendência', async () => {
    const t = build({ roster: true, row: true, lastLinkScope: OWN });
    await t.service.runDailyCheck();
    expect(pending(t.published)).toEqual([]);
  });
});

describe('T505 — marcação falsa: `completeLink` recusado por assento depois de declarada', () => {
  const refuse = (t: ReturnType<typeof build>) => {
    t.mcp.verdict = { kind: 'denied', action: 'request_seat', title: null };
    return t.service.completeLink({ state: 'st', code: 'code-1' });
  };

  it('grava `seat_undeclared` (ator `system`) e avisa o Master `seat_missing` com autoReactivates=false', async () => {
    const t = build({ frozen: false }); // não congelado: sem a marcação falsa o autoReactivates seria true
    t.oauth.exchangeScope = DETAILS;
    await declare(t, true);
    t.published.length = 0;
    await expect(refuse(t)).rejects.toMatchObject({ redirectReason: 'access_denied' });
    expect(t.events.find((e) => e.kind === 'tactiq_link.seat_undeclared')).toMatchObject({ outcome: 'undeclared', ref: { actorUid: 'system' } });
    expect(t.published.filter((p) => p.reason === 'seat_missing').map((p) => [p.recipientUid, p.audience, p.autoReactivates])).toEqual([
      ['m-1', 'master', false], ['m-2', 'master', false],
    ]);
    await expect(t.repo.seatDeclared()).resolves.toBe(false);
  });

  it('repetir a recusa → a declaração já caiu: 0 `seat_undeclared` novos e 0 avisos novos', async () => {
    const t = build();
    await declare(t, true);
    await expect(refuse(t)).rejects.toBeDefined();
    const before = t.published.length;
    await expect(refuse(t)).rejects.toBeDefined();
    expect(t.events.filter((e) => e.kind === 'tactiq_link.seat_undeclared')).toHaveLength(1);
    expect(t.published).toHaveLength(before);
  });

  it('recusa SEM declaração prévia não grava `seat_undeclared`', async () => {
    const t = build();
    await expect(refuse(t)).rejects.toBeDefined();
    expect(t.events.some((e) => e.kind === 'tactiq_link.seat_undeclared')).toBe(false);
  });
});

describe('T506 — legado (D0.b): `seat_arrived` 1× por episódio, host `seat_ready firstLink=false`, sem revogação', () => {
  it('a marcação do Master sobre linha com escopo congelado `own` → seat_arrived + host firstLink=false; e NADA de firstLink=true', async () => {
    const t = build({ row: true, lastLinkScope: OWN });
    await declare(t, true);
    expect(t.events.map((e) => e.kind)).toEqual(['tactiq_link.seat_declared', 'tactiq_link.seat_arrived', 'tactiq_link.notified']);
    expect(ready(t.published)).toEqual([{ recipientUid: HOST_UID, reason: 'seat_ready', audience: 'host', firstLink: false }]);
    await declare(t, false);
    await declare(t, true);
    expect(t.events.filter((e) => e.kind === 'tactiq_link.seat_arrived')).toHaveLength(1);
    expect(ready(t.published)).toHaveLength(1);
  });

  it('o re-teste com `ready` sem `details` e escopo congelado → seat_arrived 1× e host firstLink=false; a linha segue broken (kept)', async () => {
    const t = build({ row: true, lastLinkScope: OWN });
    const s1 = await t.service.runDailyCheck();
    expect(s1).toMatchObject({ rechecked: 1, reactivated: 0 });
    expect(t.events.filter((e) => e.kind === 'tactiq_link.seat_arrived')).toEqual([expect.objectContaining({ ref: { source: 'recheck' } })]);
    expect(ready(t.published)).toEqual([{ recipientUid: HOST_UID, reason: 'seat_ready', audience: 'host', firstLink: false }]);
    await t.service.runDailyCheck();
    expect(t.events.filter((e) => e.kind === 'tactiq_link.seat_arrived')).toHaveLength(1);
    expect(ready(t.published)).toHaveLength(1);
  });

  it('o que vier primeiro vale: re-teste antes → a marcação depois não repete o aviso', async () => {
    const t = build({ row: true, lastLinkScope: OWN });
    await t.service.runDailyCheck();
    await declare(t, true);
    expect(t.events.filter((e) => e.kind === 'tactiq_link.seat_arrived')).toHaveLength(1);
    expect(ready(t.published)).toHaveLength(1);
  });

  it('escopo com `details` (perdeu e ganhou o assento) → o re-teste REATIVA e não há seat_arrived', async () => {
    const t = build({ row: true, lastLinkScope: DETAILS });
    const s = await t.service.runDailyCheck();
    expect(s).toMatchObject({ rechecked: 1, reactivated: 1 });
    expect(t.events.some((e) => e.kind === 'tactiq_link.seat_arrived')).toBe(false);
    expect(ready(t.published)).toEqual([]);
  });

  it('escopo NÃO congelado (P-C2 = sim) → sem seat_arrived', async () => {
    const t = build({ row: true, lastLinkScope: OWN, frozen: false });
    const s = await t.service.runDailyCheck();
    expect(s).toMatchObject({ rechecked: 1, reactivated: 1 }); // sem congelamento vale só o ready (F2)
    expect(t.events.some((e) => e.kind === 'tactiq_link.seat_arrived')).toBe(false);
  });
});

describe('F5 (D16) — o aviso `missing` ao host do teste diário só sai quando `canStartLink`', () => {
  const missingToHost = (p: Array<Record<string, unknown>>) => p.filter((x) => x.reason === 'missing');

  it('sem linha e SEM declaração → 0 aviso `missing` ao host e nenhum carimbo (nem claim, nem evento `notified`)', async () => {
    const t = build({ roster: true, claimMissing: true });
    const s = await t.service.runDailyCheck();
    expect(missingToHost(t.published)).toEqual([]);
    expect(t.repo.claimMissingNotification).not.toHaveBeenCalled();
    expect(t.events.filter((e) => e.kind === 'tactiq_link.notified' && e.reason === 'missing')).toEqual([]);
    expect(s.notified).toBe(0);
  });

  it('sem linha e declarado → 1 aviso `missing` ao host, carimbado como hoje', async () => {
    const t = build({ roster: true, claimMissing: true });
    await declare(t, true);
    const s = await t.service.runDailyCheck();
    expect(missingToHost(t.published)).toEqual([{ recipientUid: HOST_UID, reason: 'missing' }]);
    expect(t.repo.claimMissingNotification).toHaveBeenCalledTimes(1);
    expect(t.events.filter((e) => e.kind === 'tactiq_link.notified' && e.reason === 'missing')).toHaveLength(1);
    expect(s.notified).toBe(1);
  });

  it('com linha `broken` (legado, sem declaração) → o aviso de hoje (claimNotification), sem depender da declaração', async () => {
    const t = build({ roster: true, row: true, lastLinkScope: OWN });
    t.repo.claimNotification.mockResolvedValue(true);
    await t.service.runDailyCheck();
    expect(t.repo.claimNotification).toHaveBeenCalledTimes(1);
    expect(t.published.filter((x) => x.audience === 'host' && x.recipientUid === HOST_UID)).not.toHaveLength(0);
  });
});
