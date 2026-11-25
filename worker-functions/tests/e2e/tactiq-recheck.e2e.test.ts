/**
 * tactiq-recheck.e2e.test.ts — change tactiq-vinculo-resiliente, F2: o teste diário re-testa `broken`/`wrong_account` com token e
 * reativa o vínculo sozinho, contra POSTGRES REAL (SQL de `listRecheckableWithToken`, `lastLinkScope`, `rotateTokenIfUnchanged`,
 * `reactivate`, `latestLinkAttempt`). Serviço e repositório REAIS; só o Tactiq (OAuth e MCP) é dublê, programado POR TOKEN
 * (nenhum estado global: o `runDailyCheck` olha a tabela inteira). O KMS roda em passthrough base64 (NODE_ENV=test).
 * Dados SINTÉTICOS (@example.test); nenhum canal real. Os eventos `tactiq_link.*` são append-only: todo e-mail leva o sufixo da rodada.
 *
 * (a) linha NASCIDA NA RECUSA (`completeLink` real, `request_seat`) → `linked` no diário, sem outro `completeLink`
 * (b) `wrong_account` legado → `linked` · (c) `invalid_grant` → `recheck_dead`, a 2ª rodada não renova
 * (d) item 083 `blocked`/`no_link` reabre depois da reativação · (e) segredo trocado entre leitura e rotação → não reativa
 * (f) escopo congelado + `own` na renovação → continua `broken`, mas o token rotacionado fica guardado
 */
import { Pool } from 'pg';
import type { AccessVerdict, TactiqTokenSet } from '../../src/modules/matching/application/ports/TactiqPorts';
import { TactiqAccessDeniedError, TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import { TactiqLinkRepository } from '../../src/modules/matching/infrastructure/TactiqLinkRepository';
import { AdmissionImportRepository } from '../../src/modules/matching/infrastructure/AdmissionImportRepository';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { declareTactiqSeat } from './helpers/tactiqSeatFixture';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = Date.now().toString(36);
const SUFFIX = `.${RUN}@recheck-e2e.example.test`;
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8');
const MIN = 60_000;
const H = 60 * MIN;
const OWN = 'mcp:meetings:own';
const DETAILS = 'mcp:meetings:own mcp:meetings:details';
const BASE = new Date('2026-10-01T12:00:00Z');
const at = (deltaMs: number): Date => new Date(BASE.getTime() + deltaMs);

/** OAuth programado POR TOKEN: rotação, escopo da renovação e um gancho que roda antes de responder (a corrida do caso e). */
class ScriptedOAuth extends FakeTactiqOAuth {
  readonly rotations = new Map<string, string>();
  readonly scopes = new Map<string, string>();
  readonly beforeRefresh = new Map<string, () => Promise<void>>();
  async refresh(token: string): Promise<TactiqTokenSet> {
    const base = await super.refresh(token);
    await this.beforeRefresh.get(token)?.();
    const rotated = this.rotations.get(token);
    const scope = this.scopes.get(token);
    return { ...base, ...(rotated ? { refreshToken: rotated } : {}), ...(scope ? { scope } : {}) };
  }
}

/** MCP com veredito POR access token; quem não está no mapa é `ready` (não derruba o que é de outra suíte). */
class ScriptedMcp extends FakeTactiqMcp {
  readonly verdicts = new Map<string, AccessVerdict>();
  async ping(accessToken: string): Promise<AccessVerdict> {
    const programmed = this.verdicts.get(accessToken);
    if (programmed) {
      this.pingTokens.push(accessToken);
      return programmed;
    }
    return super.ping(accessToken);
  }
}

describe('re-teste diário do vínculo do Tactiq — Postgres real (change tactiq-vinculo-resiliente, F2)', () => {
  let admin: Pool;
  let oauth: ScriptedOAuth;
  let mcp: ScriptedMcp;
  let clock = at(0);
  let seq = 0;
  let counter = 0;
  const logs = capturingLogger();

  const service = (frozen = true): TactiqLinkService =>
    new TactiqLinkService({
      repo: new TactiqLinkRepository(admin), oauth, mcp, db: admin, log: logs.log, now: () => clock,
      clientId: () => 'mcp-cliente-e2e', consentScopeFrozen: frozen,
    });

  const email = (tag: string): string => `${tag}${(seq += 1)}${SUFFIX}`;
  /** Linha não-`linked` com o segredo do token dado e o evento de queda que a D3 lê. */
  async function seedLink(
    host: string,
    opts: { status: 'broken' | 'wrong_account'; token: string; drop: { kind: string; reason: string; ref?: Record<string, unknown> } },
  ): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at, missing_since, last_notified_status)
       VALUES ($1, $2, $3, $4, $4, NULL) RETURNING id`, [host, `uid-recheck-${RUN}`, opts.status, at(0)]);
    await admin.query(`INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1, $2)`, [rows[0].id, b64(opts.token)]);
    await new TactiqLinkRepository(admin).appendEvent({ email: host, kind: opts.drop.kind, outcome: opts.status, reason: opts.drop.reason, at: at(MIN), ref: opts.drop.ref ?? null });
    return rows[0].id;
  }
  const linkRow = async (host: string) =>
    (await admin.query(
      `SELECT l.status, l.status_changed_at, s.refresh_token_encrypted AS secret
         FROM tactiq_links l LEFT JOIN tactiq_link_secrets s ON s.link_id = l.id WHERE lower(l.host_email) = lower($1)`, [host])).rows[0] as
      { status: string; status_changed_at: Date; secret: string | null } | undefined;
  const trail = async (host: string, like = 'tactiq_link.%') =>
    (await admin.query(`SELECT kind, reason, ref FROM admission_events WHERE lower(host_email) = lower($1) AND kind LIKE $2 ORDER BY at, id`, [host, like]))
      .rows as Array<{ kind: string; reason: string | null; ref: Record<string, unknown> | null }>;

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL, max: 4 });
  });
  beforeEach(() => {
    oauth = new ScriptedOAuth();
    mcp = new ScriptedMcp();
    clock = at(H);
  });
  afterAll(async () => {
    await admin.query(`DELETE FROM admission_appointments WHERE host_email LIKE $1`, [`%${SUFFIX}`]);
    await admin.query(`DELETE FROM tactiq_oauth_states WHERE host_email LIKE $1`, [`%${SUFFIX}`]);
    await admin.query(`DELETE FROM tactiq_links WHERE host_email LIKE $1`, [`%${SUFFIX}`]);
    await admin.end();
  });

  it('(a) linha NASCIDA NA RECUSA (`completeLink` real, request_seat) → `linked` no diário, sem outro completeLink; segredo = token novo; 1 `reactivated`', async () => {
    const host = email('a');
    const code = `rt-a-${RUN}`;
    oauth.exchangeScope = DETAILS;
    oauth.rotations.set(code, `${code}-novo`);
    mcp.verdicts.set(`at-${code}`, { kind: 'denied', action: 'request_seat', title: null });
    const svc = service();
    await declareTactiqSeat(admin, host); // F5 (D16): sem linha prévia o início do vínculo exige a licença declarada
    const { authorizeUrl } = await svc.startLink({ uid: `uid-recheck-${RUN}`, email: host });
    await expect(svc.completeLink({ state: new URL(authorizeUrl).searchParams.get('state')!, code })).rejects.toBeInstanceOf(TactiqAccessDeniedError);
    expect(await linkRow(host)).toMatchObject({ status: 'broken' });
    expect(unb64((await linkRow(host))!.secret!)).toBe(code);

    mcp.verdicts.delete(`at-${code}`); // a conta ganhou o assento
    const summary = await svc.runDailyCheck();

    expect(summary.reactivated).toBeGreaterThanOrEqual(1);
    const row = await linkRow(host);
    expect(row?.status).toBe('linked');
    expect(unb64(row!.secret!)).toBe(`${code}-novo`);
    expect(oauth.exchangeCalls).toHaveLength(1); // nenhum `completeLink` no meio
    const reactivated = (await trail(host)).filter((e) => e.kind === 'tactiq_link.reactivated');
    expect(reactivated).toEqual([expect.objectContaining({ ref: { from: 'broken' } })]);
    expect((await svc.getOwn(host)).accessDenial).toBeNull();
  });

  it('(b) `wrong_account` legado → `linked`', async () => {
    const host = email('b');
    const token = `rt-b-${RUN}`;
    await seedLink(host, { status: 'wrong_account', token, drop: { kind: 'tactiq_link.wrong_account', reason: 'meeting_not_visible' } });
    await service().runDailyCheck();
    expect((await linkRow(host))?.status).toBe('linked');
    expect((await trail(host)).filter((e) => e.kind === 'tactiq_link.reactivated')).toEqual([expect.objectContaining({ ref: { from: 'wrong_account' } })]);
  });

  it('(c) `invalid_grant` → `recheck_dead` e a 2ª rodada não renova', async () => {
    const host = email('c');
    const token = `rt-c-${RUN}`;
    await seedLink(host, { status: 'broken', token, drop: { kind: 'tactiq_link.broken', reason: 'unauthorized' } });
    oauth.invalidate(token);
    const svc = service();
    await svc.runDailyCheck();
    await svc.runDailyCheck();
    expect(oauth.refreshCalls.filter((t) => t === token)).toHaveLength(1);
    expect((await linkRow(host))?.status).toBe('broken');
    expect((await trail(host)).filter((e) => e.kind === 'tactiq_link.recheck_dead')).toEqual([expect.objectContaining({ reason: 'invalid_grant' })]);
  });

  it('(d) item 083 `blocked`/`no_link` reabre na rodada seguinte da importação depois da reativação', async () => {
    const host = email('d');
    const token = `rt-d-${RUN}`;
    await seedLink(host, { status: 'broken', token, drop: { kind: 'tactiq_link.broken', reason: 'unauthorized' } });
    counter += 1;
    const admissionCode = `ADM-${(1_000_000 + (Date.now() % 9_000_000) + counter).toString(36).toUpperCase().slice(-6).padStart(6, '0')}`;
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO admission_appointments (country, host_email, slot_start, slot_end, status, admission_code, conference_ended_at, import_status)
       VALUES ('AR', $1, $2, $3, 'booked', $4, $5, 'blocked') RETURNING id`, [host, at(-H), at(-30 * MIN), admissionCode, BASE]);
    const blockedAt = at(10 * MIN);
    await admin.query(`INSERT INTO admission_events (appointment_id, at, kind, reason) VALUES ($1, $2, 'import_blocked', 'no_link')`, [rows[0].id, blockedAt]);
    const queue = new AdmissionImportRepository(admin);
    const agora = at(2 * H);

    expect((await queue.listDueIds(agora, 1000)).includes(rows[0].id)).toBe(false); // bloqueado, sem vínculo: espera
    clock = at(H); // a reativação acontece DEPOIS do bloqueio
    await service().runDailyCheck();
    expect((await linkRow(host))?.status).toBe('linked');
    expect((await queue.listDueIds(agora, 1000)).includes(rows[0].id)).toBe(true); // `status_changed_at` andou: reabriu
  });

  it('(e) segredo trocado entre a leitura e a rotação (revínculo concorrente) → não reativa', async () => {
    const host = email('e');
    const token = `rt-e-${RUN}`;
    await seedLink(host, { status: 'broken', token, drop: { kind: 'tactiq_link.broken', reason: 'unauthorized' } });
    oauth.rotations.set(token, `${token}-novo`);
    oauth.beforeRefresh.set(token, async () => {
      await admin.query(
        `UPDATE tactiq_link_secrets SET refresh_token_encrypted = $2 FROM tactiq_links l WHERE l.id = link_id AND lower(l.host_email) = lower($1)`,
        [host, b64(`${token}-concorrente`)]);
    });
    await service().runDailyCheck();
    const row = await linkRow(host);
    expect(row?.status).toBe('broken');
    expect(unb64(row!.secret!)).toBe(`${token}-concorrente`); // o CAS não pisou no revínculo
    expect((await trail(host)).filter((e) => e.kind === 'tactiq_link.reactivated')).toEqual([]);
  });

  it('(f) escopo congelado + `own` na renovação → continua `broken` (o token rotacionado fica guardado); descongelado reativa', async () => {
    const host = email('f');
    const token = `rt-f-${RUN}`;
    await seedLink(host, { status: 'broken', token, drop: { kind: 'tactiq_link.broken', reason: 'access_action:request_seat', ref: { source: 'link', scope: OWN } } });
    oauth.scopes.set(token, OWN);
    oauth.rotations.set(token, `${token}-novo`);
    await service(true).runDailyCheck();
    const row = await linkRow(host);
    expect(row?.status).toBe('broken');
    expect(unb64(row!.secret!)).toBe(`${token}-novo`);
    expect((await trail(host)).filter((e) => e.kind === 'tactiq_link.reactivated')).toEqual([]);

    // controle: o `scope` da renovação é autoritativo, então `details` nele reativa mesmo congelado
    oauth.scopes.set(`${token}-novo`, DETAILS);
    await service(true).runDailyCheck();
    expect((await linkRow(host))?.status).toBe('linked');
  });
});
