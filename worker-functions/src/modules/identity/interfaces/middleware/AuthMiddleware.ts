import { Request, Response, NextFunction } from 'express';
import { IAuthenticationService } from '../../ports/IAuthenticationService';
import { IAuthorizationEngine } from '../../ports/IAuthorizationEngine';
import { AuthContext, Credentials, CredentialType, PrincipalType, RequestMetadata } from '../../domain/Auth';
import { isStaffRole } from '../../domain/EnliteRole';
import { MultiAuthService } from '../../infrastructure/MultiAuthService';
import { loggingAls, logger } from '@shared/logging';
import { staffActor, workerSelfActor } from '@shared/audit/actorSource';
import { isCountryCode, isCountryRlsEnabled, setDbContext } from '@shared/database/requestDbSession';
import { ENLITE_TENANT_ID, type PermissionClient } from '@modules/identity/permissions';

/**
 * Guarda quem autenticou no contexto da request (ALS), para que as escritas
 * carimbem `changed_by`/`change_source` nas trilhas de histórico sem precisar
 * receber o ator por parâmetro em cada camada. Ver `withActorContext`.
 *
 * O store do ALS já existe (correlationMiddleware roda antes, com o traceId);
 * aqui só somamos o ator. Sem store (job fora de request) é no-op.
 *
 * ⚠️ `requireAuth` protege TANTO o painel QUANTO as rotas do próprio prestador
 * (`/api/workers/me/*`). Sem o recorte por papel, uma edição que o candidato faz
 * no app entraria na medição como trabalho do time — por isso o ator sai de
 * `isStaffRole`, não do simples fato de estar autenticado.
 */
function rememberActorInAls(
  uid?: string | null,
  email?: string | null,
  roles?: readonly string[] | null,
  country?: unknown,
): void {
  // `?.` de propósito (mesmo padrão de withActorContext): em teste com
  // `@shared/logging` mockado o ALS pode nem existir, e auditoria/contexto nunca
  // pode derrubar a autenticação.
  const store = loggingAls?.getStore?.();
  if (!store) return;
  const isStaff = (roles ?? []).some((role) => isStaffRole(role as never));
  const actor = isStaff ? staffActor(uid, email) : workerSelfActor(uid);
  if (actor) store.actor = actor;
  declareDbContext(isStaff, uid, country);
}

/**
 * Declara a jurisdição da request para a RLS de país (ABAC Fase 1, task 3.1).
 *
 * ⚠️ [lex C3] Claim `country` ausente NÃO vira 'AR'. Um default aqui seria pior
 * do que não ter isolamento: daria a qualquer operador sem claim a jurisdição
 * argentina inteira, calado. Sem claim, o contexto vai sem país — a policy não
 * casa nada e a consulta devolve ZERO linha (fail-closed, spec country-isolation)
 * — e o erro sai no log com o uid para o runbook de atribuição (task 3.2).
 */
function declareDbContext(isStaff: boolean, uid?: string | null, country?: unknown): void {
  if (!isStaff) {
    setDbContext({ kind: 'worker_self', uid: uid ?? undefined });
    return;
  }

  if (!isCountryCode(country)) {
    // Severidade acompanha o estrago real: antes da virada é só um staff a
    // instrumentar (warn); com a RLS valendo, é gente sem enxergar nada (error).
    const line = { uid, claimCountry: typeof country === 'string' ? country : null };
    const message =
      '[abac] staff sem claim de país válido — consultas protegidas retornam zero linhas (sem fallback)';
    if (isCountryRlsEnabled()) logger.error(line, message);
    else logger.warn(line, message);
    setDbContext({ kind: 'staff', uid: uid ?? undefined });
    return;
  }

  setDbContext({ kind: 'staff', uid: uid ?? undefined, country });
}

/**
 * Express Middleware for Authentication & Authorization
 * 
 * This middleware provides:
 * 1. Authentication: Verify credentials from request headers
 * 2. Authorization: Check if authenticated principal can access resource
 * 3. Audit Logging: Log all access attempts
 * 
 * HIPAA Compliance:
 * - No PII in logs
 * - Secure credential handling
 * - Audit trail for all access
 * 
 * Usage:
 * ```typescript
 * // Require authentication only
 * app.get('/api/workers/me', authMiddleware.requireAuth(), handler);
 * 
 * // Require specific permission
 * app.delete('/api/users/:id', authMiddleware.requirePermission('user', 'delete'), handler);
 * 
 * // Optional authentication
 * app.get('/api/public', authMiddleware.optionalAuth(), handler);
 * ```
 */
export class AuthMiddleware {
  private readonly multiAuthService: MultiAuthService | null;

  constructor(
    private readonly authService: IAuthenticationService,
    private readonly authzEngine: IAuthorizationEngine,
    /**
     * Resolvedor de permissões efetivas (change `painel-grupos-permissao`,
     * task 3.1). Opcional: sem ele o middleware se comporta exatamente como
     * antes — é assim que os testes antigos seguem válidos e que um consumidor
     * fora do painel não paga por um módulo que não usa.
     */
    private readonly permissions?: PermissionClient,
  ) {
    // Guarda referência tipada se o serviço for MultiAuthService
    this.multiAuthService = authService instanceof MultiAuthService ? authService : null;
  }

  /**
   * Anexa `{permissions, countries}` ao principal quando o engine está ligado e
   * quem chega é staff.
   *
   * NÃO nega aqui, de propósito. Conta em admissão / sem grupo tem que
   * conseguir autenticar para cair na tela de boas-vindas e no
   * `/api/admin/auth/profile` (auto-provisionamento do 1º login) — quem nega é
   * o `PermissionMiddleware`, na rota que exige célula. Negar já na
   * autenticação trancaria fora justamente quem o gestor precisa enxergar para
   * dar o grupo.
   *
   * Falha de resolução não derruba a autenticação: o principal segue sem as
   * listas, e o guard da rota resolve de novo e NEGA (fail-closed lá, onde a
   * decisão é tomada).
   */
  private async attachEffectiveAuthz(principal: { id: string; roles?: string[] }): Promise<void> {
    if (!this.permissions || process.env.PERMISSION_ENGINE_ENABLED !== 'true') return;
    if (!(principal.roles ?? []).some((role) => isStaffRole(role))) return;
    try {
      const resolved = await this.permissions.resolve(principal.id, ENLITE_TENANT_ID);
      (principal as { permissions?: string[]; countries?: string[] }).permissions = resolved.permissions;
      (principal as { permissions?: string[]; countries?: string[] }).countries = resolved.countries;
    } catch (err) {
      logger.error({ err, uid: principal.id }, '[perm] falha ao resolver permissões na autenticação');
    }
  }

  /**
   * Require authentication for the route
   * Attaches authContext to request object
   */
  requireAuth() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // Short-circuit when MockAuthMiddleware already authenticated this request
        const mockUser = (req as any).user;
        if (process.env.USE_MOCK_AUTH === 'true' && mockUser?.uid) {
          const roles: string[] = mockUser.role ? [mockUser.role] : [];
          const authContext: AuthContext = {
            principal: {
              id: mockUser.uid,
              type: PrincipalType.USER,
              roles,
            },
            credentials: {
              type: CredentialType.GOOGLE_ID_TOKEN,
              token: '',
              scopes: [],
            },
            metadata: {
              ipAddress: req.ip || 'unknown',
              userAgent: req.headers['user-agent'],
              requestId: this.generateRequestId(),
              timestamp: new Date(),
              path: req.path,
              method: req.method,
            },
          };
          (req as any).authContext = authContext;
          (req as any).user = { uid: mockUser.uid, email: mockUser.email, role: mockUser.role, roles };
          rememberActorInAls(mockUser.uid, mockUser.email, roles, mockUser.country);
          await this.attachEffectiveAuthz(authContext.principal);
          return next();
        }

        const credentials = this.authService.parseCredentials(req.headers as Record<string, string>);
        
        if (!credentials) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
          });
          return;
        }

        const metadata: RequestMetadata = {
          ipAddress: req.ip || 'unknown',
          userAgent: req.headers['user-agent'],
          requestId: this.generateRequestId(),
          timestamp: new Date(),
          path: req.path,
          method: req.method,
        };

        const authContext = await this.authService.authenticate(credentials, metadata);

        if (!authContext) {
          res.status(401).json({
            success: false,
            error: 'Invalid credentials',
          });
          return;
        }

        // Attach auth context to request
        (req as any).authContext = authContext;

        // Also attach user object for controller compatibility
        (req as any).user = {
          uid: authContext.principal.id,
          type: authContext.principal.type,
          roles: authContext.principal.roles,
        };

        rememberActorInAls(
          authContext.principal.id,
          null,
          authContext.principal.roles,
          authContext.principal.country,
        );

        await this.attachEffectiveAuthz(authContext.principal);

        // Log successful authentication (without PII)
        this.logAuthAttempt(authContext, metadata, true);

        next();
      } catch (error) {
        this.logAuthError(error);
        res.status(500).json({
          success: false,
          error: 'Authentication error',
        });
      }
    };
  }

  /**
   * Require specific permission for the resource
   */
  requirePermission(resourceType: string, action: string) {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const authContext = (req as any).authContext;

        if (!authContext) {
          res.status(401).json({
            success: false,
            error: 'Authentication required',
          });
          return;
        }

        const resource = {
          type: resourceType,
          id: req.params.id,
          attrs: {
            ownerId: req.body.workerId || req.params.workerId,
            tenantId: req.headers['x-tenant-id'],
          },
        };

        const decision = await this.authzEngine.checkPermission(authContext, resource, action);

        if (!decision.allowed) {
          res.status(403).json({
            success: false,
            error: 'Access denied',
            reason: decision.reason,
          });
          return;
        }

        // Attach decision to request for audit purposes
        (req as any).accessDecision = decision;

        next();
      } catch (error) {
        this.logAuthzError(error);
        res.status(500).json({
          success: false,
          error: 'Authorization error',
        });
      }
    };
  }

  /**
   * Optional authentication - doesn't fail if no credentials provided
   * Useful for endpoints that work with or without authentication
   */
  optionalAuth() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const credentials = this.authService.parseCredentials(req.headers as Record<string, string>);
        
        if (credentials) {
          const metadata: RequestMetadata = {
            ipAddress: req.ip || 'unknown',
            userAgent: req.headers['user-agent'],
            requestId: this.generateRequestId(),
            timestamp: new Date(),
            path: req.path,
            method: req.method,
          };

          const authContext = await this.authService.authenticate(credentials, metadata);
          if (authContext) {
            (req as any).authContext = authContext;
          }
        }

        next();
      } catch (error) {
        // Don't fail on optional auth errors
        next();
      }
    };
  }

  /**
   * Require staff access (admin | recruiter | community_manager).
   * Use this for endpoints that any Enlite internal user can access.
   */
  requireStaff() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      await this.requireAuth()(req, res, () => {
        const user = (req as any).user;
        const staffRoles = ['admin', 'recruiter', 'community_manager'];
        if (!user?.roles?.some((r: string) => staffRoles.includes(r))) {
          res.status(403).json({ success: false, error: 'Staff access required' });
          return;
        }
        next();
      });
    };
  }

  /**
   * Híbrido: aceita API key de serviço (triage-service) OU staff Firebase.
   * API key é verificada PRIMEIRO (lookup O(1) sem I/O).
   * Firebase só é chamado se a API key falhar.
   *
   * Em USE_MOCK_AUTH=true (E2E): usa req.user do MockAuthMiddleware
   * e verifica role staff.
   */
  requireStaffOrApiKey() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // Short-circuit para MockAuth em testes E2E
      if (process.env.USE_MOCK_AUTH === 'true') {
        const mockUser = req.user;
        if (!mockUser?.uid) {
          res.status(401).end();
          return;
        }
        const staffRoles = ['admin', 'recruiter', 'community_manager'];
        if (!staffRoles.includes(mockUser.role ?? '')) {
          res.status(401).end();
          return;
        }
        rememberActorInAls(mockUser.uid, mockUser.email, [mockUser.role ?? ''], mockUser.country);
        return next();
      }

      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).end();
        return;
      }
      const token = authHeader.slice(7);

      // 1) API key PRIMEIRO (sem I/O, sem log Firebase poluir)
      if (this.multiAuthService) {
        const apiKeyContext = this.multiAuthService.tryAuthenticateAsApiKey(token);
        if (apiKeyContext) {
          req.authContext = apiKeyContext;
          // Chave de API é serviço (`service:<nome>`), não pessoa: contexto de
          // SISTEMA declarado (design, decisão 2) — não herda país de ninguém.
          setDbContext({ kind: 'system', systemContext: `api-key:${apiKeyContext.principal.id}` });
          return next();
        }
      }

      // 2) Firebase só agora
      if (this.multiAuthService) {
        try {
          const firebaseContext = await this.multiAuthService.authenticateGoogleIdToken(token, {
            ipAddress: req.ip ?? 'unknown',
            userAgent: req.headers['user-agent'],
            requestId: this.generateRequestId(),
            timestamp: new Date(),
            path: req.path,
            method: req.method,
          });
          if (firebaseContext) {
            const roles = firebaseContext.principal.roles ?? [];
            if (roles.some(r => isStaffRole(r))) {
              req.authContext = firebaseContext;
              req.user = {
                uid: firebaseContext.principal.id,
                roles,
              };
              rememberActorInAls(
                firebaseContext.principal.id,
                null,
                roles,
                firebaseContext.principal.country,
              );
              return next();
            }
          }
        } catch {
          // fallthrough → 401
        }
      }

      res.status(401).end();
    };
  }

  /**
   * Require API Key authentication (for service-to-service)
   *
   * A classificação de banco é de SISTEMA, igual à do `requireStaffOrApiKey`
   * (design, decisão 2): chave de API é serviço, não pessoa — não tem
   * jurisdição própria e não pode herdar a de ninguém. Sem este carimbo o
   * `requireAuth` abaixo classificaria a request como `worker_self` (o principal
   * de serviço não tem papel de staff), que sob RLS é fail-closed: o parceiro
   * passaria a ler zero linha sem nenhum erro visível.
   */
  requireApiKey() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const apiKey = req.headers['x-api-key'];

      if (!apiKey) {
        res.status(401).json({
          success: false,
          error: 'API key required',
        });
        return;
      }

      // Continue with normal auth flow — o contexto é reescrito DEPOIS que a
      // autenticação passa (o requireAuth carimba worker_self/staff no caminho).
      return this.requireAuth()(req, res, () => {
        const principalId = (req as Request).authContext?.principal?.id ?? 'unknown';
        setDbContext({ kind: 'system', systemContext: `api-key:${principalId}` });
        next();
      });
    };
  }

  /**
   * Get auth context from request (for use in controllers)
   */
  static getAuthContext(req: Request): AuthContext | undefined {
    return (req as any).authContext;
  }

  /**
   * Get access decision from request (for use in controllers)
   */
  static getAccessDecision(req: Request): any {
    return (req as any).accessDecision;
  }

  // ============ Private Methods ============

  private generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  private logAuthAttempt(authContext: AuthContext, metadata: RequestMetadata, success: boolean): void {
    // Log without PII - only principal type and ID, not actual user data
    console.log(`[AUTH] ${success ? 'SUCCESS' : 'FAILURE'} | Type: ${authContext.principal.type} | ID: ${authContext.principal.id} | Path: ${metadata.path}`);
  }

  private logAuthError(error: unknown): void {
    console.error('[AUTH ERROR] Authentication middleware error');
  }

  private logAuthzError(error: unknown): void {
    console.error('[AUTHZ ERROR] Authorization middleware error');
  }
}
