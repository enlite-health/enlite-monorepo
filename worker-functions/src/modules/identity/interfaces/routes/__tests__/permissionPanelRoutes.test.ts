/**
 * A família `admin.permissions` — a leitura do painel (F3).
 *
 * O teste que mais importa aqui é o primeiro, e ele não é sobre HTTP: é a
 * DECLARAÇÃO de `permission_management:read`. Enquanto nenhuma rota declarava
 * essa célula, o sync do catálogo a descontinuava e `iam.query_audit` passava a
 * responder 42501 para todo mundo na QA — inclusive o Acesso Master. Se alguém
 * apagar o `perm.require` desta rota "porque a família nem está enforced
 * ainda", este teste é o que acusa antes de a trilha morrer de novo.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import type { ListPermissionCatalogUseCase } from '@modules/identity/permissions';
import { createPermissionPanelRoutes, ADMIN_PERMISSIONS_FAMILY } from '../permissionPanelRoutes';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

/** Copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'GET /permissions/catalog': 'permission_management:read',
};

const CATALOGO = [
  { category: 'Administração', cells: [{ resource: 'permission_management', action: 'read', category: 'Administração', ownerService: 'worker-functions' }] },
];

function build(over: { execute?: jest.Mock } = {}) {
  const execute = over.execute ?? jest.fn().mockResolvedValue(CATALOGO);
  const router = createPermissionPanelRoutes(
    { execute } as unknown as ListPermissionCatalogUseCase,
    authDouble(),
    permissionsDouble(),
  );
  return { router, execute };
}

function appCom(router: express.Router) {
  const app = express();
  app.use('/api/admin', router);
  return app;
}

describe('createPermissionPanelRoutes', () => {
  it('a família tem nome estável — é o que `PERMISSION_ENFORCED_ROUTES` liga', () => {
    expect(ADMIN_PERMISSIONS_FAMILY).toBe('admin.permissions');
  });

  it('TODA rota da família declara célula', () => {
    expect(undeclaredRoutes(scanExpressRouter(build().router), () => true)).toEqual([]);
  });

  it('🔴 o catálogo declara `permission_management:read` — sem isso o sync mata a trilha', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build().router).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );

    expect(declarado).toEqual(ESPERADO);
  });

  it('montada em `/api/admin`, a rota é `GET /api/admin/permissions/catalog`', () => {
    // A string EXATA que a lista dourada do `permission-route-inventory.test.ts`
    // espera. Aquele e2e lê o app pela rede (reflete o BINÁRIO do container, não
    // a árvore), então local ele não prova nada — este caso prova aqui o que lá
    // só se confirma no CI.
    const rotas = scanExpressRouter(appCom(build().router) as never);

    expect(rotas.map((r) => `${r.method} ${r.path} → ${r.cell ? cellKey(r.cell.resource, r.cell.action) : null}`)).toEqual([
      'GET /api/admin/permissions/catalog → permission_management:read',
    ]);
  });

  it('devolve o catálogo agrupado por categoria', async () => {
    const { router, execute } = build();

    const res = await request(appCom(router)).get('/api/admin/permissions/catalog').expect(200);

    expect(res.body).toEqual({ categories: CATALOGO });
    expect(execute).toHaveBeenCalledWith({ includeDeprecated: false });
  });

  it('sem `includeDeprecated` a tela de grupo NÃO recebe célula morta para marcar', async () => {
    const { router, execute } = build();

    await request(appCom(router)).get('/api/admin/permissions/catalog?includeDeprecated=false').expect(200);

    expect(execute).toHaveBeenCalledWith({ includeDeprecated: false });
  });

  it('`includeDeprecated=true` é opt-in explícito — a vista de auditoria pede', async () => {
    const { router, execute } = build();

    await request(appCom(router)).get('/api/admin/permissions/catalog?includeDeprecated=true').expect(200);

    expect(execute).toHaveBeenCalledWith({ includeDeprecated: true });
  });

  it('query fora do contrato é 400, não "interpretei como false"', async () => {
    const { router, execute } = build();

    const res = await request(appCom(router)).get('/api/admin/permissions/catalog?includeDeprecated=talvez').expect(400);

    expect(res.body).toEqual({ success: false, error: 'Invalid query parameters' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('falha do repositório é 500 — e a request não fica pendurada', async () => {
    const { router } = build({ execute: jest.fn().mockRejectedValue(new Error('sem conexão')) });

    const res = await request(appCom(router)).get('/api/admin/permissions/catalog').expect(500);

    expect(res.body).toEqual({ success: false, error: 'Failed to list permission catalog' });
  });
});
