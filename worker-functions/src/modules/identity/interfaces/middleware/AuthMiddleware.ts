import { Request, Response, NextFunction } from 'express';
import { IAuthenticationService } from '../../ports/IAuthenticationService';
import { IAuthorizationEngine } from '../../ports/IAuthorizationEngine';
import { AuthContext, Credentials, CredentialType, PrincipalType, RequestMetadata } from '../../domain/Auth';
import { isStaffRole } from '../../domain/EnliteRole';
import { MultiAuthService } from '../../infrastructure/MultiAuthService';

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
    private readonly authzEngine: IAuthorizationEngine
  ) {
    // Guarda referência tipada se o serviço for MultiAuthService
    this.multiAuthService = authService instanceof MultiAuthService ? authService : null;
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
   * Require admin role — chains requireAuth() then checks roles
   */
  requireAdmin() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      // First authenticate
      await this.requireAuth()(req, res, () => {
        const user = (req as any).user;
        if (!user || !user.roles || !user.roles.includes('admin')) {
          res.status(403).json({ success: false, error: 'Admin access required' });
          return;
        }
        next();
      });
    };
  }

  /**
   * Híbrido: aceita API key de serviço (triage-service, n8n) OU staff Firebase.
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

      // Continue with normal auth flow
      return this.requireAuth()(req, res, next);
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
