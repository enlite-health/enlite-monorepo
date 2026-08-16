/**
 * src/bootstrap/wirePermissionsModule.ts
 *
 * Liga o módulo de permissões (change `painel-grupos-permissao`, grupo 2) na
 * app. NEUTRO por padrão: nada aqui muda uma resposta de rota enquanto as flags
 * estiverem desligadas.
 *
 * O que roda SEMPRE (barato e sem efeito visível):
 *   · registro dos handlers de `permission.changed` / `country_feature.changed`
 *     — evento sem handler vira `failed` e acende o alerta de backlog (D82/D100);
 *   · `/.well-known/permissions` atrás do mesmo guard das rotas internas (lex C14);
 *   · alarme de "staff ativo sem grupo" (1 leitura por boot, nunca lança — lex C2).
 *
 * O que é GATED por flag (default off):
 *   · `PERMISSION_CATALOG_SYNC_ENABLED` — sincronizar o catálogo com as
 *     declarações das rotas. Fica off até o grupo 3 existir: hoje NENHUMA rota
 *     declara célula, e sincronizar um catálogo vazio abortaria (fail-closed do
 *     `SyncPermissionCatalogUseCase`) só para logar erro em todo boot;
 *   · `COUNTRY_FEATURES_SYNC_ENABLED` — semear os defaults do manifest em
 *     `iam.country_features`. Off até a virada porque escreve no banco de QA/prod
 *     e o `PermissionService` já cai no manifest em memória sem essas linhas.
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
} from '@modules/identity/permissions';
import { STAFF_ROLES } from '@modules/identity';

export interface WirePermissionsDeps {
  app: Express;
  pool: Pool;
  systemPool: Pool;
  events: HandlerRegistry;
  /** Mesmo guard das rotas internas (X-Internal-Secret / OIDC). */
  internalGuard: RequestHandler;
}

function flagOn(name: string): boolean {
  return process.env[name] === 'true';
}

export function wirePermissionsModule(deps: WirePermissionsDeps): PermissionsModule {
  const permissions = createPermissionsModule({
    pool: deps.pool,
    systemPool: deps.systemPool,
    staffRoles: STAFF_ROLES,
  });

  registerPermissionEventHandlers(deps.events, permissions.client);

  deps.app.use(
    '/.well-known',
    createWellKnownPermissionsRouter(permissions.catalog.list, deps.internalGuard, {
      ownerService: CATALOG_OWNER_SERVICE,
    }),
  );

  return permissions;
}

/**
 * Passos de boot que tocam o banco. Chamado DEPOIS de todas as rotas montadas
 * (a varredura precisa do router pronto) e sempre com `void` — nenhum deles tem
 * direito de atrasar ou impedir o `listen`.
 */
export async function runPermissionsBootTasks(
  app: Express,
  permissions: PermissionsModule,
): Promise<void> {
  if (flagOn('PERMISSION_CATALOG_SYNC_ENABLED')) {
    await permissions.catalog.sync.execute(declaredCells(scanExpressRouter(app)));
  }
  if (flagOn('COUNTRY_FEATURES_SYNC_ENABLED')) {
    await permissions.features.sync.execute();
  }
  await permissions.assertStaffHasGroup.alertOnBoot(
    ENLITE_TENANT_ID,
    flagOn('PERMISSION_ENGINE_ENABLED'),
  );
  logger.info(
    {
      catalogSync: flagOn('PERMISSION_CATALOG_SYNC_ENABLED'),
      featuresSync: flagOn('COUNTRY_FEATURES_SYNC_ENABLED'),
      engine: flagOn('PERMISSION_ENGINE_ENABLED'),
    },
    '[perm] módulo de permissões inicializado',
  );
}
