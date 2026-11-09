import type { IAuthorizationEngine } from '../ports/IAuthorizationEngine';
import type { AuthContext, AccessDecision } from '../domain/Auth';
import { isStaffPrincipal } from '../infrastructure/GroupPermissionEngine';

type Resource = { type: string; id?: string; attrs?: Record<string, unknown> };

/**
 * Fallback do `GroupPermissionEngine` (DF-1): NÃO-staff decide pelo plano do cliente (Cedar); staff, nas células que o
 * painel de grupos não governa, continua no motor legado — sem isto, o staff cairia no engine do cliente (que só
 * conhece `worker:*`/`user:delete` próprios) e perderia rotas que hoje passam.
 */
export class StaffOrClientEngine implements IAuthorizationEngine {
  constructor(private readonly staffLegacy: IAuthorizationEngine, private readonly client: IAuthorizationEngine) {}

  private pick(context: AuthContext): IAuthorizationEngine {
    return isStaffPrincipal(context) ? this.staffLegacy : this.client;
  }
  checkPermission(context: AuthContext, resource: Resource, action: string): Promise<AccessDecision> {
    return this.pick(context).checkPermission(context, resource, action);
  }
  checkPermissions(context: AuthContext, checks: Array<{ resource: Resource; action: string }>): Promise<AccessDecision[]> {
    return Promise.all(checks.map((c) => this.checkPermission(context, c.resource, c.action)));
  }
  listAccessibleResources(context: AuthContext, resourceType: string, action: string) {
    return this.pick(context).listAccessibleResources(context, resourceType, action);
  }
}
