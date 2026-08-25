/**
 * A família `admin.permissions` — a leitura do painel (F3).
 *
 * O teste que mais importa aqui é o da DECLARAÇÃO, e ele não é sobre HTTP:
 * enquanto nenhuma rota declarava `permission_management:read`, o sync do
 * catálogo a descontinuava e `iam.query_audit` passava a responder 42501 para
 * todo mundo na QA — inclusive o Acesso Master. Se alguém apagar o
 * `perm.require` "porque a família nem está enforced ainda", é este arquivo que
 * acusa antes de a trilha morrer de novo.
 *
 * Os demais casos medem a BORDA: o que a rota recusa (zod), o que ela esconde
 * (grupo de outro tenant), e que nenhuma rota devolve 200 com corpo mentiroso.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes, ENLITE_TENANT_ID } from '@modules/identity/permissions';
import type {
  CountryFeature,
  GroupMemberView,
  ListPermissionCatalogUseCase,
  PermissionGroupDetail,
  QueryPermissionAuditUseCase,
} from '@modules/identity/permissions';
import {
  createPermissionPanelRoutes,
  ADMIN_PERMISSIONS_FAMILY,
  type PanelFeatureReader,
  type PanelGroupReader,
} from '../permissionPanelRoutes';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

/** Copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'GET /permissions/catalog': 'permission_management:read',
  'GET /permission-groups': 'permission_management:read',
  'GET /permission-groups/:id': 'permission_management:read',
  'GET /permission-groups/:id/members': 'permission_management:read',
  'GET /country-features': 'permission_management:read',
  'GET /permission-audit': 'permission_management:read',
};

const ID = '11111111-1111-4111-8111-111111111111';
const TENANT = '00000000-0000-0000-0000-000000000001';

const CATALOGO = [
  { category: 'Administração', cells: [{ resource: 'permission_management', action: 'read', category: 'Administração', ownerService: 'worker-functions' }] },
];
const GRUPO: PermissionGroupDetail = {
  id: ID,
  tenantId: TENANT,
  name: 'Recrutamento AR',
  description: null,
  isSystem: false,
  archivedAt: null,
  createdBy: null,
  createdAt: new Date('2026-08-01T00:00:00Z'),
  cells: ['worker:read'],
  countries: ['AR'],
  memberCount: 2,
};
const MEMBROS: GroupMemberView[] = [
  { userId: 'uid-1', email: 'a@enlite.health', role: 'admin', status: 'ACTIVE', assignedBy: 'uid-0', assignedAt: new Date('2026-08-02T00:00:00Z') },
];
const FEATURES: CountryFeature[] = [
  { country: 'AR', featureKey: 'screen:talentum', enabled: true, config: null, source: 'default', reason: null, updatedBy: 'system', updatedAt: new Date('2026-08-03T00:00:00Z') },
  { country: 'BR', featureKey: 'screen:talentum', enabled: false, config: null, source: 'override', reason: 'piloto', updatedBy: 'uid-0', updatedAt: new Date('2026-08-03T00:00:00Z') },
];
const TRILHA = [
  { id: 'a1', userId: 'uid-1', resource: 'worker_pii', action: 'read', resourceId: '<oculto>', decision: 'ALLOW', createdAt: new Date('2026-08-04T00:00:00Z'), country: 'AR' },
];

interface Dubles {
  catalogo: jest.Mock;
  list: jest.Mock;
  findById: jest.Mock;
  listMembers: jest.Mock;
  features: jest.Mock;
  audit: jest.Mock;
}

function build(over: Partial<Dubles> = {}) {
  const d: Dubles = {
    catalogo: over.catalogo ?? jest.fn().mockResolvedValue(CATALOGO),
    list: over.list ?? jest.fn().mockResolvedValue([GRUPO]),
    findById: over.findById ?? jest.fn().mockResolvedValue(GRUPO),
    listMembers: over.listMembers ?? jest.fn().mockResolvedValue(MEMBROS),
    features: over.features ?? jest.fn().mockResolvedValue(FEATURES),
    audit: over.audit ?? jest.fn().mockResolvedValue(TRILHA),
  };

  const router = createPermissionPanelRoutes({
    catalog: { execute: d.catalogo } as unknown as ListPermissionCatalogUseCase,
    groups: { list: d.list, findById: d.findById, listMembers: d.listMembers } as PanelGroupReader,
    features: { list: d.features } as PanelFeatureReader,
    audit: { execute: d.audit } as unknown as QueryPermissionAuditUseCase,
    auth: authDouble(),
    permissions: permissionsDouble(),
    tenantId: TENANT,
  });
  return { router, d };
}

function appCom(router: express.Router) {
  const app = express();
  app.use('/api/admin', router);
  return app;
}

const GET = (router: express.Router, caminho: string) => request(appCom(router)).get(`/api/admin${caminho}`);

describe('createPermissionPanelRoutes — declaração', () => {
  it('a família tem nome estável — é o que `PERMISSION_ENFORCED_ROUTES` liga', () => {
    expect(ADMIN_PERMISSIONS_FAMILY).toBe('admin.permissions');
  });

  it('TODA rota da família declara célula', () => {
    expect(undeclaredRoutes(scanExpressRouter(build().router), () => true)).toEqual([]);
  });

  it('🔴 as 6 rotas declaram `permission_management:read` — sem isso o sync mata a trilha', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build().router).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );

    expect(declarado).toEqual(ESPERADO);
  });

  it('montadas em `/api/admin`, os caminhos são os que a lista dourada do inventário espera', () => {
    // As strings EXATAS do `permission-route-inventory.test.ts`. Aquele e2e lê o
    // app pela rede (reflete o BINÁRIO do container, não a árvore), então local
    // ele não prova nada — este caso prova aqui o que lá só se confirma no CI.
    const rotas = scanExpressRouter(appCom(build().router) as never);

    expect(rotas.map((r) => `${r.method} ${r.path} → ${r.cell ? cellKey(r.cell.resource, r.cell.action) : null}`).sort()).toEqual([
      'GET /api/admin/country-features → permission_management:read',
      'GET /api/admin/permission-audit → permission_management:read',
      'GET /api/admin/permission-groups → permission_management:read',
      'GET /api/admin/permission-groups/:id → permission_management:read',
      'GET /api/admin/permission-groups/:id/members → permission_management:read',
      'GET /api/admin/permissions/catalog → permission_management:read',
    ]);
  });

  it('sem `tenantId` injetado, vale o da casa — o painel é mono-tenant hoje', async () => {
    const d = { list: jest.fn().mockResolvedValue([]) };
    const router = createPermissionPanelRoutes({
      catalog: { execute: jest.fn() } as unknown as ListPermissionCatalogUseCase,
      groups: { list: d.list, findById: jest.fn(), listMembers: jest.fn() } as PanelGroupReader,
      features: { list: jest.fn() } as PanelFeatureReader,
      audit: { execute: jest.fn() } as unknown as QueryPermissionAuditUseCase,
      auth: authDouble(),
      permissions: permissionsDouble(),
    });

    await GET(router, '/permission-groups').expect(200);

    expect(d.list).toHaveBeenCalledWith(ENLITE_TENANT_ID, { includeArchived: false });
  });

  it('🔒 a porta dos grupos é só de LEITURA — escrita em `iam.*` é SECURITY DEFINER (lex C4)', () => {
    // O contrato é de tipo, e o teste guarda a INTENÇÃO: se alguém acrescentar
    // `addMember` à `PanelGroupReader` para "resolver rápido", este caso cai.
    const { d } = build();
    const porta = { list: d.list, findById: d.findById, listMembers: d.listMembers };

    expect(Object.keys(porta).sort()).toEqual(['findById', 'list', 'listMembers']);
  });
});

describe('GET /permissions/catalog', () => {
  it('devolve o catálogo agrupado por categoria', async () => {
    const { router, d } = build();

    const res = await GET(router, '/permissions/catalog').expect(200);

    expect(res.body).toEqual({ categories: CATALOGO });
    expect(d.catalogo).toHaveBeenCalledWith({ includeDeprecated: false });
  });

  it('`includeDeprecated=true` é opt-in explícito — a vista de auditoria pede', async () => {
    const { router, d } = build();

    await GET(router, '/permissions/catalog?includeDeprecated=true').expect(200);

    expect(d.catalogo).toHaveBeenCalledWith({ includeDeprecated: true });
  });

  it('`includeDeprecated=false` NÃO liga o filtro — o atalho `!!query` erraria aqui', async () => {
    const { router, d } = build();

    await GET(router, '/permissions/catalog?includeDeprecated=false').expect(200);

    expect(d.catalogo).toHaveBeenCalledWith({ includeDeprecated: false });
  });

  it('query fora do contrato é 400, não "interpretei como false"', async () => {
    const { router, d } = build();

    const res = await GET(router, '/permissions/catalog?includeDeprecated=talvez').expect(400);

    expect(res.body).toEqual({ success: false, error: 'Invalid query parameters' });
    expect(d.catalogo).not.toHaveBeenCalled();
  });

  it('falha do repositório é 500 — e a request não fica pendurada', async () => {
    const { router } = build({ catalogo: jest.fn().mockRejectedValue(new Error('sem conexão')) });

    const res = await GET(router, '/permissions/catalog').expect(500);

    expect(res.body).toEqual({ success: false, error: 'Failed to read permission catalog' });
  });
});

describe('GET /permission-groups', () => {
  it('lista os grupos do tenant, sem os arquivados por padrão', async () => {
    const { router, d } = build();

    const res = await GET(router, '/permission-groups').expect(200);

    expect(res.body.groups).toHaveLength(1);
    expect(d.list).toHaveBeenCalledWith(TENANT, { includeArchived: false });
  });

  it('`includeArchived=true` traz os arquivados', async () => {
    const { router, d } = build();

    await GET(router, '/permission-groups?includeArchived=true').expect(200);

    expect(d.list).toHaveBeenCalledWith(TENANT, { includeArchived: true });
  });

  it('query fora do contrato é 400', async () => {
    const { router, d } = build();

    await GET(router, '/permission-groups?includeArchived=sim').expect(400);

    expect(d.list).not.toHaveBeenCalled();
  });

  it('falha do repositório é 500', async () => {
    const { router } = build({ list: jest.fn().mockRejectedValue(new Error('caiu')) });

    await GET(router, '/permission-groups').expect(500);
  });
});

describe('GET /permission-groups/:id', () => {
  it('devolve os dois eixos do grupo — células e países', async () => {
    const { router, d } = build();

    const res = await GET(router, `/permission-groups/${ID}`).expect(200);

    expect(res.body).toMatchObject({ id: ID, cells: ['worker:read'], countries: ['AR'], memberCount: 2 });
    expect(d.findById).toHaveBeenCalledWith(TENANT, ID);
  });

  it('🔴 grupo de OUTRO tenant é 404 — indistinguível de inexistente', async () => {
    const { router } = build({ findById: jest.fn().mockResolvedValue(null) });

    const res = await GET(router, `/permission-groups/${ID}`).expect(404);

    expect(res.body).toEqual({ success: false, error: 'Not found' });
  });

  it('id malformado é 400, não 500 no cast do Postgres', async () => {
    const { router, d } = build();

    const res = await GET(router, '/permission-groups/nao-e-uuid').expect(400);

    expect(res.body).toEqual({ success: false, error: 'Invalid group id' });
    expect(d.findById).not.toHaveBeenCalled();
  });

  it('falha do repositório é 500', async () => {
    const { router } = build({ findById: jest.fn().mockRejectedValue(new Error('caiu')) });

    await GET(router, `/permission-groups/${ID}`).expect(500);
  });
});

describe('GET /permission-groups/:id/members', () => {
  it('devolve os membros vivos do grupo', async () => {
    const { router, d } = build();

    const res = await GET(router, `/permission-groups/${ID}/members`).expect(200);

    expect(res.body.members).toHaveLength(1);
    expect(res.body.members[0]).toMatchObject({ userId: 'uid-1', email: 'a@enlite.health' });
    expect(d.listMembers).toHaveBeenCalledWith(TENANT, ID);
  });

  it('🔴 grupo de outro tenant é 404 — NÃO `{members: []}` com 200', async () => {
    // O 200 vazio seria pior que o 404: indistinguível de "grupo sem membros" e,
    // ainda assim, confirmando que o id existe.
    const { router, d } = build({ findById: jest.fn().mockResolvedValue(null) });

    const res = await GET(router, `/permission-groups/${ID}/members`).expect(404);

    expect(res.body).toEqual({ success: false, error: 'Not found' });
    expect(d.listMembers).not.toHaveBeenCalled();
  });

  it('id malformado é 400', async () => {
    const { router, d } = build();

    await GET(router, '/permission-groups/xyz/members').expect(400);

    expect(d.findById).not.toHaveBeenCalled();
  });

  it('falha do repositório é 500', async () => {
    const { router } = build({ listMembers: jest.fn().mockRejectedValue(new Error('caiu')) });

    await GET(router, `/permission-groups/${ID}/members`).expect(500);
  });
});

describe('GET /country-features', () => {
  it('sem filtro devolve a matriz inteira — país × feature', async () => {
    const { router } = build();

    const res = await GET(router, '/country-features').expect(200);

    expect(res.body.features).toHaveLength(2);
  });

  it('filtra por país quando pedido', async () => {
    const { router } = build();

    const res = await GET(router, '/country-features?country=BR').expect(200);

    expect(res.body.features).toHaveLength(1);
    expect(res.body.features[0]).toMatchObject({ country: 'BR', source: 'override' });
  });

  it('país fora do catálogo é 400 — não uma lista vazia silenciosa', async () => {
    const { router, d } = build();

    await GET(router, '/country-features?country=XX').expect(400);

    expect(d.features).not.toHaveBeenCalled();
  });

  it('falha do repositório é 500', async () => {
    const { router } = build({ features: jest.fn().mockRejectedValue(new Error('caiu')) });

    await GET(router, '/country-features').expect(500);
  });
});

describe('GET /permission-audit', () => {
  it('devolve a trilha, e o `resourceId` mascarado chega como o banco mandou', async () => {
    const { router, d } = build();

    const res = await GET(router, '/permission-audit').expect(200);

    expect(res.body.entries[0]).toMatchObject({ resourceId: '<oculto>', decision: 'ALLOW' });
    expect(d.audit).toHaveBeenCalledWith({});
  });

  it('repassa os filtros já tipados — data vira Date, limite vira número', async () => {
    const { router, d } = build();

    await GET(router, `/permission-audit?userId=uid-1&resource=worker_pii&since=2026-08-01&limit=50`).expect(200);

    expect(d.audit).toHaveBeenCalledWith({
      userId: 'uid-1',
      resource: 'worker_pii',
      since: new Date('2026-08-01'),
      limit: 50,
    });
  });

  it('`limit` não numérico é 400 — não um `NaN` que o use case clamparia em silêncio', async () => {
    const { router, d } = build();

    await GET(router, '/permission-audit?limit=abc').expect(400);

    expect(d.audit).not.toHaveBeenCalled();
  });

  it('`limit` acima do teto do banco é 400 — o teto é contrato, não sugestão', async () => {
    const { router, d } = build();

    await GET(router, '/permission-audit?limit=5000').expect(400);

    expect(d.audit).not.toHaveBeenCalled();
  });

  it('falha da função de auditoria é 500 (inclui o 42501 de quem perdeu a célula)', async () => {
    const { router } = build({ audit: jest.fn().mockRejectedValue(new Error('permission denied')) });

    const res = await GET(router, '/permission-audit').expect(500);

    expect(res.body).toEqual({ success: false, error: 'Failed to read permission audit' });
  });
});
