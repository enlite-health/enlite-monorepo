import type { IAuthorizationEngine } from '../ports/IAuthorizationEngine';
import type { AuthContext, AccessDecision } from '../domain/Auth';
import { governsAction } from './createClientPolicyEngine';

type Resource = { type: string; id?: string; attrs?: Record<string, unknown> };

/**
 * `governsCell` do `GroupPermissionEngine` (DF-1/DF-4): o grupo governa só o que o painel declara E que o plano do cliente
 * NÃO governa. `worker:read|update` e `user:delete` das rotas legadas `requirePermission` são do prestador sobre o PRÓPRIO
 * recurso (as rotas do painel decidem pelo `PermissionMiddleware`, não por este motor); sem este recorte, uma conta staff
 * que também é prestador levava 403 "Sem a permissão worker:*" no próprio recurso (linha de base T201, 10 das 12 rotas).
 */
export function staffGroupGoverns(declaresCell: (resource: string, action: string) => boolean) {
  return (resource: string, action: string): boolean => declaresCell(resource, action) && !governsAction({ type: resource }, action);
}

/**
 * Fallback do `GroupPermissionEngine` (DF-1): ação da tabela do Cedar (`worker:*`/`user:delete` próprios) decide pelo plano do
 * cliente (vínculo), staff ou não (DF-1, DF-4: o acesso vem do vínculo, não do `account_type`); o que está fora da tabela
 * segue no motor legado (staff e não-staff) até a F3 — sem isto o engine do cliente, que só conhece essas ações, negaria
 * rotas que hoje passam.
 */
export class StaffOrClientEngine implements IAuthorizationEngine {
  constructor(private readonly staffLegacy: IAuthorizationEngine, private readonly client: IAuthorizationEngine) {}

  /** Ação na tabela do Cedar → Cedar (qualquer conta); fora dela → legado (comportamento de hoje, até a F3). */
  private pick(_context: AuthContext, resource: Resource, action: string): IAuthorizationEngine {
    return governsAction(resource, action) ? this.client : this.staffLegacy;
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
