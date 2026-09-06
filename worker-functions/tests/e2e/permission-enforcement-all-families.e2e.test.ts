import { Pool } from 'pg';
import type { Router } from 'express';
import {
  TENANT_E2E,
  tokenMock,
  montarAppComTodasFamilias,
  controllerStub,
  garantirCelula,
  limparIamFixtures,
  grupoComCelulas,
  type AppComTodasFamilias,
} from './helpers/permissionFamilyHarness';

/**
 * C1 (critério do CTO) — o engine LIGADO com as 12 famílias de
 * `PERMISSION_ENFORCED_ROUTES` DE UMA VEZ, no MESMO processo, contra o
 * MESMO wiring de produção (`src/bootstrap/wirePermissionsModule.ts`).
 *
 * Por que este arquivo existe além dos 8 `permission-enforcement-*.test.ts`:
 * cada um deles liga UMA família (ou 3, no caso do A4) por vez. Nenhum liga
 * as 12 juntas — e é só com as 12 juntas que existe uma app real capaz de
 * revelar COLISÃO ENTRE FAMÍLIAS: uma rota registrada em duas famílias (duas
 * chamadas de `permissions.family(...)` sobre o mesmo método+caminho), uma
 * rota isenta que uma 2ª família engoliu por engano, ou uma família que
 * esqueceu de entrar em `PERMISSION_ENFORCED_ROUTES` e por isso nunca nega
 * ninguém mesmo com o engine ligado. Com uma família de cada vez, nenhum
 * desses três jamais aparece — o teste está sozinho no processo.
 *
 * O que este arquivo prova (ver blocos `describe`/`it` abaixo):
 *  1. `ALL_PERMISSION_FAMILIES` (novo, `@modules/identity/permissions`) bate
 *     com o que a varredura VIVA do app realmente montou — família nova sem
 *     entrar na lista fica vermelha aqui.
 *  2. Para cada uma das 12 famílias: staff SEM a célula → 403 do engine;
 *     staff com grupo que TEM a célula → passa do portão (não-403).
 *  3. Uma rota isenta (`GET /v1/me/authz`) passa sem célula nenhuma.
 *  4. As 4 rotas de `requireStaffOrApiKey` que a Luz consome (D126) passam
 *     por CHAVE DE API REAL — mesmo com as 12 famílias enforçadas ao mesmo
 *     tempo, não só `admin.workers` isolada como no teste de família única.
 *  5. Não-staff (app do prestador) numa rota do prestador não leva 403 do
 *     engine (desvio de não-staff, D119) — a rota nem declara célula.
 *  6. Invariante de não-colisão: nenhuma rota governada foi montada em duas
 *     famílias ao mesmo tempo, e o total de rotas declaradas do inventário
 *     vivo bate com a soma das 12 listas por família.
 *
 * ⚠️ Mock do jest é PROIBIDO aqui (memória do repo). A única substituição são
 * os CONTROLLERS (via `controllerStub`, ver harness) — o wiring de auth e de
 * permissão é sempre o real de `src/bootstrap/wirePermissionsModule.ts`.
 *
 * Banco: `enlite_e2e_fam` (porta 5439), isolado — NÃO é o `enlite_e2e` que
 * outro processo usa.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e_fam';
const INTERNAL_SECRET = 'enlite_e2e_all_families_internal_secret';
const API_KEY_E2E = 'enlite_e2e_all_families_triage_key';

interface CelulaGovernada {
  resource: string;
  action: string;
}
interface RotaComFamilia {
  familia: string;
  method: string;
  path: string;
  cell: CelulaGovernada;
}
interface RespostaInventario {
  totalRoutes: number;
  governedRoutes: Array<{ method: string; path: string; cell: string | null; status: string }>;
  declaredCells: string[];
  undeclared: string[];
}

/** `MÉTODO path` das 7 rotas de `messagingRoutes.ts` → nome do marcador. Só
 * este arquivo precisa disto: `createMessagingRoutes` constrói o controller
 * DENTRO de si (não aceita um já pronto), então a substituição é por troca de
 * handler pós-montagem — a MESMA técnica de `permission-enforcement-messaging.test.ts`. */
const NOME_POR_ROTA_MESSAGING: Record<string, string> = {
  'POST /whatsapp/vacancy-match': 'sendVacancyMatch',
  'POST /whatsapp/direct': 'sendDirect',
  'GET /templates': 'listTemplates',
  'POST /templates': 'createTemplate',
  'PUT /templates/:slug': 'updateTemplate',
  'DELETE /templates/:slug': 'deleteTemplate',
  'POST /bulk-dispatch-incomplete': 'bulkDispatchIncomplete',
};

/** As 4 rotas `requireStaffOrApiKey` que o triage-service consome (D126) — a
 * lista vem do teste que provou o caminho da Luz (ver cabeçalho acima), não é
 * derivada aqui porque `requireStaffOrApiKey` não deixa marca no scanner (só
 * a CÉLULA deixa) — não existe varredura viva que distinga "aceita chave de
 * API" de "só staff". */
const ROTAS_DA_LUZ: Array<[string, string]> = [
  ['GET', '/api/admin/workers/by-phone'],
  ['GET', '/api/admin/workers/abc-123/current-interview'],
  ['GET', '/api/admin/workers/abc-123/available-vacancies'],
  ['POST', '/api/admin/workers/abc-123/documents/ingest-from-url'],
];

describe('C1 — engine ligado com as 12 famílias de uma vez (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppComTodasFamilias;
  let rotasPorFamilia: Map<string, RotaComFamilia[]>;
  let inventarioVivo: RespostaInventario;
  let rotaIsentaViva: { method: string; path: string } | undefined;

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    if (!(chave in envAnterior)) envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }
  function restaurarEnv(): void {
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  }

  /** Staff ACTIVE, ZERO grupos — a negativa genérica (`code: 'no_group'`)
   * vale para as 12 famílias, então um usuário só cobre as 12 asserções (a).
   */
  const SEM_GRUPO_UID = 'perm-all-e2e-sem-grupo';
  /** Staff ACTIVE, role `worker` — não é staff nenhum; prova o desvio D119. */
  const WORKER_UID = 'perm-all-e2e-worker';

  const celulasCriadas: Array<[string, string]> = [];
  const gruposCriados: string[] = [];
  const uidsComCelula: string[] = [];

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string | null,
    alvo: AppComTodasFamilias,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${alvo.url}${caminho}`, {
      method: metodo,
      headers: {
        ...(uid ? { Authorization: tokenMock(uid) } : {}),
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(metodo !== 'GET' && metodo !== 'DELETE' ? { body: '{}' } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function limpar(): Promise<void> {
    // Um run interrompido deixa `perm-all-*` para trás e o próximo quebraria na PK: varre por prefixo,
    // não só pelo que ESTE processo lembra de ter criado.
    const orfaos = await pool.query<{ firebase_uid: string }>(`SELECT firebase_uid FROM users WHERE firebase_uid LIKE 'perm-all-e2e-%'`);
    const gruposOrfaos = await pool.query<{ name: string }>(`SELECT name FROM iam.permission_groups WHERE name LIKE 'Perm All E2E%'`);
    await limparIamFixtures(pool, {
      uids: [...new Set([SEM_GRUPO_UID, WORKER_UID, ...uidsComCelula, ...orfaos.rows.map((r) => r.firebase_uid)])],
      grupos: [...new Set([...gruposCriados, ...gruposOrfaos.rows.map((r) => r.name)])],
    });
    for (const [resource, action] of celulasCriadas) {
      await pool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN
           (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`,
        [resource, action],
      );
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
    celulasCriadas.length = 0;
    gruposCriados.length = 0;
    uidsComCelula.length = 0;
  }

  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-all-sem-grupo@e2e.local', 'admin', 'ACTIVE', true, $3),
         ($2, 'perm-all-worker@e2e.local', 'worker', 'ACTIVE', true, $3)`,
      [SEM_GRUPO_UID, WORKER_UID, TENANT_E2E],
    );
  }

  /**
   * TODOS os `await import('src/...')` que a montagem composta precisa,
   * resolvidos UMA VEZ antes de chamar `montarAppComTodasFamilias`.
   *
   * ⚠️ Por que não são resolvidos DENTRO de `montarRotas`: o contrato do
   * harness é `montarRotas: (deps) => void` — SÍNCRONO, porque
   * `wirePermissionsModule` + `runPermissionsBootTasks` rodam LOGO DEPOIS,
   * no mesmo `await` da função que monta a app, e `runPermissionsBootTasks`
   * escaneia o router com `scanExpressRouter(app)` para publicar o índice
   * que `denyUndeclaredRoutes` e o inventário leem. Se a montagem real
   * acontecesse depois de um `await import()` dentro de `montarRotas`, o
   * boot escanearia a app ANTES das rotas existirem — o índice nasceria
   * vazio e TODAS as asserções deste arquivo veriam `not_governed` em vez de
   * `declared`/`exempt`. Resolver os imports ANTES faz `montarRotas` ser
   * pura sincronia de `express.use(...)`, igual ao `src/index.ts` real.
   */
  async function importarModulosDeRotas() {
    const { Router } = await import('express');
    const { scanExpressRouter } = await import('@modules/identity/permissions');
    const {
      createAnalyticsRoutes,
      createRecruitmentRoutes,
      createAdminVacanciesRoutes,
      createWorkerEncuadreRoutes,
    } = await import('@modules/matching');
    const { createAdminPatientsRoutes } = await import('@modules/case');
    const { createAdminUsersRoutes, createPermissionPanelRoutes, principalUid } = await import('@modules/identity');
    const { createMeAuthzRouter } = await import('@modules/identity/permissions');
    const { createAdminIntegrationsRoutes } = await import('@modules/integration');
    const { createMessagingRoutes } = await import('@modules/notification/interfaces/routes/messagingRoutes');
    const { createAdminWorkerRoutes, createAdminWorkerDocumentsRoutes, createWorkerDocumentsRoutes } = await import(
      '@modules/worker'
    );
    const { createWorkerContextRoutes } = await import('@modules/matching/interfaces/routes/workerContextRoutes');
    const { createDedupRoutes } = await import('../../src/interfaces/routes/dedupRoutes');
    const { createTestFixturesRoutes } = await import('../../src/interfaces/routes/testFixturesRoutes');

    return {
      Router,
      scanExpressRouter,
      createAnalyticsRoutes,
      createRecruitmentRoutes,
      createAdminVacanciesRoutes,
      createWorkerEncuadreRoutes,
      createAdminPatientsRoutes,
      createAdminUsersRoutes,
      createPermissionPanelRoutes,
      principalUid,
      createMeAuthzRouter,
      createAdminIntegrationsRoutes,
      createMessagingRoutes,
      createAdminWorkerRoutes,
      createAdminWorkerDocumentsRoutes,
      createWorkerDocumentsRoutes,
      createWorkerContextRoutes,
      createDedupRoutes,
      createTestFixturesRoutes,
    };
  }

  type ModulosDeRotas = Awaited<ReturnType<typeof importarModulosDeRotas>>;

  /**
   * Monta as 12 famílias + o self-service do prestador (ungoverned), IGUAL
   * ao que `src/index.ts` monta em produção — só os CONTROLLERS trocam por
   * `controllerStub`. Roda dentro de `montarAppComTodasFamilias`, então
   * `app`/`auth`/`permissions`/`modulo` já são as peças REAIS do boundary.
   * SÍNCRONA de propósito — ver o comentário de `importarModulosDeRotas`.
   *
   * `sink`, quando passado, recebe a varredura viva família a família — só a
   * 1ª chamada (app principal) precisa preencher `rotasPorFamilia`; a 2ª
   * (app da chave de API) reusa a mesma topologia sem escanear de novo.
   */
  function montarRotasCompostas(
    deps: {
      app: import('express').Express;
      auth: import('@modules/identity').AuthMiddleware;
      permissions: import('@modules/identity').PermissionMiddleware;
      modulo: import('@modules/identity/permissions').PermissionsModule;
    },
    mods: ModulosDeRotas,
    sink?: Map<string, RotaComFamilia[]>,
  ): void {
    const { app: express, auth, permissions, modulo } = deps;
    const {
      Router,
      scanExpressRouter,
      createAnalyticsRoutes,
      createRecruitmentRoutes,
      createAdminVacanciesRoutes,
      createWorkerEncuadreRoutes,
      createAdminPatientsRoutes,
      createAdminUsersRoutes,
      createPermissionPanelRoutes,
      principalUid,
      createMeAuthzRouter,
      createAdminIntegrationsRoutes,
      createMessagingRoutes,
      createAdminWorkerRoutes,
      createAdminWorkerDocumentsRoutes,
      createWorkerDocumentsRoutes,
      createWorkerContextRoutes,
      createDedupRoutes,
      createTestFixturesRoutes,
    } = mods;

    /** Monta UM router isolado sob `prefixo`, escaneia (paths JÁ juntados,
     * célula já carimbada) e devolve as rotas com CÉLULA — as governadas. */
    function escanear(prefixo: string, router: Router, familia: string): RotaComFamilia[] {
      const wrapper = Router();
      wrapper.use(prefixo, router);
      return scanExpressRouter(wrapper)
        .filter((r) => !!r.cell)
        .map((r) => ({
          familia,
          method: r.method,
          path: r.path,
          cell: { resource: r.cell!.resource, action: r.cell!.action },
        }));
    }

    function montarFamilia(familia: string, prefixo: string, router: Router, guards: import('express').RequestHandler[] = []): void {
      if (guards.length > 0) express.use(prefixo, ...guards, router);
      else express.use(prefixo, router);
      if (sink) {
        const existentes = sink.get(familia) ?? [];
        sink.set(familia, [...existentes, ...escanear(prefixo, router, familia)]);
      }
    }

    // ── admin.analytics ──────────────────────────────────────────────────
    montarFamilia(
      'admin.analytics',
      '/analytics',
      createAnalyticsRoutes(controllerStub('analytics') as never, auth, permissions),
    );

    // ── admin.dedup ──────────────────────────────────────────────────────
    montarFamilia(
      'admin.dedup',
      '/api/admin/dedup',
      createDedupRoutes(controllerStub('dedup') as never, auth, permissions),
    );

    // ── admin.encuadre ───────────────────────────────────────────────────
    montarFamilia(
      'admin.encuadre',
      '/api',
      createWorkerEncuadreRoutes(controllerStub('encuadre') as never, auth, permissions),
    );

    // ── admin.integrations (controller REAL — dryRun default=true, sem rede) ─
    montarFamilia('admin.integrations', '/api/admin', createAdminIntegrationsRoutes(auth, permissions));

    // ── admin.messaging (controller construído DENTRO da função — swap pós-montagem) ─
    {
      const messaging = createMessagingRoutes({} as never, {} as never, permissions);
      const marca = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: nome });
      let trocados = 0;
      for (const camada of (messaging as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }>;
      }).stack) {
        const rota = camada.route;
        if (!rota) continue;
        const metodo = Object.keys(rota.methods).find((m) => rota.methods[m])?.toUpperCase();
        const nome = NOME_POR_ROTA_MESSAGING[`${metodo} ${rota.path}`];
        if (!nome) continue;
        rota.stack[rota.stack.length - 1].handle = marca(nome) as never;
        trocados += 1;
      }
      if (trocados !== 7) {
        throw new Error(`esperava trocar 7 handlers de mensageria e troquei ${trocados} — handler real ficaria de pé`);
      }
      montarFamilia('admin.messaging', '/api/admin/messaging', messaging, [auth.requireStaff()]);
    }

    // ── admin.patients ───────────────────────────────────────────────────
    montarFamilia(
      'admin.patients',
      '/api/admin',
      createAdminPatientsRoutes(
        controllerStub('patients') as never,
        auth,
        permissions,
        controllerStub('chatIds') as never,
        controllerStub('chatRoles') as never,
        controllerStub('patientsMap') as never,
        controllerStub('patientAddresses') as never,
        controllerStub('insuranceProviders') as never,
        controllerStub('contractedServices') as never,
        controllerStub('diagnoses') as never,
        controllerStub('terminologySearch') as never,
      ),
    );

    // ── admin.permissions (use case REAL — leitura/escrita no banco isolado) ─
    montarFamilia(
      'admin.permissions',
      '/api/admin',
      createPermissionPanelRoutes({
        catalog: modulo.catalog.list,
        groups: modulo.repositories.groups,
        features: modulo.repositories.features,
        audit: modulo.audit,
        auth,
        permissions,
        tenantId: TENANT_E2E,
      }),
    );
    // `GET /v1/me/authz` — a rota ISENTA (marca `exemptHandler`, não lista):
    // não é família, não declara célula, mas é GOVERNADA (perímetro por marca).
    express.use(
      '/v1',
      createMeAuthzRouter({
        getMyAuthz: modulo.authz,
        staffGuard: auth.requireStaff(),
        uidOf: principalUid,
        tenantId: TENANT_E2E,
      }),
    );

    // ── admin.recruitment ────────────────────────────────────────────────
    montarFamilia(
      'admin.recruitment',
      '/api',
      createRecruitmentRoutes(controllerStub('recruitment') as never, auth, permissions),
    );

    // ── admin.test_fixtures ──────────────────────────────────────────────
    montarFamilia(
      'admin.test_fixtures',
      '/api/admin/test-fixtures',
      createTestFixturesRoutes(controllerStub('fixtures') as never, auth, permissions),
    );

    // ── admin.users ──────────────────────────────────────────────────────
    montarFamilia(
      'admin.users',
      '/api/admin',
      createAdminUsersRoutes(controllerStub('users') as never, auth, permissions),
    );

    // ── admin.vacancies ──────────────────────────────────────────────────
    montarFamilia(
      'admin.vacancies',
      '/api/admin',
      createAdminVacanciesRoutes(
        controllerStub('vac') as never,
        controllerStub('crud') as never,
        controllerStub('talentum') as never,
        controllerStub('match') as never,
        controllerStub('meet') as never,
        controllerStub('social') as never,
        controllerStub('funnel') as never,
        controllerStub('dash') as never,
        controllerStub('slots') as never,
        auth,
        permissions,
        controllerStub('addr') as never,
        controllerStub('table') as never,
      ),
    );

    // ── admin.workers (4 arquivos, mesma família) ───────────────────────
    montarFamilia(
      'admin.workers',
      '/api/admin',
      createAdminWorkerRoutes(
        {
          workers: controllerStub('workers'),
          aux: controllerStub('aux'),
          testFlag: controllerStub('testFlag'),
          profile: controllerStub('profile'),
          serviceArea: controllerStub('serviceArea'),
          tags: controllerStub('tags'),
          timeline: controllerStub('timeline'),
        } as never,
        auth,
        permissions,
      ),
    );
    montarFamilia(
      'admin.workers',
      '/api/admin',
      createAdminWorkerDocumentsRoutes(controllerStub('adminWorkerDocs') as never, auth, permissions),
    );
    montarFamilia(
      'admin.workers',
      '/api/admin',
      createWorkerContextRoutes(controllerStub('workerContext') as never, auth, permissions),
    );
    // Este 4º arquivo carrega os DOIS lados: 4 rotas `admin.workers` +
    // 9 rotas self-service do prestador (ungoverned, ponto 4 do teste).
    montarFamilia(
      'admin.workers',
      '/api',
      createWorkerDocumentsRoutes(
        controllerStub('meDocs') as never,
        controllerStub('meAdditional') as never,
        controllerStub('adminAdditional') as never,
        auth,
        permissions,
      ),
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await semear();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { ALL_PERMISSION_FAMILIES } = await import('@modules/identity/permissions');
    setEnv('PERMISSION_ENFORCED_ROUTES', ALL_PERMISSION_FAMILIES.join(';'));

    // Marcador do rollout — sem ele `runPermissionsBootTasks` recusa o boot
    // com o engine ligado (`RolloutNotMigratedError`).
    await pool.query(
      `INSERT INTO iam.rollout_state (key, value, note) VALUES ('permission_groups_migrated', 'done', 'e2e-all-families')
       ON CONFLICT (key) DO UPDATE SET value = 'done'`,
    );

    rotasPorFamilia = new Map();
    // Resolvido ANTES de `montarAppComTodasFamilias`: ver o comentário de
    // `importarModulosDeRotas` — `montarRotas` tem que ser síncrona.
    const mods = await importarModulosDeRotas();
    app = await montarAppComTodasFamilias({
      internalSecret: INTERNAL_SECRET,
      montarRotas: (deps) => montarRotasCompostas(deps, mods, rotasPorFamilia),
    });

    const res = await fetch(`${app.url}/.well-known/permissions/routes`, {
      headers: { 'X-Internal-Secret': INTERNAL_SECRET },
    });
    expect(res.status).toBe(200);
    inventarioVivo = (await res.json()) as RespostaInventario;

    // Semeia, PARA CADA família, um grupo com EXATAMENTE a célula da rota
    // representativa (1ª rota GET escaneada; se a família não tiver GET
    // governado, a 1ª rota de qualquer método).
    for (const [familia, rotas] of rotasPorFamilia) {
      const rep = rotas.find((r) => r.method === 'GET') ?? rotas[0];
      if (!rep) continue;
      const { criada } = await garantirCelula(pool, {
        resource: rep.cell.resource,
        action: rep.cell.action,
        category: 'E2E — all-families',
      });
      if (criada) celulasCriadas.push([rep.cell.resource, rep.cell.action]);

      const uid = `perm-all-${familia.replace(/\./g, '-')}-com`;
      const grupo = `Perm All E2E ${familia}`;
      await pool.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1, $2, 'admin', 'ACTIVE', true, $3)`,
        [uid, `${uid}@e2e.local`, TENANT_E2E],
      );
      await grupoComCelulas(pool, { nome: grupo, uid, celulas: [[rep.cell.resource, rep.cell.action]] });
      uidsComCelula.push(uid);
      gruposCriados.push(grupo);
    }
  }, 60000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.query(`DELETE FROM iam.rollout_state WHERE key = 'permission_groups_migrated'`);
    await pool.end();
    restaurarEnv();
  });

  describe('1 — ALL_PERMISSION_FAMILIES bate com a varredura viva', () => {
    it('a lista exportada é EXATAMENTE o que o app montado tem, ordenada', async () => {
      const { ALL_PERMISSION_FAMILIES } = await import('@modules/identity/permissions');
      expect([...ALL_PERMISSION_FAMILIES]).toEqual([...rotasPorFamilia.keys()].sort());
      expect(ALL_PERMISSION_FAMILIES.length).toBe(12);
    });
  });

  describe('2 — para CADA família: sem célula → 403; com célula → passa do portão', () => {
    it('roda as 12 famílias — negativa e positiva, rota escolhida pela varredura viva', async () => {
      expect(rotasPorFamilia.size).toBe(12);
      for (const [familia, rotas] of rotasPorFamilia) {
        const rep = rotas.find((r) => r.method === 'GET') ?? rotas[0];
        expect(rep).toBeDefined();
        if (!rep) continue;

        const negado = await chamar(rep.method, rep.path, SEM_GRUPO_UID, app);
        expect(negado.status).toBe(403);
        expect(negado.body).toMatchObject({ code: 'no_group' });

        const uidComCelula = `perm-all-${familia.replace(/\./g, '-')}-com`;
        const permitido = await chamar(rep.method, rep.path, uidComCelula, app);
        expect(permitido.status).not.toBe(403);
      }
    });
  });

  describe('3 — rota isenta passa sem célula nenhuma', () => {
    it('GET /v1/me/authz está no inventário como `exempt`, e um staff sem grupo passa', async () => {
      const isentas = inventarioVivo.governedRoutes.filter((r) => r.status === 'exempt');
      rotaIsentaViva = isentas.find((r) => r.path === '/v1/me/authz');
      expect(rotaIsentaViva).toBeDefined();

      const res = await chamar('GET', '/v1/me/authz', SEM_GRUPO_UID, app);
      expect(res.status).not.toBe(403);
      // D268 — este app sobe pelo MESMO `createPermissionsBoundary` de
      // produção, com `PERMISSION_ENGINE_ENABLED=true` (linha 480): o
      // contrato tem de dizer "on", não só o status HTTP.
      expect(res.body.enforcement).toBe('on');
    });
  });

  describe('4 — não-staff numa rota do prestador não leva 403 do engine (D119)', () => {
    it('GET /api/workers/me/documents com role=worker passa — a rota nem declara célula', async () => {
      const res = await chamar('GET', '/api/workers/me/documents', WORKER_UID, app);
      expect(res.status).not.toBe(403);
    });
  });

  describe('5 — invariante de não-colisão entre as 12 famílias', () => {
    it('nenhuma rota (método+caminho) foi montada em duas famílias', () => {
      const chaves = [...rotasPorFamilia.values()].flat().map((r) => `${r.method} ${r.path}`);
      const unicas = new Set(chaves);
      expect(unicas.size).toBe(chaves.length);
    });

    it('o total de rotas DECLARADAS do inventário vivo bate com a soma das 12 famílias', () => {
      const declaradasNoInventario = inventarioVivo.governedRoutes.filter((r) => r.status === 'declared').length;
      const somaPorFamilia = [...rotasPorFamilia.values()].reduce((acc, rotas) => acc + rotas.length, 0);
      expect(declaradasNoInventario).toBe(somaPorFamilia);
    });

    it('`undeclared` está vazio — nenhuma rota administrativa escapou das 12 famílias', () => {
      expect(inventarioVivo.undeclared).toEqual([]);
    });
  });

  describe('6 — O CAMINHO DA LUZ: chave de API real, com as 12 famílias enforçadas ao mesmo tempo', () => {
    let appChave: AppComTodasFamilias;

    beforeAll(async () => {
      setEnv('ENLITE_API_KEYS', `triage-service:${API_KEY_E2E}`);
      process.env.USE_MOCK_AUTH = 'false';

      const identity = await import('@modules/identity');
      const multi = new identity.MultiAuthService({ enableApiKeys: true, enableGoogleIdToken: false } as never);
      const authReal = new identity.AuthMiddleware(multi, new identity.SimplifiedAuthorizationEngine(), undefined as never);

      const mods = await importarModulosDeRotas();
      appChave = await montarAppComTodasFamilias({
        internalSecret: INTERNAL_SECRET,
        auth: authReal,
        montarRotas: (deps) => montarRotasCompostas(deps, mods),
      });

      // ⚠️ `USE_MOCK_AUTH` FICA 'false' até o `afterAll` deste describe — os
      // `it`s de baixo rodam DEPOIS deste `beforeAll` retornar, e
      // `mockAuthMiddleware` lê `process.env.USE_MOCK_AUTH` a cada request
      // (não fica preso no valor da construção). Se voltasse para 'true'
      // aqui, o mock rejeitaria a chave real da Luz com 401 ANTES do
      // `requireStaffOrApiKey` de verdade rodar — foi exatamente esse bug
      // que os 4 casos abaixo pegaram na 1ª rodada deste arquivo.
    }, 30000);

    afterAll(async () => {
      await appChave?.fechar();
      process.env.USE_MOCK_AUTH = 'true';
    });

    it.each(ROTAS_DA_LUZ)('%s %s atravessa as 12 famílias enforçadas — é o triage-service, não uma pessoa', async (metodo, caminho) => {
      const res = await chamar(metodo, caminho, null, appChave, { Authorization: `Bearer ${API_KEY_E2E}` });
      expect(res.status).not.toBe(403);
      expect(res.status).not.toBe(401);
    });

    it('chave inválida segue barrada — o desvio é para SERVIÇO AUTENTICADO, não para qualquer um', async () => {
      const res = await chamar('GET', '/api/admin/workers/by-phone', null, appChave, {
        Authorization: 'Bearer enlite_chave_que_nao_existe',
      });
      expect(res.status).toBe(401);
    });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    expect((await chamar('GET', '/api/admin/users', null, app)).status).toBe(401);
  });
});
