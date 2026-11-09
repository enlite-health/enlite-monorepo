import type { IAuthorizationEngine } from '../ports/IAuthorizationEngine';
import type { AuthContext, AccessDecision } from '../domain/Auth';
import { governsAction } from './createClientPolicyEngine';
import { isStaffPrincipal } from '../infrastructure/GroupPermissionEngine';

type Resource = { type: string; id?: string; attrs?: Record<string, unknown> };

/**
 * Fallback do `GroupPermissionEngine` (DF-1): NÃO-staff decide pelo plano do cliente (Cedar); staff, nas células que o
 * painel de grupos não governa, continua no motor legado — sem isto, o staff cairia no engine do cliente (que só
 * conhece `worker:*`/`user:delete` próprios) e perderia rotas que hoje passam.
 */
export class StaffOrClientEngine implements IAuthorizationEngine {
  constructor(private readonly staffLegacy: IAuthorizationEngine, private readonly client: IAuthorizationEngine) {}

  /** Não-staff: ação na tabela do Cedar → Cedar; fora dela → legado (comportamento de hoje, até a F3). */
  private pick(context: AuthContext, resource: Resource, action: string): IAuthorizationEngine {
    return !isStaffPrincipal(context) && governsAction(resource, action) ? this.client : this.staffLegacy;
  }
  checkPermission(context: AuthContext, resource: Resource, action: string): Promise<AccessDecision> {
    return this.pick(context, resource, action).checkPermission(context, resource, action);
  }
  checkPermissions(context: AuthContext, checks: Array<{ resource: Resource; action: string }>): Promise<AccessDecision[]> {
    return Promise.all(checks.map((c) => this.checkPermission(context, c.resource, c.action)));
  }
  listAccessibleResources(context: AuthContext, resourceType: string, action: string) {
    return this.pick(context, { type: resourceType }, action).listAccessibleResources(context, resourceType, action);
  }
}
