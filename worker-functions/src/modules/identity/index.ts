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
export { GoogleIdentityService } from './infrastructure/GoogleIdentityService';
export { EmailService } from './infrastructure/EmailService';
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
export { UpdateAdminRoleUseCase } from './application/UpdateAdminRoleUseCase';
export type { UpdateAdminRoleInput } from './application/UpdateAdminRoleUseCase';
export { DeleteUserUseCase } from './application/DeleteUserUseCase';
export type { DeleteUserDTO } from './application/DeleteUserUseCase';
export { DeleteUserByEmailUseCase } from './application/DeleteUserByEmailUseCase';
export type { DeleteUserByEmailDTO } from './application/DeleteUserByEmailUseCase';

// ── Interfaces ────────────────────────────────────────────────────────────────
export { AdminController } from './interfaces/controllers/AdminController';
export { AuthTelemetryController } from './interfaces/controllers/AuthTelemetryController';
export { UserController } from './interfaces/controllers/UserController';
export { AuthMiddleware } from './interfaces/middleware/AuthMiddleware';
export { createAuthTelemetryRoutes } from './interfaces/routes/authTelemetryRoutes';
