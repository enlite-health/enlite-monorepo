/**
 * src/modules/identity/permissions/permissionsModule.ts
 *
 * Composição do módulo num lugar só. Quem monta a app chama `createPermissionsModule`
 * e recebe (a) o `PermissionClient` — a única coisa que o resto do sistema
 * consome — e (b) os use cases, para a API do painel (grupo 4).
 *
 * Os dois pools são diferentes de propósito (D112): `pool` é o da request
 * (`app_runtime`, confinado, com o ator no GUC) e `systemPool` é o de sistema
 * (`app_system`), o único com EXECUTE nas funções de sync do boot.
 */

import type { Pool } from 'pg';
import { PermissionService, permissionCacheTtlMs } from './application/PermissionService';
import { AddGroupMemberUseCase, RemoveGroupMemberUseCase } from './application/GroupMembershipUseCase';
import { ArchiveGroupUseCase } from './application/ArchiveGroupUseCase';
import { AssertNoActiveStaffWithoutGroupUseCase } from './application/AssertNoActiveStaffWithoutGroupUseCase';
import { CreatePermissionGroupUseCase } from './application/CreatePermissionGroupUseCase';
import { EndGroupSimulationUseCase } from './application/EndGroupSimulationUseCase';
import { GetMyAuthzUseCase } from './application/GetMyAuthzUseCase';
import { GrantGroupCountryUseCase, RevokeGroupCountryUseCase } from './application/GrantGroupCountryUseCase';
import { ListPermissionCatalogUseCase } from './application/ListPermissionCatalogUseCase';
import { ListSimulatableGroupsUseCase } from './application/ListSimulatableGroupsUseCase';
import { QueryPermissionAuditUseCase } from './application/QueryPermissionAuditUseCase';
import { SetCountryFeatureUseCase } from './application/SetCountryFeatureUseCase';
import { SetGroupPermissionsUseCase } from './application/SetGroupPermissionsUseCase';
import { StartGroupSimulationUseCase } from './application/StartGroupSimulationUseCase';
import { SyncCountryFeaturesUseCase } from './application/SyncCountryFeaturesUseCase';
import { SyncPermissionCatalogUseCase } from './application/SyncPermissionCatalogUseCase';
import { UpdatePermissionGroupUseCase } from './application/UpdatePermissionGroupUseCase';
import { DomainEventPermissionPublisher } from './infrastructure/DomainEventPermissionPublisher';
import { PgCountryFeatureRepository } from './infrastructure/PgCountryFeatureRepository';
import { PgEffectiveAuthzRepository } from './infrastructure/PgEffectiveAuthzRepository';
import { PgGroupSimulationRepository } from './infrastructure/PgGroupSimulationRepository';
import { PgPermissionAuditRepository } from './infrastructure/PgPermissionAuditRepository';
import { PgPermissionCatalogRepository } from './infrastructure/PgPermissionCatalogRepository';
import { PgPermissionGroupRepository } from './infrastructure/PgPermissionGroupRepository';
import { PgRolloutStateRepository } from './infrastructure/PgRolloutStateRepository';

export interface PermissionsModuleDeps {
  /** Pool da request (proxy RLS-aware de `DatabaseConnection.getPool()`). */
  pool: Pool;
  /** Pool de sistema (`DatabaseConnection.getSystemPool()`) — sync do boot. */
  systemPool: Pool;
  ttlMs?: number;
  /**
   * `enforcement` do contrato `/v1/me/authz` (D268) — o MESMO
   * `isEnvFlagOn('PERMISSION_ENGINE_ENABLED')` que o wiring já lê para o
   * `PermissionMiddleware`, injetado aqui. Default `false`: quem constrói o
   * módulo sem passar a flag (teste antigo, script) recebe `enforcement: 'off'`,
   * nunca uma leitura de env escondida dentro do módulo.
   */
  engineEnabled?: boolean;
}

export interface PermissionsModule {
  client: PermissionService;
  groups: {
    create: CreatePermissionGroupUseCase;
    update: UpdatePermissionGroupUseCase;
    archive: ArchiveGroupUseCase;
    setPermissions: SetGroupPermissionsUseCase;
    grantCountry: GrantGroupCountryUseCase;
    revokeCountry: RevokeGroupCountryUseCase;
    addMember: AddGroupMemberUseCase;
    removeMember: RemoveGroupMemberUseCase;
  };
  catalog: { list: ListPermissionCatalogUseCase; sync: SyncPermissionCatalogUseCase };
  features: { set: SetCountryFeatureUseCase; sync: SyncCountryFeaturesUseCase };
  audit: QueryPermissionAuditUseCase;
  authz: GetMyAuthzUseCase;
  /** Spec 026 (D407) — simulação de grupo (só Acesso Master). */
  simulation: {
    list: ListSimulatableGroupsUseCase;
    start: StartGroupSimulationUseCase;
    end: EndGroupSimulationUseCase;
  };
  assertStaffHasGroup: AssertNoActiveStaffWithoutGroupUseCase;
  /** Repositórios expostos só para leitura da API do painel (grupo 4). */
  repositories: {
    groups: PgPermissionGroupRepository;
    catalog: PgPermissionCatalogRepository;
    features: PgCountryFeatureRepository;
    authz: PgEffectiveAuthzRepository;
    audit: PgPermissionAuditRepository;
    simulation: PgGroupSimulationRepository;
  };
}

export function createPermissionsModule(deps: PermissionsModuleDeps): PermissionsModule {
  const groupsRepo = new PgPermissionGroupRepository(deps.pool);
  const catalogRepo = new PgPermissionCatalogRepository(deps.pool, deps.systemPool);
  const featuresRepo = new PgCountryFeatureRepository(deps.pool, deps.systemPool);
  const authzRepo = new PgEffectiveAuthzRepository(deps.pool);
  const auditRepo = new PgPermissionAuditRepository(deps.pool);
  const rolloutRepo = new PgRolloutStateRepository(deps.pool);
  const simulationRepo = new PgGroupSimulationRepository(deps.pool);
  const events = new DomainEventPermissionPublisher(deps.pool);

  const client = new PermissionService(authzRepo, featuresRepo, {
    ttlMs: deps.ttlMs ?? permissionCacheTtlMs(),
  });

  return {
    client,
    groups: {
      create: new CreatePermissionGroupUseCase(groupsRepo),
      update: new UpdatePermissionGroupUseCase(groupsRepo, events),
      archive: new ArchiveGroupUseCase(groupsRepo, events),
      setPermissions: new SetGroupPermissionsUseCase(groupsRepo, catalogRepo, events),
      grantCountry: new GrantGroupCountryUseCase(groupsRepo, events),
      revokeCountry: new RevokeGroupCountryUseCase(groupsRepo, events),
      addMember: new AddGroupMemberUseCase(groupsRepo, events),
      removeMember: new RemoveGroupMemberUseCase(groupsRepo, events),
    },
    catalog: {
      list: new ListPermissionCatalogUseCase(catalogRepo),
      sync: new SyncPermissionCatalogUseCase(catalogRepo),
    },
    features: {
      set: new SetCountryFeatureUseCase(featuresRepo, events),
      sync: new SyncCountryFeaturesUseCase(featuresRepo),
    },
    audit: new QueryPermissionAuditUseCase(auditRepo),
    authz: new GetMyAuthzUseCase(client, deps.engineEnabled ?? false),
    simulation: {
      list: new ListSimulatableGroupsUseCase(groupsRepo),
      start: new StartGroupSimulationUseCase(simulationRepo, events),
      end: new EndGroupSimulationUseCase(simulationRepo, events),
    },
    assertStaffHasGroup: new AssertNoActiveStaffWithoutGroupUseCase(authzRepo, rolloutRepo),
    repositories: {
      groups: groupsRepo,
      catalog: catalogRepo,
      features: featuresRepo,
      authz: authzRepo,
      audit: auditRepo,
      simulation: simulationRepo,
    },
  };
}
