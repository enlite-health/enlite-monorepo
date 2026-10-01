/**
 * identity module — barrel export.
 * External code MUST import only from this file.
 *
 * @module identity
 */

// ── Domain ────────────────────────────────────────────────────────────────────
export {
  EnliteRole,
  STAFF_ROLES,
  isStaffRole,
} from './domain/EnliteRole';
export type { StaffRole } from './domain/EnliteRole';

export type {
  AuthContext,
  Principal,
  Credentials,
  RequestMetadata,
  AccessDecision,
  AuthToken,
  PermissionCondition,
} from './domain/Auth';
export {
  PrincipalType,
  CredentialType,
  ResourceType,
  Action,
} from './domain/Auth';

// ── Ports ─────────────────────────────────────────────────────────────────────
export type { IAuthenticationService } from './ports/IAuthenticationService';
export type { IAuthorizationEngine } from './ports/IAuthorizationEngine';

// ── Infrastructure ────────────────────────────────────────────────────────────
export { AdminRepository } from './infrastructure/AdminRepository';
export type { AdminRecord } from './infrastructure/AdminRepository';
export { UserRepository } from './infrastructure/UserRepository';
export { MultiAuthService } from './infrastructure/MultiAuthService';
export { SimplifiedAuthorizationEngine } from './infrastructure/SimplifiedAuthorizationEngine';
export { CerbosAuthorizationAdapter } from './infrastructure/CerbosAuthorizationAdapter';
export { GroupPermissionEngine, isStaffPrincipal } from './infrastructure/GroupPermissionEngine';
export { GoogleIdentityService } from './infrastructure/GoogleIdentityService';
export { EmailService, EmailChannelUnavailableError } from './infrastructure/EmailService';
export {
  mockAuthMiddleware,
  createMockAuthEndpoints,
} from './infrastructure/MockAuthMiddleware';

// ── Application ───────────────────────────────────────────────────────────────
export { CreateAdminUserUseCase } from './application/CreateAdminUserUseCase';
export type { CreateAdminInput } from './application/CreateAdminUserUseCase';
export { ListAdminUsersUseCase } from './application/ListAdminUsersUseCase';
export { DeleteAdminUserUseCase } from './application/DeleteAdminUserUseCase';
export { ResetAdminPasswordUseCase } from './application/ResetAdminPasswordUseCase';
export { GetAdminProfileUseCase } from './application/GetAdminProfileUseCase';
export { DeleteUserUseCase } from './application/DeleteUserUseCase';
export type { DeleteUserDTO } from './application/DeleteUserUseCase';
export { DeleteUserByEmailUseCase } from './application/DeleteUserByEmailUseCase';
export type { DeleteUserByEmailDTO } from './application/DeleteUserByEmailUseCase';

// ── Interfaces ────────────────────────────────────────────────────────────────
export { AdminController } from './interfaces/controllers/AdminController';
export { AuthTelemetryController } from './interfaces/controllers/AuthTelemetryController';
export { UserController } from './interfaces/controllers/UserController';
export { AuthMiddleware } from './interfaces/middleware/AuthMiddleware';
export { PermissionMiddleware, principalUid } from './interfaces/middleware/PermissionMiddleware';
export type {
  DenialCode,
  PermissionAuditSink,
  PermissionFamily,
  PermissionMiddlewareDeps,
} from './interfaces/middleware/PermissionMiddleware';
export {
  denyUndeclaredRoutes,
  isGovernedPath,
  isGovernedRoute,
  UndeclaredRouteRegistry,
  GOVERNED_PREFIXES,
} from './interfaces/middleware/denyUndeclaredRoutes';
export type { RouteStatus } from './interfaces/middleware/denyUndeclaredRoutes';
export {
  EXEMPT_ROUTES,
  PENDING_DECLARATIONS,
  routeKey,
} from './interfaces/middleware/undeclaredRouteLists';
export { requireCountryScope, hasLiveCountryGrant } from './interfaces/middleware/countryScopeGuard';
export { resolveCountryScope, CountryScopeError } from './application/resolveCountryScope';
export type {
  CountryScopeRequested,
  CountryScopeResolution,
  CountryScopeErrorCode,
} from './application/resolveCountryScope';
export { createAuthTelemetryRoutes } from './interfaces/routes/authTelemetryRoutes';
export { createAdminUsersRoutes } from './interfaces/routes/adminUsersRoutes';
export { createAdminStaffDirectoryRoutes } from './interfaces/routes/adminStaffDirectoryRoutes';
export { AdminStaffDirectoryController } from './interfaces/controllers/AdminStaffDirectoryController';
// Heartbeat de presença mudou para módulo PRÓPRIO em 22/09/2026 (change
// 022-ux-mencao-e-notificacao, Rodada 2) — ver `@modules/presence`. `principalUid` (usado pelo
// `AdminPresenceController` de lá) já é exportado por este barrel logo abaixo (linha do
// PermissionMiddleware), sem precisar de import direto em subpasta.
export { createPermissionPanelRoutes, ADMIN_PERMISSIONS_FAMILY } from './interfaces/routes/permissionPanelRoutes';
export { createPermissionPanelWriteRoutes } from './interfaces/routes/permissionPanelWriteRoutes';
export type { PanelWriter, PermissionPanelWriteDeps } from './interfaces/routes/permissionPanelWriteRoutes';
export { createPermissionRoutesInventoryRouter } from './interfaces/routes/permissionRoutesInventoryRoute';
