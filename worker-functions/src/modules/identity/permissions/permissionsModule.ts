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
import { GetMyAuthzUseCase } from './application/GetMyAuthzUseCase';
import { GrantGroupCountryUseCase, RevokeGroupCountryUseCase } from './application/GrantGroupCountryUseCase';
import { ListPermissionCatalogUseCase } from './application/ListPermissionCatalogUseCase';
import { QueryPermissionAuditUseCase } from './application/QueryPermissionAuditUseCase';
import { SetCountryFeatureUseCase } from './application/SetCountryFeatureUseCase';
import { SetGroupPermissionsUseCase } from './application/SetGroupPermissionsUseCase';
import { SyncCountryFeaturesUseCase } from './application/SyncCountryFeaturesUseCase';
import { SyncPermissionCatalogUseCase } from './application/SyncPermissionCatalogUseCase';
import { UpdatePermissionGroupUseCase } from './application/UpdatePermissionGroupUseCase';
import { DomainEventPermissionPublisher } from './infrastructure/DomainEventPermissionPublisher';
import { PgCountryFeatureRepository } from './infrastructure/PgCountryFeatureRepository';
import { PgEffectiveAuthzRepository } from './infrastructure/PgEffectiveAuthzRepository';
import { PgPermissionAuditRepository } from './infrastructure/PgPermissionAuditRepository';
import { PgPermissionCatalogRepository } from './infrastructure/PgPermissionCatalogRepository';
import { PgPermissionGroupRepository } from './infrastructure/PgPermissionGroupRepository';
import { PgRolloutStateRepository } from './infrastructure/PgRolloutStateRepository';

export interface PermissionsModuleDeps {
  /** Pool da request (proxy RLS-aware de `DatabaseConnection.getPool()`). */
  pool: Pool;
  /** Pool de sistema (`DatabaseConnection.getSystemPool()`) — sync do boot. */
  systemPool: Pool;
  /** Papéis que contam como staff do painel (injetado: o módulo é extraível). */
  staffRoles: readonly string[];
  ttlMs?: number;
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
  assertStaffHasGroup: AssertNoActiveStaffWithoutGroupUseCase;
  /** Repositórios expostos só para leitura da API do painel (grupo 4). */
  repositories: {
    groups: PgPermissionGroupRepository;
    catalog: PgPermissionCatalogRepository;
    features: PgCountryFeatureRepository;
    authz: PgEffectiveAuthzRepository;
    audit: PgPermissionAuditRepository;
  };
}

export function createPermissionsModule(deps: PermissionsModuleDeps): PermissionsModule {
  const groupsRepo = new PgPermissionGroupRepository(deps.pool);
  const catalogRepo = new PgPermissionCatalogRepository(deps.pool, deps.systemPool);
  const featuresRepo = new PgCountryFeatureRepository(deps.pool, deps.systemPool);
  const authzRepo = new PgEffectiveAuthzRepository(deps.pool, deps.staffRoles);
  const auditRepo = new PgPermissionAuditRepository(deps.pool);
  const rolloutRepo = new PgRolloutStateRepository(deps.pool);
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
    authz: new GetMyAuthzUseCase(client),
    assertStaffHasGroup: new AssertNoActiveStaffWithoutGroupUseCase(authzRepo, rolloutRepo),
    repositories: {
      groups: groupsRepo,
      catalog: catalogRepo,
      features: featuresRepo,
      authz: authzRepo,
      audit: auditRepo,
    },
  };
}
