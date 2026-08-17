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
  options: { uid?: string | null; resource?: string; action?: string } = {},
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
    if (uid) (req as express.Request).authContext = { principal: { id: uid } } as never;
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

  it('declara a célula no handler — é o que o scanner do catálogo lê', () => {
    const middleware = new PermissionMiddleware({ client: clientStub(), audit: { record: jest.fn() }, env: {} });
    const guard = middleware.family('admin.users').require('user_management', 'read', 'Ver usuários');
    const metadata = (guard as unknown as Record<symbol, unknown>)[Symbol.for('enlite.permissions.cell')];
    expect(metadata).toEqual({ resource: 'user_management', action: 'read', description: 'Ver usuários' });
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
