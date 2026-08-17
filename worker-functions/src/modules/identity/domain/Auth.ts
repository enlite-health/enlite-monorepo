/**
 * Authentication & Authorization Domain Interfaces
 * 
 * HIPAA Compliance:
 * - No PII in auth tokens
 * - Secure credential storage
 * - Audit trail for all access
 */

export interface AuthContext {
  principal: Principal;
  credentials: Credentials;
  metadata: RequestMetadata;
}

export interface Principal {
  id: string;
  type: PrincipalType;
  roles?: string[];
  tenantId?: string;
  /**
   * Jurisdição do operador (`AR`|`BR`), vinda do custom claim `country` do
   * Identity Platform — a fonte do `app.user_country` que a RLS de país lê
   * (ABAC Fase 1). Ausente é ausente: NUNCA preencher com default (lex C3).
   */
  country?: string;
  /**
   * Permissões efetivas (`recurso:ação`) e países concedidos pelos grupos —
   * resolvidos por request pelo `AuthMiddleware` quando
   * `PERMISSION_ENGINE_ENABLED=true` (change `painel-grupos-permissao`).
   *
   * Existem no principal, e não só no request, porque é daqui que o
   * `CerbosAuthorizationAdapter` os manda como `principal.attr` — o buraco que o
   * ADR-006 apontava (o adapter enviava só `roles`, e toda policy que olhasse
   * permissão negava). Ausentes = engine desligado ou principal não-staff.
   */
  permissions?: string[];
  countries?: string[];
}

export enum PrincipalType {
  USER = 'user',
  SERVICE = 'service',
  WORKER = 'worker',
  ADMIN = 'admin',
  SYSTEM = 'system',
  EXTERNAL_SAAS = 'external_saas'
}

export interface Credentials {
  type: CredentialType;
  token: string;
  scopes: string[];
  expiresAt?: Date;
}

export enum CredentialType {
  JWT = 'jwt',
  API_KEY = 'api_key',
  MTLS = 'mtls',
  GOOGLE_ID_TOKEN = 'google_id_token',
  INTERNAL_TOKEN = 'internal_token'
}

export interface RequestMetadata {
  ipAddress: string;
  userAgent?: string;
  requestId: string;
  timestamp: Date;
  path: string;
  method: string;
}

export interface AccessDecision {
  allowed: boolean;
  reason?: string;
  policies?: string[];
  auditLogId: string;
}


export enum ResourceType {
  WORKER = 'worker',
  USER = 'user',
  SERVICE_AREA = 'service_area',
  AVAILABILITY = 'availability',
  QUIZ_RESPONSE = 'quiz_response',
  SYSTEM_CONFIG = 'system_config',
  AUDIT_LOG = 'audit_log'
}

export enum Action {
  CREATE = 'create',
  READ = 'read',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  EXECUTE = 'execute',
  ADMIN = 'admin'
}

export interface PermissionCondition {
  type: 'OWN_RESOURCE' | 'SAME_TENANT' | 'FIELD_MATCH' | 'TIME_BASED';
  params: Record<string, unknown>;
}

export interface AuthToken {
  token: string;
  expiresAt: Date;
  refreshToken?: string;
}
