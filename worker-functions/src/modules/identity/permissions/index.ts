/**
 * identity/permissions — barrel do módulo de permissões (D115).
 *
 * ESTA é a fronteira: código de fora importa daqui e de mais lugar nenhum. O
 * teste `moduleBoundary.test.ts` falha se o módulo importar de outro módulo de
 * domínio, e o `.eslintrc` bloqueia o caminho inverso (importar
 * `@modules/identity/permissions/<subdir>` direto).
 *
 * O consumidor típico usa TRÊS coisas: o tipo `PermissionClient`, o factory
 * `createPermissionsModule` e o par declaração/varredura do catálogo. Os use
 * cases são exportados para a API do painel (grupo 4); os repositórios NÃO.
 *
 * @module identity/permissions
 */

// ── Porta de entrada e composição ────────────────────────────────────────────
export { createPermissionsModule } from './permissionsModule';
export type { PermissionsModule, PermissionsModuleDeps } from './permissionsModule';
export { PermissionService, permissionCacheTtlMs, DEFAULT_PERMISSION_CACHE_TTL_MS } from './application/PermissionService';
export type { FeaturesByCountry } from './application/PermissionService';

// ── Contratos ────────────────────────────────────────────────────────────────
export type {
  AuthzContract,
  CatalogSyncResult,
  DeclaredCell,
  GroupMemberView,
  PermissionAuditFilters,
  PermissionAuditRow,
  PermissionClient,
  PermissionDecision,
  ResolvedAuthz,
  StaffStatus,
} from './application/ports';

// ── Domínio (vocabulário compartilhado com a borda) ──────────────────────────
export {
  PERMISSION_CATEGORIES,
  RESOURCE_CATEGORY,
  UNCATEGORIZED,
  categoryFor,
  cellKey,
  isValidCellKey,
  parseCellKey,
} from './domain/PermissionCell';
export type { PermissionCategory, PermissionCell } from './domain/PermissionCell';
export { PermissionError, isPermissionError, toPermissionError } from './domain/PermissionError';
export type { PermissionErrorCode } from './domain/PermissionError';
export {
  assertValidGroupName,
  assertValidReason,
  containsLikelyPersonalData,
} from './domain/PermissionGroup';
export type { PermissionGroup, PermissionGroupDetail } from './domain/PermissionGroup';
export {
  assertValidFeatureConfig,
  assertValidFeatureKey,
  featureTypeOf,
  isValidFeatureKey,
  optionValues,
} from './domain/CountryFeature';
export type { CountryFeature, FeatureType } from './domain/CountryFeature';
export type { CountryGrant, GroupMembership } from './domain/GroupMembership';
export { ENLITE_TENANT_ID } from './domain/tenant';
export {
  ACTOR_CLASSES,
  ACTOR_CLASS_PADRAO,
  CELULAS_VEDADAS_A_TERCEIRO,
  isActorClass,
  podeConceder,
  motivoDaVedacao,
} from './domain/ActorClass';
export type { ActorClass } from './domain/ActorClass';

// ── Catálogo derivado do código (declaração + varredura) ─────────────────────
export { markPermissionHandler, readPermissionMetadata, PERMISSION_METADATA } from './infrastructure/catalog/permissionMetadata';
export type { PermissionMetadata } from './infrastructure/catalog/permissionMetadata';
export { declaredCells, cellsForaDeRota, scanExpressRouter, undeclaredRoutes, mountPathOf } from './infrastructure/catalog/scanExpressRouter';
export type { ScannedRoute } from './infrastructure/catalog/scanExpressRouter';
export { buildRouteIndex } from './infrastructure/catalog/routeMatcher';
export type { RouteIndex } from './infrastructure/catalog/routeMatcher';
export { CATALOG_OWNER_SERVICE } from './application/SyncPermissionCatalogUseCase';

// ── Disponibilidade por país ─────────────────────────────────────────────────
export {
  COUNTRY_FEATURES_MANIFEST,
  manifestDefault,
  manifestEntries,
  undecidedFeatures,
} from './infrastructure/country-features.manifest';
export type { CountryFeatureManifest, FeatureDefault } from './infrastructure/country-features.manifest';

// ── Eventos e rotas do módulo ────────────────────────────────────────────────
export {
  COUNTRY_FEATURE_CHANGED_EVENT,
  PERMISSION_CHANGED_EVENT,
} from './infrastructure/DomainEventPermissionPublisher';
export { registerPermissionEventHandlers } from './interface/registerPermissionEventHandlers';
export type { HandlerRegistry } from './interface/registerPermissionEventHandlers';
export { createWellKnownPermissionsRouter } from './interface/wellKnownPermissionsRoute';

// ── Use cases (a API do painel monta em cima destes) ─────────────────────────
export { AssertNoActiveStaffWithoutGroupUseCase, ROLLOUT_MARKER_KEY } from './application/AssertNoActiveStaffWithoutGroupUseCase';
export { GetMyAuthzUseCase } from './application/GetMyAuthzUseCase';
export { ListPermissionCatalogUseCase } from './application/ListPermissionCatalogUseCase';
export { QueryPermissionAuditUseCase } from './application/QueryPermissionAuditUseCase';
export { SyncCountryFeaturesUseCase } from './application/SyncCountryFeaturesUseCase';
export { SyncPermissionCatalogUseCase } from './application/SyncPermissionCatalogUseCase';
export { projectWorkerFields, ProjecaoSemDecryptorError, NOME_REDIGIDO, CELL_WORKER_READ, CELL_WORKER_CONTACT_READ, CELL_WORKER_PII_READ, CELL_WORKER_DISABLE } from './application/projectWorkerFields';
export type { WorkerRow, ProjectedWorker, Decryptor } from './application/projectWorkerFields';
export { cellsOfRequest } from './application/cellsOfRequest';
export { CELL_DESCRIPTION } from './domain/PermissionCell';
