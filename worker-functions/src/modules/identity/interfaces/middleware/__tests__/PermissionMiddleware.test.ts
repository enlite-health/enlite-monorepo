/**
 * O gate das rotas do painel. Cada caso aqui é uma linha da spec
 * `permission-enforcement` / `staff-onboarding-gate`, e a ORDEM importa tanto
 * quanto o resultado: status antes de grupo, grupo antes de célula, e falha de
 * resolução NEGANDO (o caminho que, escrito ao contrário, transformaria banco
 * fora em acesso irrestrito).
 */

import express from 'express';
import request from 'supertest';
import { PermissionMiddleware } from '../PermissionMiddleware';
import type { PermissionClient, PermissionDecision, ResolvedAuthz } from '@modules/identity/permissions';
import { PrincipalType } from '@modules/identity/domain/Auth';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

jest.mock('@shared/database/requestDbSession', () => ({
  currentDbContext: jest.fn(),
}));
const { currentDbContext } = jest.requireMock('@shared/database/requestDbSession') as {
  currentDbContext: jest.Mock;
};

const UID = 'staff-1';

function authz(over: Partial<ResolvedAuthz> = {}): ResolvedAuthz {
  return {
    uid: UID,
    tenantId: 'tenant',
    status: 'ACTIVE',
    permissions: ['user_management:read'],
    countries: ['AR'],
    groups: [{ id: 'g1', name: 'Recrutador' }],
    ...over,
  };
}

function clientStub(over: Partial<PermissionClient> = {}): PermissionClient {
  return {
    resolve: jest.fn().mockResolvedValue(authz()),
    can: jest.fn(),
    isFeatureAvailable: jest.fn().mockResolvedValue(true),
    featureConfig: jest.fn(),
    invalidate: jest.fn(),
    ...over,
  };
}

interface Harness {
  app: express.Express;
  gravadas: PermissionDecision[];
}

function harness(
  env: NodeJS.ProcessEnv,
  client: PermissionClient,
  options: { uid?: string | null; resource?: string; action?: string; tipo?: PrincipalType } = {},
): Harness {
  const gravadas: PermissionDecision[] = [];
  const middleware = new PermissionMiddleware({
    client,
    audit: { record: (entry) => gravadas.push(entry) },
    env,
  });
  const app = express();
  app.use((req, _res, next) => {
    const uid = options.uid === undefined ? UID : options.uid;
    if (uid) {
      (req as express.Request).authContext = {
        principal: { id: uid, ...(options.tipo ? { type: options.tipo } : {}) },
      } as never;
    }
    next();
  });
  app.get(
    '/api/admin/users/:id',
    middleware.family('admin.users').require(options.resource ?? 'user_management', options.action ?? 'read'),
    (_req, res) => res.json({ ok: true }),
  );
  return { app, gravadas };
}

const LIGADO = { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.users' };

describe('PermissionMiddleware.family().require()', () => {
  afterEach(() => jest.clearAllMocks());

  it('com o engine DESLIGADO, passa sem nem resolver (ambiente neutro)', async () => {
    const client = clientStub();
    const { app } = harness({}, client);
    await request(app).get('/api/admin/users/1').expect(200);
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it('família fora de PERMISSION_ENFORCED_ROUTES passa como hoje', async () => {
    const client = clientStub();
    const { app } = harness(
      { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.patients' },
      client,
    );
    await request(app).get('/api/admin/users/1').expect(200);
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it('avisa UMA vez por família que a rota não está enforced (log de boot, não por request)', async () => {
    const client = clientStub();
    const { app } = harness(
      { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.patients' },
      client,
    );
    const { logger } = jest.requireMock('@shared/logging') as { logger: { info: jest.Mock } };

    await request(app).get('/api/admin/users/1').expect(200);
    await request(app).get('/api/admin/users/2').expect(200);

    expect(logger.info.mock.calls.filter((c) => String(c[1]).includes('não enforced'))).toHaveLength(1);
  });

  it('rota sem :id grava a negativa sem resourceId (nunca inventa alvo)', async () => {
    const gravadas: PermissionDecision[] = [];
    const middleware = new PermissionMiddleware({
      client: clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) }),
      audit: { record: (entry) => gravadas.push(entry) },
      env: LIGADO,
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request).authContext = { principal: { id: UID } } as never;
      next();
    });
    app.get('/api/admin/users', middleware.family('admin.users').require('user_management', 'read'), (_req, res) =>
      res.json({ ok: true }),
    );

    await request(app).get('/api/admin/users').expect(403);

    expect(gravadas[0].resourceId).toBeNull();
  });

  it('staff com a célula passa', async () => {
    const { app, gravadas } = harness(LIGADO, clientStub());
    await request(app).get('/api/admin/users/1').expect(200);
    // Leitura de gestão de usuário não é sensível — ALLOW não vira linha.
    expect(gravadas).toEqual([]);
  });

  it('staff sem a célula → 403 missing_cell, com a negativa na trilha', async () => {
    const client = clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) });
    const { app, gravadas } = harness(LIGADO, client);

    const res = await request(app).get('/api/admin/users/42').expect(403);

    expect(res.body.code).toBe('missing_cell');
    expect(res.body.reason).toContain('user_management:read');
    expect(gravadas).toEqual([
      expect.objectContaining({ userId: UID, decision: 'DENY', reason: 'missing_cell', resourceId: '42' }),
    ]);
  });

  it('staff sem NENHUM grupo → 403 no_group (a tela de boas-vindas lê este código)', async () => {
    const client = clientStub({
      resolve: jest.fn().mockResolvedValue(authz({ groups: [], permissions: [] })),
    });
    const { app } = harness(LIGADO, client);
    const res = await request(app).get('/api/admin/users/1').expect(403);
    expect(res.body.code).toBe('no_group');
  });

  it('conta não-ACTIVE é negada ANTES de olhar grupos, mesmo com a célula', async () => {
    const client = clientStub({
      resolve: jest.fn().mockResolvedValue(authz({ status: 'PENDING_ONBOARDING' })),
    });
    const { app } = harness(LIGADO, client);
    const res = await request(app).get('/api/admin/users/1').expect(403);
    expect(res.body.code).toBe('account_not_active');
  });

  it('falha ao resolver NEGA (nunca libera por padrão)', async () => {
    const client = clientStub({ resolve: jest.fn().mockRejectedValue(new Error('banco fora')) });
    const { app, gravadas } = harness(LIGADO, client);
    const res = await request(app).get('/api/admin/users/1').expect(403);
    expect(res.body.code).toBe('resolve_failed');
    expect(gravadas[0]).toMatchObject({ decision: 'DENY', reason: 'resolve_failed' });
  });

  it('sem principal → 401 e nada na trilha (não há a quem atribuir)', async () => {
    const { app, gravadas } = harness(LIGADO, clientStub(), { uid: null });
    await request(app).get('/api/admin/users/1').expect(401);
    expect(gravadas).toEqual([]);
  });

  it('REPORT_ONLY registra a negativa e deixa passar', async () => {
    const client = clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) });
    const { app, gravadas } = harness({ ...LIGADO, PERMISSION_REPORT_ONLY: 'true' }, client);

    await request(app).get('/api/admin/users/1').expect(200);

    expect(gravadas[0]).toMatchObject({ decision: 'DENY', reason: 'missing_cell' });
  });

  it('ALLOW de recurso sensível vira linha na trilha (D-P4)', async () => {
    const client = clientStub({
      resolve: jest.fn().mockResolvedValue(authz({ permissions: ['worker_pii:read'] })),
    });
    const { app, gravadas } = harness(LIGADO, client, { resource: 'worker_pii', action: 'read' });

    await request(app).get('/api/admin/users/77').expect(200);

    expect(gravadas).toEqual([
      expect.objectContaining({ decision: 'ALLOW', resource: 'worker_pii', resourceId: '77' }),
    ]);
  });

  it('ALLOW de ação destrutiva também é registrado', async () => {
    const client = clientStub({
      resolve: jest.fn().mockResolvedValue(authz({ permissions: ['user_management:delete'] })),
    });
    const { app, gravadas } = harness(LIGADO, client, { action: 'delete' });

    await request(app).get('/api/admin/users/9').expect(200);

    expect(gravadas[0]).toMatchObject({ decision: 'ALLOW', action: 'delete' });
  });

  it('o log do ensaio usa o caminho COMPLETO, não o relativo ao router', async () => {
    const middleware = new PermissionMiddleware({
      client: clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) }),
      audit: { record: jest.fn() },
      env: { ...LIGADO, PERMISSION_REPORT_ONLY: 'true' },
    });
    const router = express.Router();
    router.get('/users/:id', middleware.family('admin.users').require('user_management', 'read'), (_req, res) =>
      res.json({ ok: true }),
    );
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request).authContext = { principal: { id: UID } } as never;
      next();
    });
    // Montado em prefixo: dentro do router, `req.path` seria só `/users/abc`.
    app.use('/api/admin', router);
    const { logger } = jest.requireMock('@shared/logging') as { logger: { warn: jest.Mock } };

    await request(app).get('/api/admin/users/abc?q=1').expect(200);

    expect(logger.warn.mock.calls[0][0]).toMatchObject({ path: '/api/admin/users/abc' });
  });

  // lex 0.2, condição M2-3. Com o REPORT_ONLY ligado esta linha leva o uid do
  // COLABORADOR junto; uid de staff + id de paciente na mesma linha, no bucket
  // global, é o que a condição C16 do lex 0.1 proíbe.
  it.each([
    ['uuid de paciente', '/api/admin/patients/3f2504e0-4f89-11d3-9a0c-0305e82c3301', '/api/admin/patients/:id'],
    ['telefone de prestador', '/api/dedup/groups/5491133334444', '/api/dedup/groups/:id'],
  ])('o log do ensaio NÃO leva %s — vai sanitizado', async (_caso, url, esperado) => {
    const middleware = new PermissionMiddleware({
      client: clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) }),
      audit: { record: jest.fn() },
      env: { ...LIGADO, PERMISSION_REPORT_ONLY: 'true' },
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request).authContext = { principal: { id: UID } } as never;
      next();
    });
    const router = express.Router();
    router.get('/:id', middleware.family('admin.users').require('user_management', 'read'), (_req, res) =>
      res.json({ ok: true }),
    );
    app.use(url.slice(0, url.lastIndexOf('/')), router);
    const { logger } = jest.requireMock('@shared/logging') as { logger: { warn: jest.Mock } };
    logger.warn.mockClear();

    await request(app).get(url).expect(200);

    const linha = logger.warn.mock.calls[0][0] as { path: string; uid: string };
    expect(linha.path).toBe(esperado);
    expect(linha.uid).toBe(UID); // o uid segue lá — é a razão de a rota ter de estar limpa
    expect(JSON.stringify(linha)).not.toContain('3f2504e0');
    expect(JSON.stringify(linha)).not.toContain('5491133334444');
  });

  it('nome legítimo de rota NÃO é colapsado (o relatório precisa dizer qual endpoint é)', async () => {
    const middleware = new PermissionMiddleware({
      client: clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) }),
      audit: { record: jest.fn() },
      env: { ...LIGADO, PERMISSION_REPORT_ONLY: 'true' },
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request).authContext = { principal: { id: UID } } as never;
      next();
    });
    app.get(
      '/api/admin/bulk-dispatch-incomplete-workers',
      middleware.family('admin.users').require('user_management', 'read'),
      (_req, res) => res.json({ ok: true }),
    );
    const { logger } = jest.requireMock('@shared/logging') as { logger: { warn: jest.Mock } };
    logger.warn.mockClear();

    await request(app).get('/api/admin/bulk-dispatch-incomplete-workers').expect(200);

    expect((logger.warn.mock.calls[0][0] as { path: string }).path).toBe(
      '/api/admin/bulk-dispatch-incomplete-workers',
    );
  });

  it('sem originalUrl (chamada fora do Express), cai no path — nunca fica sem caminho', async () => {
    const gravadas: PermissionDecision[] = [];
    const middleware = new PermissionMiddleware({
      client: clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) }),
      audit: { record: (entry) => gravadas.push(entry) },
      env: { ...LIGADO, PERMISSION_REPORT_ONLY: 'true' },
    });
    const guard = middleware.family('admin.users').require('user_management', 'read');
    const req = {
      path: '/api/admin/users',
      params: {},
      authContext: { principal: { id: UID } },
    } as unknown as express.Request;
    const next = jest.fn();

    await guard(req, {} as express.Response, next);

    const { logger } = jest.requireMock('@shared/logging') as { logger: { warn: jest.Mock } };
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ path: '/api/admin/users' });
    expect(next).toHaveBeenCalled();
  });

  it('declara a célula no handler — é o que o scanner do catálogo lê', () => {
    const middleware = new PermissionMiddleware({ client: clientStub(), audit: { record: jest.fn() }, env: {} });
    const guard = middleware.family('admin.users').require('user_management', 'read', 'Ver usuários');
    const metadata = (guard as unknown as Record<symbol, unknown>)[Symbol.for('enlite.permissions.cell')];
    expect(metadata).toEqual({ resource: 'user_management', action: 'read', description: 'Ver usuários' });
  });
});

/**
 * O DESVIO DE PRINCIPAL DE SERVIÇO (família `admin.workers`, task 3.5-A1).
 *
 * 4 rotas de `/api/admin/workers/*` são `requireStaffOrApiKey` e quem as consome
 * é o triage-service (a Luz) por chave de API. Chave de API é serviço, não
 * pessoa: `principal.id` vale `service:<nome>` e não existe em `users`. Sem o
 * desvio, virar a família derrubaria a Luz em produção com 403.
 */
describe('principal de SERVIÇO (o caminho da chave de API)', () => {
  afterEach(() => jest.clearAllMocks());

  it('atravessa a família enforced sem resolver permissão — não tem grupo para resolver', async () => {
    const client = clientStub();
    const { app, gravadas } = harness(LIGADO, client, {
      uid: 'service:triage-service',
      tipo: PrincipalType.SERVICE,
    });

    await request(app).get('/api/admin/users/1').expect(200);

    expect(client.resolve).not.toHaveBeenCalled();
    expect(gravadas).toEqual([]);
  });

  it('avisa UMA vez por célula, não por request (o volume da Luz encheria o log)', async () => {
    const { logger } = jest.requireMock('@shared/logging') as { logger: { info: jest.Mock } };
    const { app } = harness(LIGADO, clientStub(), {
      uid: 'service:triage-service',
      tipo: PrincipalType.SERVICE,
    });

    await request(app).get('/api/admin/users/1').expect(200);
    await request(app).get('/api/admin/users/2').expect(200);

    const avisos = logger.info.mock.calls.filter((c) => String(c[1]).includes('principal de serviço'));
    expect(avisos).toHaveLength(1);
  });

  it('o desvio é POSITIVO: principal SEM tipo declarado continua sendo decidido por célula', async () => {
    // A forma negativa ("não é staff, então passa") liberaria qualquer principal
    // cujo papel não fosse reconhecido — o oposto de fail-closed. Este caso é a
    // prova de que a regra não foi escrita ao contrário.
    const client = clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) });
    const { app } = harness(LIGADO, client, { uid: 'pessoa-sem-tipo' });

    const res = await request(app).get('/api/admin/users/1').expect(403);

    expect(res.body).toMatchObject({ code: 'missing_cell' });
    expect(client.resolve).toHaveBeenCalled();
  });

  it('principal de outro tipo (USER) também é decidido por célula', async () => {
    const client = clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) });
    const { app } = harness(LIGADO, client, { uid: UID, tipo: PrincipalType.USER });

    await request(app).get('/api/admin/users/1').expect(403);

    expect(client.resolve).toHaveBeenCalled();
  });
});

describe('PermissionMiddleware.requireCountryFeature()', () => {
  function appComFeature(env: NodeJS.ProcessEnv, client: PermissionClient) {
    const middleware = new PermissionMiddleware({ client, audit: { record: jest.fn() }, env });
    const app = express();
    app.get('/api/admin/telas/x', middleware.requireCountryFeature('screen:x'), (_req, res) => res.json({ ok: true }));
    return app;
  }

  afterEach(() => jest.clearAllMocks());

  it('com o engine desligado, não opina', async () => {
    currentDbContext.mockReturnValue({ kind: 'staff', country: 'BR' });
    const client = clientStub({ isFeatureAvailable: jest.fn().mockResolvedValue(false) });
    await request(appComFeature({}, client)).get('/api/admin/telas/x').expect(200);
    expect(client.isFeatureAvailable).not.toHaveBeenCalled();
  });

  it('feature disponível no país → segue', async () => {
    currentDbContext.mockReturnValue({ kind: 'staff', country: 'AR' });
    const client = clientStub({ isFeatureAvailable: jest.fn().mockResolvedValue(true) });
    await request(appComFeature({ PERMISSION_ENGINE_ENABLED: 'true' }, client)).get('/api/admin/telas/x').expect(200);
  });

  it('indisponível no país → 404, indistinguível de inexistente', async () => {
    currentDbContext.mockReturnValue({ kind: 'staff', country: 'BR' });
    const client = clientStub({ isFeatureAvailable: jest.fn().mockResolvedValue(false) });
    const res = await request(appComFeature({ PERMISSION_ENGINE_ENABLED: 'true' }, client))
      .get('/api/admin/telas/x')
      .expect(404);
    expect(res.body).toEqual({ success: false, error: 'Not found' });
  });

  it('falha ao ler disponibilidade é tratada como indisponível (fail-closed)', async () => {
    currentDbContext.mockReturnValue({ kind: 'staff', country: 'AR' });
    const client = clientStub({ isFeatureAvailable: jest.fn().mockRejectedValue(new Error('fora')) });
    await request(appComFeature({ PERMISSION_ENGINE_ENABLED: 'true' }, client)).get('/api/admin/telas/x').expect(404);
  });

  it.each([
    ['contexto de sistema', { kind: 'system', systemContext: 'job:x' }],
    ['staff sem país declarado', { kind: 'staff' }],
    ['sem contexto nenhum', undefined],
  ])('%s não é recortado por país', async (_nome, contexto) => {
    currentDbContext.mockReturnValue(contexto);
    const client = clientStub({ isFeatureAvailable: jest.fn().mockResolvedValue(false) });
    await request(appComFeature({ PERMISSION_ENGINE_ENABLED: 'true' }, client)).get('/api/admin/telas/x').expect(200);
    expect(client.isFeatureAvailable).not.toHaveBeenCalled();
  });
});

/**
 * A canalização da C3: o handler precisa das células para decidir se o KMS roda.
 * Se ela quebrar, `projectWorkerFields` recebe `null` e devolve TUDO — o
 * vazamento volta com a suíte verde, porque nenhum outro teste olha para cá.
 */
describe('as células chegam ao handler (C3 da F2)', () => {
  afterEach(() => jest.clearAllMocks());

  function harnessQueEcoaCelulas(env: NodeJS.ProcessEnv) {
    const middleware = new PermissionMiddleware({
      client: clientStub(),
      audit: { record: () => undefined },
      env,
    });
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request).authContext = { principal: { id: UID } } as never;
      next();
    });
    app.get(
      '/api/admin/users/:id',
      middleware.family('admin.users').require('user_management', 'read'),
      (req, res) => res.json({ cells: req.permissionCells ?? null }),
    );
    return app;
  }

  it('com a família ENFORCED, o handler recebe as células do ator', async () => {
    const res = await request(harnessQueEcoaCelulas(LIGADO)).get('/api/admin/users/abc');

    expect(res.status).toBe(200);
    expect(res.body.cells).toContain('user_management:read');
  });

  it('com a família FORA do enforcement, chega `null` — nunca `[]`', async () => {
    const res = await request(harnessQueEcoaCelulas({ PERMISSION_ENGINE_ENABLED: 'true' })).get(
      '/api/admin/users/abc',
    );

    expect(res.status).toBe(200);
    // `[]` aqui redigiria o nome de todo mundo com o engine ainda desligado.
    expect(res.body.cells).toBeNull();
  });
});

describe('PermissionMiddleware.family().exempt()', () => {
  it('carimba a isenção na montagem e é passthrough — o guard de papel continua sendo o portão', async () => {
    const middleware = new PermissionMiddleware({
      client: clientStub({ resolve: jest.fn().mockResolvedValue(authz({ permissions: [] })) }),
      audit: { record: jest.fn() },
      env: LIGADO,
    });
    const app = express();
    app.get('/v1/self', middleware.family('me').exempt('self (D116)'), (_req, res) => res.json({ ok: true }));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { scanExpressRouter } = require('@modules/identity/permissions') as typeof import('@modules/identity/permissions');
    const rota = scanExpressRouter(app).find((r) => r.path === '/v1/self');
    expect(rota?.exempt).toEqual({ reason: 'self (D116)' });
    expect(rota?.cell).toBeUndefined();

    // Sem célula e sem authz nenhum resolvido, a rota responde: a marca não decide.
    const res = await request(app).get('/v1/self');
    expect(res.status).toBe(200);
  });
});
