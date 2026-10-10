/**
 * admission-049-tactiq-link.e2e.test.ts — spec 049, F4: o vínculo do responsável com o Tactiq contra POSTGRES REAL,
 * HTTP real, com o ENGINE DE PERMISSÃO LIGADO (`admin.users`). Só o Tactiq (OAuth e MCP) é dublê — injetado nos MESMOS
 * serviços que o `index.ts` monta. O KMS roda em passthrough base64 (NODE_ENV=test), então "cifrado ≠ texto" prova que o
 * valor passou pela cifra e é decifrável de volta ao token dublado. Dados SINTÉTICOS (@example.test); nada toca canal real.
 *
 * Bloco 1 (sempre roda, é o que o CI executa): A4-1 a A4-9 (o A4-3, a trava no POST de agenda, está em
 *   `admission-049-admin-routes.e2e.test.ts`).
 * Bloco 2 (só com a stack de engine ligado — `E2E_ABAC_STACK=1`, API em container com ADMISSION_EXTERNALS=fake,
 *   PERMISSION_ENGINE_ENABLED, PERMISSION_CATALOG_SYNC_ENABLED): as 5 células no catálogo SINCRONIZADO e o fluxo pelo
 *   `index.ts` de verdade, com os papéis de banco reais (o runtime não lê o token).
 *
 * Os eventos `tactiq_link.*` são append-only (nunca se apagam): todo e-mail leva o sufixo da rodada.
 */
import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';
import { FakeTactiqMcp, FakeTactiqOAuth } from '../../src/modules/matching/infrastructure/doubles/FakeTactiq';
import { capturingLogger } from '../../src/modules/matching/infrastructure/doubles/admissionTestKit';
import { TactiqTransientError, TactiqUnauthorizedError } from '../../src/modules/matching/application/ports/TactiqPorts';
import type { TactiqLinkService } from '../../src/modules/matching/application/TactiqLinkService';
import { pkceChallenge } from '../../src/modules/matching/infrastructure/tactiq/pkce';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const API_URL = process.env.API_URL || 'http://localhost:8080';

const RUN = Date.now().toString(36);
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s: string): string => Buffer.from(s, 'base64').toString('utf8');
const HOUR = 3_600_000;

const U = {
  linker: `tq049-linker-${RUN}`, // own_tactiq_link: read + create
  reader: `tq049-reader-${RUN}`, // own_tactiq_link: read
  semGrupo: `tq049-sem-grupo-${RUN}`, // staff sem célula
};
const GRUPOS = { linker: `Tq049 Linker ${RUN}`, reader: `Tq049 Reader ${RUN}` };
const emailOf = (uid: string): string => `${uid}@e2e.local`;

describe('vínculo do Tactiq — HTTP real, banco real, engine LIGADO (spec 049, F4)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let oauth: FakeTactiqOAuth;
  let mcp: FakeTactiqMcp;
  let service: TactiqLinkService;
  let logs: ReturnType<typeof capturingLogger>;
  let clock = new Date();
  const loggerCalls: string[] = [];
  let loggerSpies: jest.SpyInstance[] = [];
  const hostEmails: string[] = [];
  const hostUids: string[] = [];
  let seq = 0;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(k: string, v: string | undefined): void {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  async function http(method: string, path: string, uid: string | null, body?: unknown) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {}), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, location: res.headers.get('location'), body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  /** Operadora do roster com usuário (recebe o sino) e, opcionalmente, vínculo já gravado. */
  async function newHost(opts: { user?: boolean; link?: { status: 'linked' | 'broken' | 'wrong_account'; token?: string; statusChangedAt?: Date; missingSince?: Date } } = {}) {
    seq += 1;
    const email = `op${seq}.${RUN}@example.test`;
    const uid = `tq049-op${seq}-${RUN}`;
    const { rows } = await admin.query(
      `INSERT INTO interview_hosts (email, display_name, country, active) VALUES ($1,'Operadora Sintetica','AR',true) RETURNING id`,
      [email],
    );
    hostEmails.push(email);
    if (opts.user !== false) {
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`,
        [uid, email, TENANT_E2E],
      );
      hostUids.push(uid);
    }
    if (opts.link) {
      const token = opts.link.token ?? `rt-seed-${seq}-${RUN}`;
      const ins = await admin.query(
        `INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at, missing_since, last_notified_status)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [
          email, uid, opts.link.status,
          opts.link.statusChangedAt ?? clock, opts.link.missingSince ?? null, opts.link.status === 'linked' ? 'linked' : null,
        ],
      );
      if (opts.link.status === 'linked') {
        await admin.query(`INSERT INTO tactiq_link_secrets (link_id, refresh_token_encrypted) VALUES ($1,$2)`, [ins.rows[0].id, b64(token)]);
      }
    }
    return { id: rows[0].id as string, email, uid };
  }

  const linkRow = async (email: string) => (await admin.query(
    `SELECT l.*, s.refresh_token_encrypted FROM tactiq_links l LEFT JOIN tactiq_link_secrets s ON s.link_id = l.id WHERE lower(l.host_email) = lower($1)`, [email])).rows[0];
  const sino = async (uid: string) =>
    (await admin.query(
      `SELECT e.type_code, e.actor_uid, e.payload, e.patient_id FROM notifications n JOIN notification_events e ON e.id = n.event_id WHERE n.recipient_uid = $1 ORDER BY n.created_at, e.id`,
      [uid],
    )).rows as Array<{ type_code: string; actor_uid: string; payload: { reason: string }; patient_id: string | null }>;
  const eventKinds = async (email: string, like = 'tactiq_link.%') =>
    (await admin.query(`SELECT kind, reason FROM admission_events WHERE lower(host_email) = lower($1) AND kind LIKE $2 ORDER BY at, kind`, [email, like])).rows as Array<{ kind: string; reason: string | null }>;
  const alarmLines = () =>
    logs.output().split('\n').filter((l) => l.includes('admission.tactiq_link.missing_48h')).map((l) => JSON.parse(l) as { hostId: string; state: string; hoursWithoutLink: number });

  async function limparIam(): Promise<void> {
    await limparIamFixtures(admin, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparIam();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('TACTIQ_LINK_RETURN_URL', undefined);

    await admin.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,$4,'admin','ACTIVE',true,$7), ($2,$5,'admin','ACTIVE',true,$7), ($3,$6,'admin','ACTIVE',true,$7)`,
      [U.linker, U.reader, U.semGrupo, emailOf(U.linker), emailOf(U.reader), emailOf(U.semGrupo), TENANT_E2E],
    );
    await grupoComCelulas(admin, { nome: GRUPOS.linker, uid: U.linker, celulas: [['own_tactiq_link', 'read'], ['own_tactiq_link', 'create']] });
    await grupoComCelulas(admin, { nome: GRUPOS.reader, uid: U.reader, celulas: [['own_tactiq_link', 'read']] });

    oauth = new FakeTactiqOAuth();
    mcp = new FakeTactiqMcp();
    logs = capturingLogger();

    const { logger } = await import('@shared/logging');
    loggerSpies = (['info', 'warn', 'error', 'debug'] as const).map((lvl) =>
      jest.spyOn(logger as never, lvl as never).mockImplementation(((...a: unknown[]) => { loggerCalls.push(JSON.stringify(a)); }) as never),
    );

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { TactiqLinkService: Svc } = await import('../../src/modules/matching/application/TactiqLinkService');
        const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
        const { TactiqLinkController } = await import('../../src/modules/matching/interfaces/controllers/TactiqLinkController');
        const { TactiqCheckInternalController } = await import('../../src/modules/matching/interfaces/controllers/TactiqCheckInternalController');
        const routes = await import('../../src/modules/matching/interfaces/routes/tactiqLinkRoutes');
        const pool = DatabaseConnection.getInstance().getPool();
        service = new Svc({
          repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, log: logs.log,
          clientId: () => 'mcp-cliente-e2e', now: () => clock,
        });
        const controller = new TactiqLinkController(service);
        express.use('/api/admin', routes.createTactiqLinkRoutes(auth, permissions, controller));
        express.use('/api/admin', routes.createTactiqLinkCallbackRoute(controller, (_req, _res, next) => next()));
        express.use('/api/internal', routes.createTactiqCheckInternalRoutes(new TactiqCheckInternalController(service)));
      },
    });
  }, 60000);

  afterAll(async () => {
    loggerSpies.forEach((s) => s.mockRestore());
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    const uids = [...hostUids, ...Object.values(U)];
    await admin.query(
      `DELETE FROM notifications WHERE recipient_uid = ANY($1)`, [uids]);
    await admin.query(
      `DELETE FROM notification_events e WHERE e.type_code = 'ADMISSION_TACTIQ_LINK_REQUIRED' AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_id = e.id)`);
    const all = [...hostEmails, emailOf(U.linker), emailOf(U.reader)];
    await admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)`, [all]);
    await admin.query(`DELETE FROM tactiq_oauth_states WHERE host_email = ANY($1)`, [all]);
    await admin.query('DELETE FROM interview_hosts WHERE email = ANY($1)', [hostEmails]);
    await admin.query('DELETE FROM users WHERE firebase_uid = ANY($1)', [hostUids]);
    await limparIam();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    clock = new Date();
    mcp.pingError = null;
  });

  it('0. sanidade: as tabelas da 505/508 (links, secrets, oauth_states) existem, as 2 células estão no catálogo e o dublê do OAuth é o do teste', async () => {
    const t = await admin.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name IN ('tactiq_links','tactiq_link_secrets','tactiq_oauth_states')`);
    expect(t.rows[0].n).toBe(3);
    const c = await admin.query(`SELECT count(*)::int AS n FROM iam.permissions WHERE resource = 'own_tactiq_link'`);
    expect(c.rows[0].n).toBe(2);
    expect(oauth).toBeInstanceOf(FakeTactiqOAuth);
  });

  describe('A4-1 / A4-2 — vincular: OAuth PKCE (cliente público), token cifrado, state de uso único', () => {
    let state: string;
    let challenge: string;
    const TOKEN = `rt-dublado-${RUN}`;

    it('POST /me/tactiq-link → authorizeUrl com state e desafio S256; o banco guarda o HASH do state e o verifier CIFRADO', async () => {
      const res = await http('POST', '/api/admin/me/tactiq-link', U.linker);
      expect(res.status).toBe(200);
      const url = new URL(res.body.data.authorizeUrl as string);
      state = url.searchParams.get('state')!;
      challenge = url.searchParams.get('code_challenge')!;
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const rows = (await admin.query(`SELECT * FROM tactiq_oauth_states WHERE host_email = $1`, [emailOf(U.linker)])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].state_hash).not.toBe(state);
      expect(rows[0].state_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].firebase_uid).toBe(U.linker);
      expect(rows[0].consumed_at).toBeNull();
      // 10 min de validade, a partir do relógio injetado
      expect(new Date(rows[0].expires_at).getTime() - clock.getTime()).toBeGreaterThan(9 * 60_000);
      expect(new Date(rows[0].expires_at).getTime() - clock.getTime()).toBeLessThanOrEqual(10 * 60_000 + 5_000);
      // o verifier decifrado bate com o desafio publicado (PKCE coerente) e NÃO está em claro na coluna
      const verifier = unb64(rows[0].code_verifier_encrypted);
      expect(pkceChallenge(verifier)).toBe(challenge);
      expect(rows[0].code_verifier_encrypted).not.toBe(verifier);
      expect(JSON.stringify(res.body)).not.toContain(verifier);
    });

    it('A4-2: state ADULTERADO → 400 e NADA gravado (sem vínculo, sem troca de código, state legítimo segue de pé)', async () => {
      const exchanges = oauth.exchangeCalls.length;
      const tampered = `${state.slice(0, -1)}${state.endsWith('A') ? 'B' : 'A'}`;
      const res = await http('GET', `/api/admin/me/tactiq-link/callback?code=${TOKEN}&state=${tampered}`, null);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'TACTIQ_STATE_INVALID' });
      expect(await linkRow(emailOf(U.linker))).toBeUndefined();
      expect(oauth.exchangeCalls.length).toBe(exchanges);
      expect((await admin.query(`SELECT consumed_at FROM tactiq_oauth_states WHERE host_email = $1`, [emailOf(U.linker)])).rows[0].consumed_at).toBeNull();
    });

    it('A4-2: callback sem code ou sem state → 400 (o serviço nem é chamado)', async () => {
      expect((await http('GET', `/api/admin/me/tactiq-link/callback?state=${state}`, null)).status).toBe(400);
      expect((await http('GET', `/api/admin/me/tactiq-link/callback?code=${TOKEN}`, null)).status).toBe(400);
      expect((await http('GET', `/api/admin/me/tactiq-link/callback`, null)).status).toBe(400);
    });

    it('A4-1: callback LEGÍTIMO (sem Bearer — é o browser) → vinculado; refresh_token_encrypted ≠ token dublado e decifra para ele; o verifier chega à troca', async () => {
      const res = await http('GET', `/api/admin/me/tactiq-link/callback?code=${TOKEN}&state=${state}`, null);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, data: { status: 'linked' } });
      expect(JSON.stringify(res.body)).not.toContain(TOKEN);

      const row = await linkRow(emailOf(U.linker));
      expect(row).toMatchObject({ status: 'linked', firebase_uid: U.linker, client_id: 'mcp-cliente-e2e', last_notified_status: 'linked' });
      expect(row.refresh_token_encrypted).not.toBe(TOKEN);
      expect(unb64(row.refresh_token_encrypted)).toBe(TOKEN);

      const call = oauth.exchangeCalls[oauth.exchangeCalls.length - 1];
      expect(call.code).toBe(TOKEN);
      expect(pkceChallenge(call.codeVerifier)).toBe(challenge);
      expect((await eventKinds(emailOf(U.linker))).map((e) => e.kind)).toEqual(['tactiq_link.linked']);
    });

    it('A4-2: o MESMO state de novo (uso único) → 400 e o vínculo não muda', async () => {
      const before = await linkRow(emailOf(U.linker));
      const res = await http('GET', `/api/admin/me/tactiq-link/callback?code=rt-outro-${RUN}&state=${state}`, null);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'TACTIQ_STATE_INVALID' });
      expect((await linkRow(emailOf(U.linker))).refresh_token_encrypted).toBe(before.refresh_token_encrypted);
    });

    it('A4-1: GET /me/tactiq-link devolve o estado e NUNCA o token (nem em claro, nem cifrado, nem a coluna)', async () => {
      const row = await linkRow(emailOf(U.linker));
      const res = await http('GET', '/api/admin/me/tactiq-link', U.linker);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'linked' });
      const json = JSON.stringify(res.body);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain(row.refresh_token_encrypted);
      expect(json).not.toContain('refresh_token');
      expect(json).not.toContain('rt-dublado');
    });

    it('A4-2: state VENCIDO (10 min) → 400, nada gravado, state continua não consumido', async () => {
      const u = await newHost({ user: false });
      const t0 = new Date();
      clock = t0;
      // inicia o vínculo como a operadora de teste: usa o serviço direto (o POST HTTP está provado acima)
      const { authorizeUrl } = await service.startLink({ uid: `tq049-exp-${RUN}`, email: u.email });
      const st = new URL(authorizeUrl).searchParams.get('state')!;
      clock = new Date(t0.getTime() + 10 * 60_000 + 1_000);
      const res = await http('GET', `/api/admin/me/tactiq-link/callback?code=rt-tarde-${RUN}&state=${st}`, null);
      expect(res.status).toBe(400);
      expect(await linkRow(u.email)).toBeUndefined();
      expect((await admin.query(`SELECT consumed_at FROM tactiq_oauth_states WHERE host_email = $1`, [u.email])).rows[0].consumed_at).toBeNull();
    });

    it('troca de código recusada pelo Tactiq (invalid_grant) → 502 com code estável, sem vínculo; o state foi gasto', async () => {
      const u = await newHost({ user: false });
      const { authorizeUrl } = await service.startLink({ uid: `tq049-bad-${RUN}`, email: u.email });
      const st = new URL(authorizeUrl).searchParams.get('state')!;
      const res = await http('GET', `/api/admin/me/tactiq-link/callback?code=bad-code&state=${st}`, null);
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ code: 'TACTIQ_EXCHANGE_FAILED', reason: 'invalid_grant' });
      expect(await linkRow(u.email)).toBeUndefined();
    });

    it('ABAC (engine ligado): sem a célula → 403 missing_cell; só-leitura lê (200) mas NÃO inicia (403) e nada é gravado', async () => {
      const states = (await admin.query(`SELECT count(*)::int AS n FROM tactiq_oauth_states`)).rows[0].n;
      expect((await http('GET', '/api/admin/me/tactiq-link', U.semGrupo)).status).toBe(403);
      const post = await http('POST', '/api/admin/me/tactiq-link', U.semGrupo);
      expect(post.status).toBe(403);
      expect(['no_group', 'missing_cell']).toContain(post.body.code); // staff sem NENHUM grupo é `no_group`; com grupo e sem a célula, `missing_cell`
      expect((await http('GET', '/api/admin/me/tactiq-link', U.reader)).status).toBe(200);
      const denied = await http('POST', '/api/admin/me/tactiq-link', U.reader);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'missing_cell' });
      expect((await admin.query(`SELECT count(*)::int AS n FROM tactiq_oauth_states`)).rows[0].n).toBe(states);
      // quem nunca vinculou lê `missing`
      expect((await http('GET', '/api/admin/me/tactiq-link', U.reader)).body.data).toMatchObject({ status: 'missing', linkedAt: null });
    });

    it('com TACTIQ_LINK_RETURN_URL o callback devolve o NAVEGADOR à tela (302 ?tactiq=linked)', async () => {
      setEnv('TACTIQ_LINK_RETURN_URL', 'https://app.example.test/profile');
      try {
        const u = await newHost({ user: false });
        const { authorizeUrl } = await service.startLink({ uid: `tq049-ret-${RUN}`, email: u.email });
        const st = new URL(authorizeUrl).searchParams.get('state')!;
        const res = await http('GET', `/api/admin/me/tactiq-link/callback?code=rt-ret-${RUN}&state=${st}`, null);
        expect(res.status).toBe(302);
        expect(res.location).toBe('https://app.example.test/profile?tactiq=linked');
        expect(res.location).not.toContain('rt-ret');
      } finally {
        setEnv('TACTIQ_LINK_RETURN_URL', undefined);
      }
    });
  });

  describe('teste diário — A4-4 (sino por TRANSIÇÃO), A4-6 (ping), A4-7 (rotação)', () => {
    it('A4-4: 2 execuções com o mesmo `broken` → 1 notificação; broken → linked → broken → 2 (reason broken, remetente system:admission, sem paciente)', async () => {
      const h = await newHost({ link: { status: 'linked' } });
      mcp.pingError = new TactiqUnauthorizedError();
      const t0 = Date.now();
      const tick = () => { clock = new Date(t0 + 60_000 * (++step)); };
      let step = 0;
      tick();

      const first = await service.runDailyCheck();
      expect(first.broken).toBeGreaterThanOrEqual(1);
      expect(await sino(h.uid)).toHaveLength(1);
      await service.runDailyCheck();
      await service.runDailyCheck();
      const after = await sino(h.uid);
      expect(after).toHaveLength(1); // 3 rodadas, MESMO estado → 1 aviso
      expect(after[0]).toMatchObject({ type_code: 'ADMISSION_TACTIQ_LINK_REQUIRED', actor_uid: 'system:admission', payload: { reason: 'broken' }, patient_id: null });
      expect(Object.keys(after[0].payload)).toEqual(['reason']);
      expect((await linkRow(h.email)).last_notified_status).toBe('broken');

      // volta a vincular (o operador refaz o fluxo) e o vínculo fica de pé
      tick();
      mcp.pingError = null;
      const { authorizeUrl } = await service.startLink({ uid: h.uid, email: h.email });
      const st = new URL(authorizeUrl).searchParams.get('state')!;
      expect((await http('GET', `/api/admin/me/tactiq-link/callback?code=rt-religou-${RUN}&state=${st}`, null)).status).toBe(200);
      expect((await linkRow(h.email))).toMatchObject({ status: 'linked', last_notified_status: 'linked', missing_since: null });
      tick();
      await service.runDailyCheck();
      expect(await sino(h.uid)).toHaveLength(1); // linked não avisa

      // cai de novo → NOVA transição → 2º aviso
      tick();
      mcp.pingError = new TactiqUnauthorizedError();
      await service.runDailyCheck();
      await service.runDailyCheck();
      expect(await sino(h.uid)).toHaveLength(2);
      expect((await eventKinds(h.email)).map((e) => e.kind)).toEqual([
        'tactiq_link.broken', 'tactiq_link.notified', 'tactiq_link.linked', 'tactiq_link.broken', 'tactiq_link.notified',
      ]);
    });

    it('A4-4: operadora do roster SEM vínculo (nunca teve linha) → 1 aviso `missing` por transição, não a cada rodada; o evento `missing` e o `notified` ficam na trilha', async () => {
      const h = await newHost();
      await service.runDailyCheck();
      await service.runDailyCheck();
      await service.runDailyCheck();
      const n = await sino(h.uid);
      expect(n).toHaveLength(1);
      expect(n[0].payload).toEqual({ reason: 'missing' });
      expect((await eventKinds(h.email)).map((e) => e.kind)).toEqual(['tactiq_link.missing', 'tactiq_link.notified']);
    });

    it('A4-4: operadora do roster SEM USUÁRIO → nada no sino e NÃO carimba (avisa quando o usuário existir); o evento `missing` nasce (relógio das 48 h)', async () => {
      const h = await newHost({ user: false });
      await service.runDailyCheck();
      expect(await eventKinds(h.email)).toEqual([{ kind: 'tactiq_link.missing', reason: null }]);
      // o usuário aparece depois → o próximo teste diário avisa (1×)
      await admin.query(`INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'admin','ACTIVE',true,$3)`, [`tq049-late-${RUN}-${seq}`, h.email, TENANT_E2E]);
      hostUids.push(`tq049-late-${RUN}-${seq}`);
      await service.runDailyCheck();
      await service.runDailyCheck();
      expect(await sino(`tq049-late-${RUN}-${seq}`)).toHaveLength(1);
    });

    it('A4-6: ping falhou (dublê lança 401) → `broken`, 1 aviso, evento com motivo; o vínculo sai da lista de hosts', async () => {
      const h = await newHost({ link: { status: 'linked', token: `rt-a46-${RUN}` } });
      mcp.pingError = new TactiqUnauthorizedError();
      await service.runDailyCheck();
      const row = await linkRow(h.email);
      expect(row).toMatchObject({ status: 'broken', last_check_outcome: 'unauthorized' });
      expect(new Date(row.status_changed_at).getTime()).toBe(clock.getTime());
      expect(await sino(h.uid)).toHaveLength(1);
      expect(await eventKinds(h.email)).toEqual(expect.arrayContaining([{ kind: 'tactiq_link.broken', reason: 'unauthorized' }]));
      const states = await service.statesFor([h.email]);
      expect(states.get(h.email)).toBe('broken');
    });

    it('A4-6: ping OK → `last_check_at` atualizado para o relógio, outcome ok, SEM aviso e SEM evento', async () => {
      const h = await newHost({ link: { status: 'linked' } });
      await admin.query(`UPDATE tactiq_links SET last_check_at = now() - interval '3 days' WHERE lower(host_email) = $1`, [h.email]);
      clock = new Date(Date.now() + 5_000);
      await service.runDailyCheck();
      const row = await linkRow(h.email);
      expect(row).toMatchObject({ status: 'linked', last_check_outcome: 'ok' });
      expect(new Date(row.last_check_at).getTime()).toBe(clock.getTime());
      expect(await sino(h.uid)).toHaveLength(0);
      expect(await eventKinds(h.email)).toEqual([]);
    });

    it('A4-6: falha TRANSITÓRIA (rede/5xx) NÃO derruba o vínculo: segue `linked`, outcome transient_error, sem aviso', async () => {
      const h = await newHost({ link: { status: 'linked' } });
      mcp.pingError = new TactiqTransientError('mcp_http_503');
      const s = await service.runDailyCheck();
      expect(s.transient).toBeGreaterThanOrEqual(1);
      expect(await linkRow(h.email)).toMatchObject({ status: 'linked', last_check_outcome: 'transient_error' });
      expect(await sino(h.uid)).toHaveLength(0);
      expect(await eventKinds(h.email)).toEqual([]);
    });

    it('A4-7: refresh com ROTAÇÃO — o refresh novo SUBSTITUI o cifrado antigo (e o ping usou o access novo)', async () => {
      const old = `rt-old-${RUN}`;
      const novo = `rt-novo-${RUN}`;
      const h = await newHost({ link: { status: 'linked', token: old } });
      oauth.rotateTo(novo);
      const pings = mcp.pingTokens.length;
      await service.runDailyCheck();
      const row = await linkRow(h.email);
      expect(row.refresh_token_encrypted).not.toBe(b64(old));
      expect(unb64(row.refresh_token_encrypted)).toBe(novo);
      expect(oauth.refreshCalls).toContain(old);
      expect(mcp.pingTokens.length).toBeGreaterThan(pings);
      // sem rotação: o token fica como está
      await service.runDailyCheck();
      expect(unb64((await linkRow(h.email)).refresh_token_encrypted)).toBe(novo);
      expect(oauth.refreshCalls).toContain(novo);
    });

    it('A4-7: refresh `invalid_grant` → `broken` (outcome invalid_grant), 1 aviso; o token cifrado não é apagado nem trocado', async () => {
      const tk = `rt-morto-${RUN}`;
      const h = await newHost({ link: { status: 'linked', token: tk } });
      oauth.invalidate(tk);
      await service.runDailyCheck();
      expect(await linkRow(h.email)).toMatchObject({ status: 'broken', last_check_outcome: 'invalid_grant' });
      expect(await sino(h.uid)).toHaveLength(1);
      expect(await eventKinds(h.email)).toEqual(expect.arrayContaining([{ kind: 'tactiq_link.broken', reason: 'invalid_grant' }]));
    });

    it('conta errada (autoverificação do passo 5, chamada pela importação): `linked → wrong_account` + 1 aviso `wrong_account`; repetir não repete', async () => {
      const h = await newHost({ link: { status: 'linked' } });
      expect(await service.markWrongAccount(h.email)).toBe(true);
      expect(await service.markWrongAccount(h.email)).toBe(false);
      expect(await linkRow(h.email)).toMatchObject({ status: 'wrong_account', last_notified_status: 'wrong_account' });
      const n = await sino(h.uid);
      expect(n).toHaveLength(1);
      expect(n[0].payload).toEqual({ reason: 'wrong_account' });
      await service.runDailyCheck();
      expect(await sino(h.uid)).toHaveLength(1);
      expect((await service.statesFor([h.email])).get(h.email)).toBe('wrong_account');
    });

    it('rota interna POST /api/internal/jobs/admission-tactiq-check → 200 só com contagens (nada de token, e-mail ou nome)', async () => {
      const h = await newHost({ link: { status: 'linked' } });
      const res = await http('POST', '/api/internal/jobs/admission-tactiq-check', null);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data).sort()).toEqual(['alarms', 'broken', 'notified', 'ok', 'pinged', 'rosterHosts', 'transient']);
      expect(res.body.data.pinged).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(res.body)).not.toContain(h.email);
      expect(JSON.stringify(res.body)).not.toContain('rt-');
    });
  });

  describe('A4-5 — alarme ao gestor: operadora do roster sem vínculo há MAIS de 48 h (relógio injetado)', () => {
    const missingEventAt = (email: string, at: Date) =>
      admin.query(`INSERT INTO admission_events (host_email, kind, outcome, at) VALUES (lower($1), 'tactiq_link.missing', 'missing', $2)`, [email, at]);

    it('49 h sem vínculo → 1 linha `admission.tactiq_link.missing_48h`; 47 h → 0; EXATAMENTE 48 h → 0 (estritamente maior)', async () => {
      const now = new Date();
      clock = now;
      const h49 = await newHost({ user: false });
      const h47 = await newHost({ user: false });
      const h48 = await newHost({ user: false });
      await missingEventAt(h49.email, new Date(now.getTime() - 49 * HOUR));
      await missingEventAt(h47.email, new Date(now.getTime() - 47 * HOUR));
      await missingEventAt(h48.email, new Date(now.getTime() - 48 * HOUR));

      const summary = await service.runDailyCheck();
      expect(summary.alarms).toBeGreaterThanOrEqual(1);
      const lines = alarmLines();
      expect(lines.filter((l) => l.hostId === h49.id)).toEqual([{ ...lines.find((l) => l.hostId === h49.id)!, state: 'missing', hoursWithoutLink: 49 }]);
      expect(lines.filter((l) => l.hostId === h47.id)).toHaveLength(0);
      expect(lines.filter((l) => l.hostId === h48.id)).toHaveLength(0);

      // sinal de ESTADO: na rodada seguinte, enquanto durar, a linha volta (1 por operadora por execução)
      await service.runDailyCheck();
      expect(alarmLines().filter((l) => l.hostId === h49.id)).toHaveLength(2);
    });

    it('o relógio nasce na PRIMEIRA vez que o sistema viu a operadora sem vínculo — roster antigo não dispara no deploy (0 h)', async () => {
      const h = await newHost({ user: false });
      clock = new Date();
      await service.runDailyCheck();
      expect(alarmLines().filter((l) => l.hostId === h.id)).toHaveLength(0);
      const first = (await admin.query(`SELECT at FROM admission_events WHERE lower(host_email) = $1 AND kind = 'tactiq_link.missing'`, [h.email])).rows;
      expect(first).toHaveLength(1);
      expect(new Date(first[0].at).getTime()).toBe(clock.getTime());
      // 49 h depois, com o mesmo estado, o alarme sobe
      clock = new Date(clock.getTime() + 49 * HOUR);
      await service.runDailyCheck();
      expect(alarmLines().filter((l) => l.hostId === h.id)).toHaveLength(1);
    });

    it('vínculo `broken` há 49 h (relógio = missing_since, senão status_changed_at) → alarme; `linked` nunca; operadora inativa no roster nunca', async () => {
      const now = new Date();
      clock = now;
      const quebradoAntigo = await newHost({ link: { status: 'broken', statusChangedAt: new Date(now.getTime() - 49 * HOUR) } });
      const quebradoRecente = await newHost({ link: { status: 'broken', statusChangedAt: new Date(now.getTime() - 5 * HOUR) } });
      const comMissingSince = await newHost({ link: { status: 'wrong_account', statusChangedAt: new Date(now.getTime() - 100 * HOUR), missingSince: new Date(now.getTime() - 2 * HOUR) } });
      const ok = await newHost({ link: { status: 'linked' } });
      const inativa = await newHost({ user: false });
      await admin.query(`UPDATE interview_hosts SET active = false WHERE id = $1`, [inativa.id]);
      await missingEventAt(inativa.email, new Date(now.getTime() - 200 * HOUR));

      await service.runDailyCheck();
      const lines = alarmLines();
      expect(lines.filter((l) => l.hostId === quebradoAntigo.id)).toHaveLength(1);
      expect(lines.find((l) => l.hostId === quebradoAntigo.id)).toMatchObject({ state: 'broken' });
      for (const h of [quebradoRecente, comMissingSince, ok, inativa]) expect(lines.filter((l) => l.hostId === h.id)).toHaveLength(0);
    });
  });

  describe('A4-9 — o log do job e do vínculo não carrega token, e-mail nem nome', () => {
    it('saída do logger (pino do serviço + logger global) dos cenários acima: nenhum `rt-`, nenhum e-mail do roster, nenhum nome', async () => {
      const h = await newHost({ link: { status: 'linked', token: `rt-a49-${RUN}` } });
      mcp.pingError = new TactiqUnauthorizedError();
      await service.runDailyCheck();
      const { authorizeUrl } = await service.startLink({ uid: U.linker, email: emailOf(U.linker) });
      const st = new URL(authorizeUrl).searchParams.get('state')!;
      await http('GET', `/api/admin/me/tactiq-link/callback?code=rt-a49-cb-${RUN}&state=${st}`, null);

      const saida = logs.output() + loggerCalls.join('\n');
      expect(saida.length).toBeGreaterThan(0);
      expect(saida).toContain('admission.tactiq_link.check_done'); // o controle positivo: o log EXISTE e foi lido
      expect(saida).not.toContain('rt-');
      expect(saida).not.toContain('Operadora Sintetica');
      expect(saida).not.toContain(st);
      for (const e of [...hostEmails, emailOf(U.linker)]) expect(saida).not.toContain(e);
      expect(saida).not.toContain(h.uid);
    });
  });
});

const describeAbacStack = process.env.E2E_ABAC_STACK === '1' ? describe : describe.skip;

describeAbacStack('stack com engine ligado e catálogo SINCRONIZADO no boot (F4: as 5 células e o vínculo pelo index.ts de verdade)', () => {
  let pool: Pool;
  const uids = { com: `tq049-s-com-${RUN}`, leitor: `tq049-s-leitor-${RUN}`, sem: `tq049-s-sem-${RUN}` };
  const grupos = { com: `Tq049 S Com ${RUN}`, leitor: `Tq049 S Leitor ${RUN}` };

  const call = async (method: string, path: string, uid: string | null, headers: Record<string, string> = {}) => {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {}), 'Content-Type': 'application/json', ...headers },
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limparIamFixtures(pool, { uids: Object.values(uids), grupos: Object.values(grupos) });
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1,$4,'admin','ACTIVE',true,$7), ($2,$5,'admin','ACTIVE',true,$7), ($3,$6,'admin','ACTIVE',true,$7)`,
      [uids.com, uids.leitor, uids.sem, emailOf(uids.com), emailOf(uids.leitor), emailOf(uids.sem), TENANT_E2E],
    );
    await grupoComCelulas(pool, { nome: grupos.com, uid: uids.com, celulas: [['own_tactiq_link', 'read'], ['own_tactiq_link', 'create']] });
    await grupoComCelulas(pool, { nome: grupos.leitor, uid: uids.leitor, celulas: [['own_tactiq_link', 'read']] });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)`, [Object.values(uids).map(emailOf)]);
    await pool.query(`DELETE FROM tactiq_oauth_states WHERE host_email = ANY($1)`, [Object.values(uids).map(emailOf)]);
    await limparIamFixtures(pool, { uids: Object.values(uids), grupos: Object.values(grupos) });
    await pool.end();
  });

  it('as células de admissão (6 da 049 + o ensaio pago e o reprocesso do resumo da 050) estão no catálogo SINCRONIZADO: descrição do código (não o placeholder da 507, da 509 nem da 512) e deprecated_at IS NULL', async () => {
    const { rows } = await pool.query(
      `SELECT resource || ':' || action AS cell, description, deprecated_at FROM iam.permissions WHERE resource IN ('patient_admission','own_tactiq_link') ORDER BY 1`,
    );
    expect(rows.map((r) => r.cell)).toEqual([
      'own_tactiq_link:create', 'own_tactiq_link:read',
      'patient_admission:create', 'patient_admission:read', 'patient_admission:release_paid_rehearsal', 'patient_admission:resend_message',
      'patient_admission:retry_summary', 'patient_admission:update',
    ]);
    for (const r of rows) {
      expect(r.deprecated_at).toBeNull();
      // o placeholder das migrations 507, 509 e 514 é "[NNN placeholder — sincronizado no boot] …": nenhum pode sobrar
      expect(r.description).not.toMatch(/\[\d{3} placeholder/);
    }
  });

  it('pelo index.ts: sem célula → 403 missing_cell; só-leitura lê e não inicia; com write → authorizeUrl e o callback (sem Bearer, papel de sistema) grava o vínculo', async () => {
    expect((await call('GET', '/api/admin/me/tactiq-link', uids.sem)).status).toBe(403);
    expect((await call('POST', '/api/admin/me/tactiq-link', uids.leitor)).body).toMatchObject({ code: 'missing_cell' });
    const own = await call('GET', '/api/admin/me/tactiq-link', uids.leitor);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ status: 'missing' });

    const started = await call('POST', '/api/admin/me/tactiq-link', uids.com);
    expect(started.status).toBe(200);
    const state = new URL(started.body.data.authorizeUrl as string).searchParams.get('state')!;

    const bad = await call('GET', `/api/admin/me/tactiq-link/callback?code=rt-stack-${RUN}&state=${state}x`, null);
    expect(bad.status).toBe(400);
    const ok = await call('GET', `/api/admin/me/tactiq-link/callback?code=rt-stack-${RUN}&state=${state}`, null);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ data: { status: 'linked' } });

    const row = (await pool.query(`SELECT l.status, s.refresh_token_encrypted FROM tactiq_links l JOIN tactiq_link_secrets s ON s.link_id = l.id WHERE lower(l.host_email) = $1`, [emailOf(uids.com)])).rows[0];
    expect(row.status).toBe('linked');
    expect(unb64(row.refresh_token_encrypted)).toBe(`rt-stack-${RUN}`);
    // o runtime lê o próprio estado (SELECT por coluna) e a resposta não tem o token
    const mine = await call('GET', '/api/admin/me/tactiq-link', uids.com);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toMatchObject({ status: 'linked' });
    expect(JSON.stringify(mine.body)).not.toContain('rt-stack');
  });

  it('o job diário pelo index.ts (segredo interno): 200 com contagens; sem o segredo → recusado', async () => {
    const denied = await call('POST', '/api/internal/jobs/admission-tactiq-check', null);
    expect([401, 403]).toContain(denied.status);
    const ok = await call('POST', '/api/internal/jobs/admission-tactiq-check', null, { 'X-Internal-Secret': 'test-secret-for-e2e-only' });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.body.data).sort()).toEqual(['alarms', 'broken', 'notified', 'ok', 'pinged', 'rosterHosts', 'transient']);
  });
});
