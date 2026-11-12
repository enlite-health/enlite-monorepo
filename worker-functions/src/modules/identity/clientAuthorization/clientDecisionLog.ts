import { logger } from '@shared/logging';
import type { IAuthorizationEngine } from '../ports/IAuthorizationEngine';
import type { AuthContext, AccessDecision } from '../domain/Auth';

type Resource = { type: string; id?: string; attrs?: Record<string, unknown> };

/** Campos que a linha PODE ter. Qualquer outro, por construção, não entra (lista fechada, não filtro). */
export interface ClientDecisionEntry {
  action: string;
  allowed: boolean;
  policyIds: string[];
  reason: string;
  /** Classe da rota (tipo do recurso, ex.: `Worker`) — nunca o id do recurso. */
  routeClass: string;
  latencyMs: number;
}

/**
 * Registra a decisão do plano do cliente SEM PII (Ley 25.326 / LGPD): proibido pôr aqui
 * identificador de pessoa, contato, nome ou id de recurso. Correlação só pelo `traceId`
 * que o logger já carrega do ALS.
 */
export function logClientDecision(entry: ClientDecisionEntry): void {
  logger.info(
    {
      event: 'client_authz_decision',
      action: entry.action,
      decision: entry.allowed ? 'allow' : 'deny',
      policyIds: entry.policyIds,
      reason: entry.reason,
      routeClass: entry.routeClass,
      latencyMs: entry.latencyMs,
    },
    '[client-authz] decisão',
  );
}

/** Decorator: delega ao engine e loga cada decisão pelo `logClientDecision`. Não altera a decisão. */
export class LoggedClientEngine implements IAuthorizationEngine {
  constructor(private readonly inner: IAuthorizationEngine) {}

  async checkPermission(context: AuthContext, resource: Resource, action: string): Promise<AccessDecision> {
    const t0 = Date.now();
    const decision = await this.inner.checkPermission(context, resource, action);
    logClientDecision({
      action,
      allowed: decision.allowed,
      policyIds: decision.policies ?? [],
      reason: decision.reason ?? '',
      routeClass: resource.type,
      latencyMs: Date.now() - t0,
    });
    return decision;
  }

  checkPermissions(context: AuthContext, checks: Array<{ resource: Resource; action: string }>): Promise<AccessDecision[]> {
    return Promise.all(checks.map((c) => this.checkPermission(context, c.resource, c.action)));
  }

  listAccessibleResources(context: AuthContext, resourceType: string, action: string) {
    return this.inner.listAccessibleResources(context, resourceType, action);
  }
}
