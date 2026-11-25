/**
 * tactiq-seat-gate.e2e.test.ts — change tactiq-vinculo-resiliente, F5 (design D16): a licença do Tactiq é declarada ANTES do 1º vínculo.
 * POSTGRES REAL + HTTP real + ENGINE DE PERMISSÃO LIGADO. Serviço, repositório, publicador e rotas REAIS; só o Tactiq (OAuth e MCP) é o
 * dublê `FakeTactiq`. O KMS roda em passthrough base64 (NODE_ENV=test). Dados SINTÉTICOS (@e2e.local); nenhum canal real, nenhum Tactiq real.
 *
 * Os membros do Acesso Master são semeados em `iam.user_groups` SÓ no banco de teste (o código de produção nunca escreve em `iam.*`).
 * A trilha `admission_events` é append-only: e-mail e nome levam o sufixo da rodada e toda asserção é sobre as pessoas DESTA rodada.
 *
 * (a) sem declaração: `POST /me/tactiq-link` → 409 `TACTIQ_SEAT_NOT_DECLARED`, `GET` → `canStartLink=false`, nada gravado
 * (b) a rota do Master: sem a célula `interview_host:update` → 403; `assigned` não booleano → 400; id inexistente → 404
 * (c) Master marca → evento com o ator + host recebe `seat_ready firstLink=true` 1× (repetir a marcação não repete); a listagem lê `tactiqSeatDeclared`
 * (d) feliz: `POST /me/tactiq-link` → 200; callback com `ready` + escopo `details` → `linked`; 1 único início de vínculo (`tactiq_oauth_states`)
 * (e) declaração FALSA (Tactiq recusa por assento depois de marcada) → `seat_undeclared` (ator `system`) + Master `seat_missing` `autoReactivates=false`
 * (f) legado (linha `broken` com escopo `own` congelado): nunca é travado; a marcação do Master → `seat_arrived` 1× + host `seat_ready firstLink=false`
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
import { ACESSO_MASTER_GROUP_ID } from '../../src/modules/identity/permissions/domain/PermissionCell';
import { insertInterviewHost, deleteInterviewHosts } from './helpers/interviewHostFixture';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OWN = 'mcp:meetings:own';
const DETAILS = 'mcp:meetings:own mcp:meetings:details';
const emailOf = (uid: string): string => `${uid}@e2e.local`;

const CHEFE = `tqgate-chefe-${RUN}`; // interview_host:read + update (o Master que marca "Licencia asignada")
const LEITOR = `tqgate-leitor-${RUN}`; // só interview_host:read
const MASTER = `tqgate-master-${RUN}`; // membro vivo do Acesso Master (recebe as cópias de aviso)
const GRUPOS = { chefe: `TqGate Chefe ${RUN}`, leitor: `TqGate Leitor ${RUN}` };

describe('licença antes do 1º vínculo — Postgres real, HTTP real, engine LIGADO (tactiq-vinculo-resiliente F5)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let oauth: FakeTactiqOAuth;
  let mcp: FakeTactiqMcp;
  let seq = 0;
  const hosts: Array<{ id: string; uid: string; email: string; name: string }> = [];
  const gruposDosHosts: string[] = [];
  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string | undefined): void => {
    if (!(k in envAnterior)) envAnterior[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };

  async function http(method: string, path: string, uid: string | null, body?: unknown) {
    const res = await fetch(`${app.url}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(uid ? { Authorization: tokenMock(uid, 'admin', 'AR') } : {}), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
  }

  /** Entrevistadora do roster com usuário staff (e-mail = `<uid>@e2e.local`, o que o token mock devolve) e as 2 células do PRÓPRIO vínculo. */
  async function newHost(): Promise<{ id: string; uid: string; email: string; name: string }> {
    seq += 1;
    const uid = `tqgate-op${seq}-${RUN}`;
    const email = emailOf(uid);
    const name = `Entrevistadora Sintetica ${seq} ${RUN}`;
    const row = await insertInterviewHost(admin, { email, displayName: name, withUser: true, uid });
    const grupo = `TqGate Host ${seq} ${RUN}`;
    gruposDosHosts.push(grupo);
    await grupoComCelulas(admin, { nome: grupo, uid, celulas: [['own_tactiq_link', 'read'], ['own_tactiq_link', 'create']] });
    const h = { id: row.id, uid, email, name };
    hosts.push(h);
    return h;
  }

  const seatEvents = async (email: string, kinds: string[]) =>
    (
      await admin.query<{ kind: string; outcome: string | null; ref: Record<string, any> | null }>(
        `SELECT kind, outcome, ref FROM admission_events WHERE lower(host_email) = lower($1) AND kind = ANY($2::text[]) ORDER BY at, id`,
        [email, kinds],
      )
    ).rows;
  const SEAT_KINDS = ['tactiq_link.seat_declared', 'tactiq_link.seat_undeclared', 'tactiq_link.seat_arrived'];
  const sino = async (uid: string): Promise<Array<Record<string, any>>> =>
    (
      await admin.query<{ payload: Record<string, any> }>(
        `SELECT e.payload FROM notifications n JOIN notification_events e ON e.id = n.event_id
          WHERE n.recipient_uid = $1 AND e.type_code = 'ADMISSION_TACTIQ_LINK_REQUIRED' ORDER BY n.created_at, e.id`,
        [uid],
      )
    ).rows.map((r) => r.payload);
  const oauthStarts = async (email: string): Promise<number> =>
    (await admin.query(`SELECT count(*)::int AS n FROM tactiq_oauth_states WHERE host_email = lower($1)`, [email])).rows[0].n;
  const linkStatus = async (email: string): Promise<string | undefined> =>
    (await admin.query(`SELECT status FROM tactiq_links WHERE lower(host_email) = lower($1)`, [email])).rows[0]?.status;
  const stateOf = (authorizeUrl: string): string => new URL(authorizeUrl).searchParams.get('state')!;
  const marcar = (id: string, assigned: unknown, uid: string = CHEFE) => http('POST', `/api/admin/interview-hosts/${id}/tactiq-seat`, uid, { assigned });

  async function limpar(): Promise<void> {
    const uids = [CHEFE, LEITOR, MASTER, ...hosts.map((h) => h.uid)];
    await limparIamFixtures(admin, { uids, grupos: [GRUPOS.chefe, GRUPOS.leitor, ...gruposDosHosts] });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparIamFixtures(admin, { uids: [CHEFE, LEITOR, MASTER], grupos: [GRUPOS.chefe, GRUPOS.leitor] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('TACTIQ_LINK_RETURN_URL', undefined);

    for (const uid of [CHEFE, LEITOR, MASTER]) {
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1, $2, 'admin', 'ACTIVE', true, $3)`,
        [uid, emailOf(uid), TENANT_E2E],
      );
    }
    await grupoComCelulas(admin, { nome: GRUPOS.chefe, uid: CHEFE, celulas: [['interview_host', 'read'], ['interview_host', 'update']] });
    await grupoComCelulas(admin, { nome: GRUPOS.leitor, uid: LEITOR, celulas: [['interview_host', 'read']] });
    // Semeado só no banco de teste: o código de produção nunca escreve em `iam.*`.
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [MASTER, ACESSO_MASTER_GROUP_ID, TENANT_E2E]);

    oauth = new FakeTactiqOAuth();
    mcp = new FakeTactiqMcp();

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: async ({ app: express, auth, permissions }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { TactiqLinkService } = await import('../../src/modules/matching/application/TactiqLinkService');
        const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
        const { TactiqLinkController } = await import('../../src/modules/matching/interfaces/controllers/TactiqLinkController');
        const { createTactiqLinkRoutes, createTactiqLinkCallbackRoute } = await import('../../src/modules/matching/interfaces/routes/tactiqLinkRoutes');
        const { interviewHostRepository } = await import('../../src/modules/matching/infrastructure/InterviewHostRepository');
        const { InterviewHostService } = await import('../../src/modules/matching/application/InterviewHostService');
        const { InterviewHostController } = await import('../../src/modules/matching/interfaces/controllers/InterviewHostController');
        const { createAdminInterviewHostRoutes } = await import('../../src/modules/matching/interfaces/routes/adminInterviewHostRoutes');
        const pool = DatabaseConnection.getInstance().getPool();
        const tactiq = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, clientId: () => 'mcp-cliente-e2e' });
        const linkController = new TactiqLinkController(tactiq);
        express.use('/api/admin', createTactiqLinkRoutes(auth, permissions, linkController));
        express.use('/api/admin', createTactiqLinkCallbackRoute(linkController, (_req, _res, next) => next()));
        express.use(
          '/api/admin',
          createAdminInterviewHostRoutes(auth, permissions, new InterviewHostController(new InterviewHostService({ db: pool, repo: interviewHostRepository, tactiq }))),
        );
      },
    });
  }, 60000);

  beforeEach(() => {
    mcp.verdict = { kind: 'ready' };
    mcp.pingError = null;
    oauth.exchangeScope = DETAILS;
  });

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    const uids = [CHEFE, LEITOR, MASTER, ...hosts.map((h) => h.uid)];
    const emails = hosts.map((h) => h.email);
    await admin.query(`DELETE FROM notifications WHERE recipient_uid = ANY($1)`, [uids]);
    await admin.query(
      `DELETE FROM notification_events e WHERE e.type_code = 'ADMISSION_TACTIQ_LINK_REQUIRED' AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event_id = e.id)`,
    );
    await admin.query(`DELETE FROM tactiq_oauth_states WHERE host_email = ANY($1)`, [emails]);
    await admin.query(`DELETE FROM tactiq_links WHERE lower(host_email) = ANY($1)`, [emails]);
    await deleteInterviewHosts(admin, emails);
    await admin.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [uids]);
    await limpar();
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('1º vínculo: do 409 ao `linked`, com 1 único início', () => {
    let h: Awaited<ReturnType<typeof newHost>>;

    it('(a) sem declaração → POST /me/tactiq-link = 409 TACTIQ_SEAT_NOT_DECLARED, GET = canStartLink false, nenhum estado de OAuth gravado', async () => {
      h = await newHost();
      const start = await http('POST', '/api/admin/me/tactiq-link', h.uid);
      expect(start.status).toBe(409);
      expect(start.body).toMatchObject({ success: false, code: 'TACTIQ_SEAT_NOT_DECLARED' });
      expect(await oauthStarts(h.email)).toBe(0);
      const own = await http('GET', '/api/admin/me/tactiq-link', h.uid);
      expect(own.status).toBe(200);
      expect(own.body.data).toMatchObject({ status: 'missing', canStartLink: false });
    });

    it('(b) a rota do Master: sem a célula → 403 e nada gravado; `assigned` não booleano → 400; linha inexistente → 404', async () => {
      expect((await marcar(h.id, true, LEITOR)).status).toBe(403);
      expect((await marcar(h.id, 'sim')).status).toBe(400);
      expect((await http('POST', `/api/admin/interview-hosts/${h.id}/tactiq-seat`, CHEFE, {})).status).toBe(400);
      expect((await http('POST', `/api/admin/interview-hosts/${h.id}/tactiq-seat`, CHEFE, { assigned: true, extra: 1 })).status).toBe(400);
      expect((await marcar('11111111-1111-4111-8111-111111111111', true)).status).toBe(404);
      expect(await seatEvents(h.email, SEAT_KINDS)).toEqual([]);
      expect(await sino(h.uid)).toEqual([]);
    });

    it('(c) o Master marca → 200, evento com o ator, host recebe `seat_ready firstLink=true` 1×; repetir não repete; a listagem lê `tactiqSeatDeclared`', async () => {
      const ok = await marcar(h.id, true);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ success: true, data: { id: h.id, assigned: true } });
      expect(await seatEvents(h.email, SEAT_KINDS)).toEqual([expect.objectContaining({ kind: 'tactiq_link.seat_declared', outcome: 'declared', ref: { actorUid: CHEFE } })]);
      expect(await sino(h.uid)).toEqual([{ reason: 'seat_ready', audience: 'host', firstLink: true }]);

      expect((await marcar(h.id, true)).status).toBe(200); // mesma marcação: nada novo
      expect(await seatEvents(h.email, SEAT_KINDS)).toHaveLength(1);
      expect(await sino(h.uid)).toHaveLength(1);

      const list = await http('GET', '/api/admin/interview-hosts', CHEFE);
      expect(list.status).toBe(200);
      const row = (list.body.data as Array<Record<string, any>>).find((r) => r.id === h.id);
      expect(row).toMatchObject({ tactiqSeatDeclared: true, tactiq: 'missing' });
      expect((await http('GET', '/api/admin/me/tactiq-link', h.uid)).body.data).toMatchObject({ canStartLink: true });
    });

    it('(d) feliz: POST /me/tactiq-link → 200; callback com `ready` + escopo `details` → `linked`; a contagem de inícios de vínculo é 1', async () => {
      const start = await http('POST', '/api/admin/me/tactiq-link', h.uid);
      expect(start.status).toBe(200);
      const cb = await http('GET', `/api/admin/me/tactiq-link/callback?code=rt-gate-${RUN}&state=${stateOf(start.body.data.authorizeUrl)}`, null);
      expect(cb.status).toBe(200);
      expect(cb.body).toMatchObject({ data: { status: 'linked' } });
      expect(await linkStatus(h.email)).toBe('linked');
      expect(await oauthStarts(h.email)).toBe(1);
      expect(await seatEvents(h.email, ['tactiq_link.seat_undeclared'])).toEqual([]);
      expect((await http('GET', '/api/admin/me/tactiq-link', h.uid)).body.data).toMatchObject({ status: 'linked', canStartLink: true });
    });
  });

  describe('(e) declaração FALSA: o Tactiq recusa por assento depois de marcada', () => {
    it('`seat_undeclared` (ator `system`) + Master `seat_missing` com `autoReactivates=false`; a pessoa segue pelo caminho do legado (tem linha)', async () => {
      const h = await newHost();
      expect((await marcar(h.id, true)).status).toBe(200);
      mcp.verdict = { kind: 'denied', action: 'request_seat', title: null };
      oauth.exchangeScope = OWN; // o consentimento sem assento só traz `own`
      const start = await http('POST', '/api/admin/me/tactiq-link', h.uid);
      expect(start.status).toBe(200);
      const cb = await http('GET', `/api/admin/me/tactiq-link/callback?code=rt-falsa-${RUN}&state=${stateOf(start.body.data.authorizeUrl)}`, null);
      expect(cb.status).toBe(502);
      expect(cb.body).toMatchObject({ code: 'TACTIQ_ACCESS_DENIED' });

      expect(await seatEvents(h.email, SEAT_KINDS)).toEqual([
        expect.objectContaining({ kind: 'tactiq_link.seat_declared' }),
        expect.objectContaining({ kind: 'tactiq_link.seat_undeclared', outcome: 'undeclared', ref: { actorUid: 'system' } }),
      ]);
      expect((await sino(MASTER)).filter((p) => p.hostName === h.name)).toEqual([
        { reason: 'seat_missing', audience: 'master', hostName: h.name, autoReactivates: false },
      ]);
      expect(await linkStatus(h.email)).toBe('broken');
      const list = await http('GET', '/api/admin/interview-hosts', CHEFE);
      expect((list.body.data as Array<Record<string, any>>).find((r) => r.id === h.id)).toMatchObject({ tactiqSeatDeclared: false });
      // o legado nunca é travado: a linha existe, a pessoa pode tentar de novo sem nova declaração
      expect((await http('GET', '/api/admin/me/tactiq-link', h.uid)).body.data).toMatchObject({ status: 'broken', canStartLink: true });
      expect((await http('POST', '/api/admin/me/tactiq-link', h.uid)).status).toBe(200);
    });
  });

  describe('(f) legado: linha `broken` com o escopo congelado em `own`', () => {
    it('nunca é travado pelo início do vínculo; a marcação do Master → `seat_arrived` 1× + host `seat_ready firstLink=false`', async () => {
      const h = await newHost();
      await admin.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at) VALUES ($1, $2, 'broken', now())`, [h.email, h.uid]);
      await admin.query(`INSERT INTO admission_events (host_email, kind, outcome, reason, at, ref) VALUES ($1, $2, $3, $4, now(), $5::jsonb)`, [
        h.email, 'tactiq_link.broken', 'broken', 'access_action:request_seat', JSON.stringify({ source: 'link', scope: OWN }),
      ]);

      expect((await http('GET', '/api/admin/me/tactiq-link', h.uid)).body.data).toMatchObject({ status: 'broken', canStartLink: true });
      expect((await http('POST', '/api/admin/me/tactiq-link', h.uid)).status).toBe(200); // sem nenhuma declaração

      expect((await marcar(h.id, true)).status).toBe(200);
      expect(await seatEvents(h.email, SEAT_KINDS)).toEqual([
        expect.objectContaining({ kind: 'tactiq_link.seat_declared' }),
        expect.objectContaining({ kind: 'tactiq_link.seat_arrived', ref: { source: 'declared' } }),
      ]);
      expect(await sino(h.uid)).toEqual([{ reason: 'seat_ready', audience: 'host', firstLink: false }]);

      // desmarcar e marcar de novo no mesmo episódio: o sinal não se repete
      expect((await marcar(h.id, false)).status).toBe(200);
      expect((await marcar(h.id, true)).status).toBe(200);
      expect(await seatEvents(h.email, ['tactiq_link.seat_arrived'])).toHaveLength(1);
      expect(await sino(h.uid)).toHaveLength(1);
    });
  });
});
