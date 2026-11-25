/**
 * tactiq-vinculo-resiliente-borda.e2e.test.ts — change tactiq-vinculo-resiliente, F6 (T601): a prova PELA BORDA HTTP.
 * POSTGRES REAL + HTTP real + ENGINE DE PERMISSÃO LIGADO. Serviço, repositório, publicador e rotas REAIS; só o Tactiq (OAuth e MCP) é o dublê
 * `FakeTactiq`. O KMS roda em passthrough base64 (NODE_ENV=test). Dados SINTÉTICOS (@e2e.local); nenhum canal real, nenhum Tactiq real.
 * Nenhum efeito é provocado por chamada direta ao serviço: tudo entra por rota (declaração do Master, callback, job diário). SQL só monta/lê cenário.
 *
 * O Master vivo é semeado em `iam.user_groups` SÓ no banco de teste (o código de produção nunca escreve em `iam.*`).
 * A trilha é append-only e o diário olha a tabela inteira: toda asserção é sobre os e-mails/ids DESTA rodada.
 *
 * (1) host recusado por assento → `GET /me/tactiq-link` com `accessDenial.seatMissing`; o sino do Master traz `seat_missing` `audience=master`
 * (2) `POST /api/internal/jobs/admission-tactiq-check` com o Tactiq `ready` + escopo `details` na renovação → `GET /me/tactiq-link` = `linked`
 * (3) sem declaração: `POST /me/tactiq-link` → 409 `TACTIQ_SEAT_NOT_DECLARED`; depois da declaração do Master → 200
 */
import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  garantirCelulas,
  removerCelulasCriadas,
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
const DETAILS = 'mcp:meetings:own mcp:meetings:details';
const emailOf = (uid: string): string => `${uid}@e2e.local`;

const CHEFE = `tqborda-chefe-${RUN}`; // interview_host:read + update (o Master que declara "Licencia asignada")
const MASTER = `tqborda-master-${RUN}`; // membro vivo do Acesso Master + célula do sino
const GRUPOS = { chefe: `TqBorda Chefe ${RUN}`, master: `TqBorda Master ${RUN}` };

describe('vínculo resiliente do Tactiq pela borda HTTP — Postgres real, engine LIGADO (tactiq-vinculo-resiliente F6)', () => {
  let admin: Pool;
  let app: AppDeFamilia;
  let oauth: FakeTactiqOAuth;
  let mcp: FakeTactiqMcp;
  let seq = 0;
  let celulasCriadas: string[] = [];
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
    const uid = `tqborda-op${seq}-${RUN}`;
    const email = emailOf(uid);
    const name = `Entrevistadora Sintetica Borda ${seq} ${RUN}`;
    const row = await insertInterviewHost(admin, { email, displayName: name, withUser: true, uid });
    const grupo = `TqBorda Host ${seq} ${RUN}`;
    gruposDosHosts.push(grupo);
    await grupoComCelulas(admin, { nome: grupo, uid, celulas: [['own_tactiq_link', 'read'], ['own_tactiq_link', 'create']] });
    const h = { id: row.id, uid, email, name };
    hosts.push(h);
    return h;
  }

  const stateOf = (authorizeUrl: string): string => new URL(authorizeUrl).searchParams.get('state')!;
  const declarar = (id: string, assigned: boolean) => http('POST', `/api/admin/interview-hosts/${id}/tactiq-seat`, CHEFE, { assigned });
  const meuVinculo = (uid: string) => http('GET', '/api/admin/me/tactiq-link', uid);

  async function limpar(): Promise<void> {
    const uids = [CHEFE, MASTER, ...hosts.map((h) => h.uid)];
    await limparIamFixtures(admin, { uids, grupos: [GRUPOS.chefe, GRUPOS.master, ...gruposDosHosts] });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: DATABASE_URL });
    await limparIamFixtures(admin, { uids: [CHEFE, MASTER], grupos: [GRUPOS.chefe, GRUPOS.master] });

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);
    setEnv('TACTIQ_LINK_RETURN_URL', undefined);

    for (const uid of [CHEFE, MASTER]) {
      await admin.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1, $2, 'admin', 'ACTIVE', true, $3)`,
        [uid, emailOf(uid), TENANT_E2E],
      );
    }
    // No job `backend-e2e` o catálogo não é sincronizado: a célula do sino pode não existir; só apago a que ESTA suíte criou.
    celulasCriadas = await garantirCelulas(admin, ['own_notifications:read'], 'Administração');
    await grupoComCelulas(admin, { nome: GRUPOS.chefe, uid: CHEFE, celulas: [['interview_host', 'read'], ['interview_host', 'update']] });
    await grupoComCelulas(admin, { nome: GRUPOS.master, uid: MASTER, celulas: [['own_notifications', 'read']] });
    // Semeado só no banco de teste: o código de produção nunca escreve em `iam.*`.
    await admin.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [MASTER, ACESSO_MASTER_GROUP_ID, TENANT_E2E]);

    oauth = new FakeTactiqOAuth();
    mcp = new FakeTactiqMcp();

    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.users',
      montarRotas: async ({ app: express, auth, permissions, modulo }) => {
        const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
        const { TactiqLinkService } = await import('../../src/modules/matching/application/TactiqLinkService');
        const { TactiqLinkRepository } = await import('../../src/modules/matching/infrastructure/TactiqLinkRepository');
        const { TactiqLinkController } = await import('../../src/modules/matching/interfaces/controllers/TactiqLinkController');
        const { TactiqCheckInternalController } = await import('../../src/modules/matching/interfaces/controllers/TactiqCheckInternalController');
        const routes = await import('../../src/modules/matching/interfaces/routes/tactiqLinkRoutes');
        const { interviewHostRepository } = await import('../../src/modules/matching/infrastructure/InterviewHostRepository');
        const { InterviewHostService } = await import('../../src/modules/matching/application/InterviewHostService');
        const { InterviewHostController } = await import('../../src/modules/matching/interfaces/controllers/InterviewHostController');
        const { createAdminInterviewHostRoutes } = await import('../../src/modules/matching/interfaces/routes/adminInterviewHostRoutes');
        const { createAdminNotificationRoutes } = await import('../../src/modules/inapp-notification/interfaces/routes/adminNotificationRoutes');
        const pool = DatabaseConnection.getInstance().getPool();
        const tactiq = new TactiqLinkService({ repo: new TactiqLinkRepository(pool), oauth, mcp, db: pool, clientId: () => 'mcp-cliente-e2e' });
        const linkController = new TactiqLinkController(tactiq);
        express.use('/api/admin', routes.createTactiqLinkRoutes(auth, permissions, linkController));
        express.use('/api/admin', routes.createTactiqLinkCallbackRoute(linkController, (_req, _res, next) => next()));
        express.use('/api/internal', routes.createTactiqCheckInternalRoutes(new TactiqCheckInternalController(tactiq)));
        express.use(
          '/api/admin',
          createAdminInterviewHostRoutes(auth, permissions, new InterviewHostController(new InterviewHostService({ db: pool, repo: interviewHostRepository, tactiq }))),
        );
        express.use('/api/admin', createAdminNotificationRoutes(auth, permissions, modulo.client));
      },
    });
  }, 60000);

  beforeEach(() => {
    mcp.verdict = { kind: 'ready' };
    mcp.pingError = null;
    oauth.exchangeScope = DETAILS;
    oauth.refreshScope = undefined;
  });

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    const uids = [CHEFE, MASTER, ...hosts.map((h) => h.uid)];
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
    await removerCelulasCriadas(admin, celulasCriadas);
    await admin.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('(1) e (2) o host recusado por assento volta sozinho pelo diário', () => {
    let h: Awaited<ReturnType<typeof newHost>>;

    it('(1) recusa por assento depois da declaração → perfil do host com `accessDenial.seatMissing` e o sino do Master com `seat_missing`/`master`', async () => {
      h = await newHost();
      expect((await declarar(h.id, true)).status).toBe(200);

      mcp.verdict = { kind: 'denied', action: 'request_seat', title: null };
      const start = await http('POST', '/api/admin/me/tactiq-link', h.uid);
      expect(start.status).toBe(200);
      const cb = await http('GET', `/api/admin/me/tactiq-link/callback?code=rt-borda-${RUN}&state=${stateOf(start.body.data.authorizeUrl)}`, null);
      expect(cb.status).toBe(502);
      expect(cb.body).toMatchObject({ code: 'TACTIQ_ACCESS_DENIED' });

      const own = await meuVinculo(h.uid);
      expect(own.status).toBe(200);
      expect(own.body.data.accessDenial).toMatchObject({ reason: 'access_action:request_seat', seatMissing: true });

      const lista = await http('GET', '/api/admin/notifications', MASTER);
      expect(lista.status).toBe(200);
      const doHost = (lista.body.data as Array<Record<string, any>>).filter(
        (n) => n.typeCode === 'ADMISSION_TACTIQ_LINK_REQUIRED' && n.payload?.hostName === h.name,
      );
      expect(doHost).toHaveLength(1);
      expect(doHost[0].payload).toMatchObject({ reason: 'seat_missing', audience: 'master' });
    });

    it('(2) o diário pela rota interna, com o Tactiq `ready` e escopo `details` na renovação → `GET /me/tactiq-link` = `linked`', async () => {
      mcp.verdict = { kind: 'ready' };
      oauth.refreshScope = DETAILS;
      const job = await http('POST', '/api/internal/jobs/admission-tactiq-check', null);
      expect(job.status).toBe(200);
      expect(job.body.data.reactivated).toBeGreaterThanOrEqual(1);

      const own = await meuVinculo(h.uid);
      expect(own.status).toBe(200);
      expect(own.body.data.status).toBe('linked');
      expect(own.body.data.accessDenial).toBeNull();
    });
  });

  describe('(3) sem declaração não há 1º vínculo', () => {
    it('`POST /me/tactiq-link` → 409 `TACTIQ_SEAT_NOT_DECLARED`; depois de `POST …/tactiq-seat {assigned:true}` → 200', async () => {
      const h = await newHost();
      const antes = await http('POST', '/api/admin/me/tactiq-link', h.uid);
      expect(antes.status).toBe(409);
      expect(antes.body).toMatchObject({ success: false, code: 'TACTIQ_SEAT_NOT_DECLARED' });

      const ok = await declarar(h.id, true);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ success: true, data: { id: h.id, assigned: true } });

      const depois = await http('POST', '/api/admin/me/tactiq-link', h.uid);
      expect(depois.status).toBe(200);
      expect(typeof depois.body.data.authorizeUrl).toBe('string');
    });
  });
});
