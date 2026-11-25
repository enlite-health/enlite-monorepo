/**
 * Recusa por assento no ATO de vincular → cópia ao Acesso Master, 1× por episódio (change tactiq-vinculo-resiliente, F3/T306, design D12).
 * Repositório e publicador em memória; a prova em SQL real (trava, trilha) é o e2e `tactiq-seat-notice.e2e.test.ts`.
 */
import type { Pool } from 'pg';
import type { TactiqLinkRepository } from '../../infrastructure/TactiqLinkRepository';
import type { ChromeReportRepository } from '../../infrastructure/ChromeReportRepository';
import type { SystemNotificationPublisher } from '@modules/inapp-notification/application/SystemNotificationPublisher';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../infrastructure/doubles/FakeTactiq';
import { TactiqAccessDeniedError, TactiqLinkService } from '../TactiqLinkService';

jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({}),
}));

const HOST = 'host.fake@enlite.test';
const HOST_UID = 'uid-host';
const HOST_NAME = 'Fulana Fake';
const OWN = 'mcp:meetings:own';
const DETAILS = 'mcp:meetings:own mcp:meetings:details';
type Ev = { email: string; kind: string; outcome?: string | null; reason?: string | null; at: Date; ref?: Record<string, unknown> | null };

function build(o: { masters?: string[]; frozen?: boolean; scope?: string; mastersFail?: boolean } = {}) {
  const events: Ev[] = [];
  const masters = o.masters ?? ['m-1', 'm-2'];
  const episodeNotified = () => {
    const e = [...events].reverse().find(
      (x) => ['tactiq_link.linked', 'tactiq_link.reactivated'].includes(x.kind) || (x.kind === 'tactiq_link.notified' && x.reason === 'seat_missing_master' && x.outcome === 'sent'),
    );
    return e?.kind === 'tactiq_link.notified';
  };
  const repo = {
    consumeOAuthState: jest.fn().mockResolvedValue({ email: HOST, uid: HOST_UID, verifierEncrypted: 'venc' }),
    upsertLinked: jest.fn().mockResolvedValue(undefined),
    insertBrokenFromRejection: jest.fn().mockResolvedValue(true),
    appendEvent: jest.fn(async (e: Ev) => void events.push(e)),
    claimSeatEpisode: jest.fn(async () => !episodeNotified()),
    activeMasterUids: jest.fn(async () => {
      if (o.mastersFail) throw Object.assign(new Error('boom'), { code: 'XX000' });
      return masters;
    }),
    hostDisplayName: jest.fn(async () => HOST_NAME),
  };
  const published: Array<Record<string, unknown>> = [];
  const publisher = { publishAdmissionTactiqLinkRequired: jest.fn(async (_c: unknown, input: Record<string, unknown>) => void published.push(input)) };
  const oauth = new FakeTactiqOAuth();
  oauth.exchangeScope = o.scope ?? OWN;
  const mcp = new FakeTactiqMcp();
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new TactiqLinkService({
    repo: repo as unknown as TactiqLinkRepository,
    chromeReports: {} as ChromeReportRepository,
    oauth,
    mcp,
    db: {} as Pool,
    publisher: publisher as unknown as SystemNotificationPublisher,
    cipher: { encrypt: jest.fn(async (s: string) => `enc:${s}`), decrypt: jest.fn(async () => 'verifier') },
    log,
    ...(o.frozen !== undefined ? { consentScopeFrozen: o.frozen } : {}),
  });
  return { service, mcp, repo, events, published, log };
}

const refuse = (t: ReturnType<typeof build>, action = 'request_seat') => {
  t.mcp.verdict = { kind: 'denied', action, title: null };
  return t.service.completeLink({ state: 'st', code: 'code-1' });
};
const sent = (events: Ev[]) => events.filter((e) => e.kind === 'tactiq_link.notified' && e.outcome === 'sent');

describe('completeLink — recusa por assento avisa o Acesso Master 1× por episódio (F3/T306)', () => {
  it('1ª recusa → 1 aviso por master (sem o host), com nome e autoReactivates; o redirect da recusa segue igual', async () => {
    const t = build({ scope: DETAILS });
    await expect(refuse(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(t.published).toEqual([
      { recipientUid: 'm-1', reason: 'seat_missing', audience: 'master', hostName: HOST_NAME, autoReactivates: true },
      { recipientUid: 'm-2', reason: 'seat_missing', audience: 'master', hostName: HOST_NAME, autoReactivates: true },
    ]);
    expect(sent(t.events)).toEqual([expect.objectContaining({ reason: 'seat_missing_master', ref: { source: 'link', recipients: 2 } })]);
  });

  it('o host que é Master não recebe a própria cópia', async () => {
    const t = build({ masters: ['m-1', HOST_UID] });
    await expect(refuse(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(t.published.map((p) => p.recipientUid)).toEqual(['m-1']);
  });

  it('2ª recusa no mesmo episódio → 0 avisos novos', async () => {
    const t = build();
    await expect(refuse(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    await expect(refuse(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(t.published).toHaveLength(2);
    expect(sent(t.events)).toHaveLength(1);
  });

  it.each(['tactiq_link.linked', 'tactiq_link.reactivated'])('`%s` depois do aviso e nova recusa → 1 aviso novo por master (episódio novo)', async (kind) => {
    const t = build();
    await expect(refuse(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    t.events.push({ email: HOST, kind, outcome: 'linked', at: new Date() });
    await expect(refuse(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(t.published).toHaveLength(4);
    expect(sent(t.events)).toHaveLength(2);
  });

  it('recusa por `upgrade` (não é assento) → 0 avisos e nenhuma consulta de Master', async () => {
    const t = build();
    await expect(refuse(t, 'upgrade')).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(t.published).toEqual([]);
    expect(t.repo.claimSeatEpisode).not.toHaveBeenCalled();
    expect(t.repo.activeMasterUids).not.toHaveBeenCalled();
  });

  it('escopo congelado + consentimento `own` → autoReactivates=false (o Tactiq não amplia a autorização)', async () => {
    const t = build({ frozen: true, scope: OWN });
    await expect(refuse(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(t.published.map((p) => p.autoReactivates)).toEqual([false, false]);
  });

  it('escopo NÃO congelado + `own` → autoReactivates=true; congelado + `details` → true', async () => {
    const a = build({ frozen: false, scope: OWN });
    await expect(refuse(a)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(a.published.map((p) => p.autoReactivates)).toEqual([true, true]);
    const b = build({ frozen: true, scope: DETAILS });
    await expect(refuse(b)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(b.published.map((p) => p.autoReactivates)).toEqual([true, true]);
  });

  it('0 masters vivos → evento `no_recipient` + warn sem PII; a recusa segue', async () => {
    const t = build({ masters: [] });
    await expect(refuse(t)).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(t.published).toEqual([]);
    expect(t.events.filter((e) => e.kind === 'tactiq_link.notified')).toEqual([expect.objectContaining({ outcome: 'no_recipient', reason: 'seat_missing_master' })]);
    expect(t.log.warn).toHaveBeenCalledWith({}, 'admission.tactiq_link.master_notice.no_recipient');
  });

  it('falha ao avisar NÃO derruba a recusa (o redirect certo sai) e vai ao log sem e-mail nem nome', async () => {
    const t = build({ mastersFail: true });
    await expect(refuse(t)).rejects.toMatchObject({ redirectReason: 'access_denied' });
    expect(t.log.error).toHaveBeenCalledWith({ reason: 'XX000' }, 'admission.tactiq_link.master_notice.failed');
    const logged = JSON.stringify([t.log.info.mock.calls, t.log.warn.mock.calls, t.log.error.mock.calls]);
    expect(logged).not.toContain(HOST);
    expect(logged).not.toContain(HOST_NAME);
  });
});
