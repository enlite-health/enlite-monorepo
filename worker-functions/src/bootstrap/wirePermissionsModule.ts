/**
 * src/bootstrap/wirePermissionsModule.ts
 *
 * Liga o módulo de permissões (change `painel-grupos-permissao`) na app, em
 * TRÊS momentos que não podem ser um só:
 *
 *   1. `createPermissionsBoundary(...)` — ANTES das rotas. Cria o módulo, o
 *      `PermissionMiddleware` (que as rotas usam para declarar e decidir) e
 *      monta o guard global de rota-sem-declaração. Tem que vir antes porque
 *      middleware montado depois da rota não roda naquela rota.
 *   2. `wirePermissionsModule(...)` — DEPOIS das rotas. Handlers de invalidação
 *      de cache e os dois `/.well-known` (catálogo e inventário de rotas).
 *   3. `runPermissionsBootTasks(...)` — ANTES do `listen`, com o router pronto:
 *      varre as rotas, publica o índice do guard e sincroniza o catálogo.
 *
 * NEUTRO por padrão: com `PERMISSION_ENGINE_ENABLED` off nada aqui muda uma
 * resposta de rota.
 *
 * GATE DE BOOT (task 3.7) — com o engine LIGADO o processo se recusa a subir em
 * UM caso: a migração de dados de grupos não foi marcada neste ambiente
 * (`iam.rollout_state`). Subir assim apagaria o painel para todo mundo de uma
 * vez, e a revisão anterior do Cloud Run continua servindo — que é o desfecho
 * seguro.
 *
 * ⚠️ A task 3.7 previa um segundo caso, "syncCatalog() falhou", e ele NÃO foi
 * implementado — de propósito. O `SyncPermissionCatalogUseCase` (grupo 2) trata
 * falha e varredura vazia devolvendo `null` com log de erro, pela razão que ele
 * mesmo documenta: "catálogo velho serve; boot caído não". Derrubar o processo
 * por causa do catálogo tiraria do ar a app do prestador, os leads e os webhooks
 * — o mesmo estrago que o lex C2 vetou para o alarme de staff sem grupo. O
 * catálogo desatualizado degrada a TELA DE GRUPO (o gestor não vê uma célula
 * nova para conceder); não tira o acesso de ninguém.
 *
 * "Staff sem grupo" continua sendo ALERTA, nunca falha de boot (lex C2).
 */

import type { Express, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import {
  createPermissionsModule,
  createWellKnownPermissionsRouter,
  declaredCells,
  registerPermissionEventHandlers,
  scanExpressRouter,
  CATALOG_OWNER_SERVICE,
  ENLITE_TENANT_ID,
  type HandlerRegistry,
  type PermissionsModule,
  type ScannedRoute,
} from '@modules/identity/permissions';
import { STAFF_ROLES } from '@modules/identity';
import {
  PermissionMiddleware,
  denyUndeclaredRoutes,
  UndeclaredRouteRegistry,
  createPermissionRoutesInventoryRouter,
} from '@modules/identity';

export interface PermissionsBoundary {
  permissions: PermissionsModule;
  middleware: PermissionMiddleware;
  registry: UndeclaredRouteRegistry;
}

export interface CreateBoundaryDeps {
  app: Express;
  pool: Pool;
  systemPool: Pool;
}

function flagOn(name: string): boolean {
  return process.env[name] === 'true';
}

/** Passo 1 — antes das rotas. */
export function createPermissionsBoundary(deps: CreateBoundaryDeps): PermissionsBoundary {
  const permissions = createPermissionsModule({
    pool: deps.pool,
    systemPool: deps.systemPool,
    staffRoles: STAFF_ROLES,
  });

  const registry = new UndeclaredRouteRegistry();
  deps.app.use(denyUndeclaredRoutes(registry));

  return {
    permissions,
    registry,
    middleware: new PermissionMiddleware({
      client: permissions.client,
      audit: permissions.repositories.audit,
    }),
  };
}

export interface WirePermissionsDeps {
  app: Express;
  boundary: PermissionsBoundary;
  events: HandlerRegistry;
  /** Mesmo guard das rotas internas (X-Internal-Secret / OIDC). */
  internalGuard: RequestHandler;
}

/** Passo 2 — depois das rotas. */
export function wirePermissionsModule(deps: WirePermissionsDeps): void {
  const { permissions, registry } = deps.boundary;

  registerPermissionEventHandlers(deps.events, permissions.client);

  deps.app.use(
    '/.well-known',
    createWellKnownPermissionsRouter(permissions.catalog.list, deps.internalGuard, {
      ownerService: CATALOG_OWNER_SERVICE,
    }),
  );
  deps.app.use('/.well-known', createPermissionRoutesInventoryRouter(registry, deps.internalGuard));
}

/**
 * Passo 3 — antes do `listen`, com TODAS as rotas montadas (a varredura precisa
 * do router pronto). Lançar aqui derruba o boot de propósito; ver GATE acima.
 */
export async function runPermissionsBootTasks(
  app: Express,
  boundary: PermissionsBoundary,
): Promise<void> {
  const { permissions, registry } = boundary;
  const engineEnabled = flagOn('PERMISSION_ENGINE_ENABLED');

  const routes = scanExpressRouter(app);
  registry.publish(routes);
  const undeclared = registry.unexpectedlyUndeclared();
  if (undeclared.length > 0) {
    logger.error(
      { undeclared: undeclared.map((route: ScannedRoute) => `${route.method} ${route.path}`) },
      '[perm] rotas administrativas sem permissão declarada — negadas com o engine ligado',
    );
  }

  if (engineEnabled) await assertDataMigrationRan(permissions);

  if (flagOn('PERMISSION_CATALOG_SYNC_ENABLED')) {
    // O use case já loga sucesso e falha, e nunca lança (ver GATE acima).
    await permissions.catalog.sync.execute(declaredCells(routes));
  }
  if (flagOn('COUNTRY_FEATURES_SYNC_ENABLED')) {
    await permissions.features.sync.execute();
  }
  await permissions.assertStaffHasGroup.alertOnBoot(ENLITE_TENANT_ID, engineEnabled);

  logger.info(
    {
      catalogSync: flagOn('PERMISSION_CATALOG_SYNC_ENABLED'),
      featuresSync: flagOn('COUNTRY_FEATURES_SYNC_ENABLED'),
      engine: engineEnabled,
      routes: routes.length,
      declared: declaredCells(routes).length,
      undeclared: undeclared.length,
    },
    '[perm] módulo de permissões inicializado',
  );
}

async function assertDataMigrationRan(permissions: PermissionsModule): Promise<void> {
  const report = await permissions.assertStaffHasGroup.execute(ENLITE_TENANT_ID);
  if (report.migrated) return;
  throw new Error(
    '[perm] PERMISSION_ENGINE_ENABLED=true sem a migração de dados de grupos marcada em iam.rollout_state — ' +
      'rode o script da migração (grupo 5) antes de ligar o engine neste ambiente',
  );
}
