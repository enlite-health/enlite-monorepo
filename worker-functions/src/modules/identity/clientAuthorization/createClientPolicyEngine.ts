import type { Pool } from 'pg';
import type { IAuthorizationEngine } from '../ports/IAuthorizationEngine';
import type { AuthContext, AccessDecision } from '../domain/Auth';
import { PgAreaRegistryRepository } from '../infrastructure/PgAreaRegistryRepository';
import { CedarClientPolicyEngine } from './CedarClientPolicyEngine';
import { ClientEntityLoader, PgClientOwnershipRepository, type PersonBootstrap } from './ClientEntityLoader';
import { LoggedClientEngine } from './clientDecisionLog';
import { CLIENT_POLICIES, CLIENT_SCHEMA } from './policies';

type Resource = { type: string; id?: string; attrs?: Record<string, unknown> };

/** Vocabulário que as rotas usam hoje (`requirePermission(recurso, ação)`) → ação/tipo Cedar. Fonte única da tabela. */
const ROUTE_TO_CEDAR: Record<string, { type: string; action: string }> = {
  'worker:read': { type: 'Worker', action: 'ReadOwnWorkerProfile' },
  'worker:update': { type: 'Worker', action: 'UpdateOwnWorkerProfile' },
  'user:delete': { type: 'Account', action: 'DeleteOwnAccount' },
};

/** O Cedar governa este par (recurso, ação) das rotas? Fora da tabela, o não-staff segue no motor legado até a F3 (bloqueio por padrão). */
export function governsAction(resource: { type: string }, action: string): boolean {
  return `${resource.type}:${action}` in ROUTE_TO_CEDAR;
}

class PgPersonBootstrap implements PersonBootstrap {
  constructor(private readonly pool: Pool) {}
  async ensurePerson(uid: string): Promise<string | null> {
    const r = await this.pool.query<{ pid: string | null }>(`SELECT iam.ensure_person('firebase', $1) AS pid`, [uid]);
    return r.rows[0]?.pid ?? null;
  }
}

/**
 * Traduz o pedido das rotas para o vocabulário Cedar e delega ao `CedarClientPolicyEngine`. Nas rotas `/me` (sem id na
 * rota) a ficha é a do PRÓPRIO token: a viva de `auth_uid = uid` ou, num login absorvido por merge, a da pessoa sobrevivente (ficha absorvida não é recurso).
 */
export class ClientRouteAuthorizationEngine implements IAuthorizationEngine {
  constructor(private readonly cedar: IAuthorizationEngine, private readonly pool: Pool) {}

  async checkPermission(context: AuthContext, resource: Resource, action: string): Promise<AccessDecision> {
    const mapped = ROUTE_TO_CEDAR[`${resource.type}:${action}`];
    if (!mapped) return { allowed: false, reason: 'Negado (rota sem ação Cedar)', policies: [], auditLogId: `audit_${Date.now()}` };
    let id = resource.id;
    if (mapped.type === 'Worker' && !id) {
      id = (await this.selfWorkerId(context.principal.id)) ?? undefined;
      if (!id) return this.cedar.checkPermission(context, { type: 'Worker' }, mapped.action); // sem ficha → o loader nega
    }
    return this.cedar.checkPermission(context, { type: mapped.type, id }, mapped.action);
  }

  checkPermissions(context: AuthContext, checks: Array<{ resource: Resource; action: string }>): Promise<AccessDecision[]> {
    return Promise.all(checks.map((c) => this.checkPermission(context, c.resource, c.action)));
  }

  listAccessibleResources(context: AuthContext, resourceType: string, action: string) {
    return this.cedar.listAccessibleResources(context, resourceType, action);
  }

  private async selfWorkerId(uid: string): Promise<string | null> {
    const r = await this.pool.query<{ id: string }>(
      `SELECT w.id FROM workers w
        WHERE w.merged_into_id IS NULL
          AND (w.auth_uid = $1
               OR iam.person_root(iam.resolve_person('firebase', w.auth_uid)) = iam.person_root(iam.resolve_person('firebase', $1)))
        ORDER BY (w.auth_uid = $1) DESC, w.created_at ASC
        LIMIT 1`,
      [uid],
    );
    return r.rows[0]?.id ?? null;
  }
}

/** Ponto de composição do engine de NÃO-STAFF (ligado no `index.ts`; cada decisão sai pelo `clientDecisionLog`, sem PII). */
export function createClientPolicyEngine(pool: Pool): IAuthorizationEngine {
  const loader = new ClientEntityLoader(new PgPersonBootstrap(pool), new PgAreaRegistryRepository(pool), new PgClientOwnershipRepository(pool));
  const cedar = new CedarClientPolicyEngine({ schema: CLIENT_SCHEMA, policies: CLIENT_POLICIES, entityProvider: loader });
  return new LoggedClientEngine(new ClientRouteAuthorizationEngine(cedar, pool));
}
