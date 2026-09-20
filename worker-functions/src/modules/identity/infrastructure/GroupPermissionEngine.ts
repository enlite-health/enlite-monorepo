/**
 * src/modules/identity/infrastructure/GroupPermissionEngine.ts
 *
 * O motor REAL de autorização (change `painel-grupos-permissao`, task 3.2):
 * decide por célula `recurso:ação` vinda dos grupos vigentes do staff, no lugar
 * do `SimplifiedAuthorizationEngine`, que responde "sim" para todo autenticado.
 *
 * Três decisões que valem explicação:
 *
 * 1. **Só decide o que o novo modelo DECLARA — e só para staff.** Dois desvios,
 *    por dois motivos diferentes, e os dois vieram de bug achado em revisão:
 *
 *    (a) *não-staff* cai no motor anterior. As rotas do próprio prestador
 *    (`/api/workers/me/*`, `/api/users/me`) chamam `requirePermission('worker',
 *    'update')` desde antes desta change; sem o desvio, o app do candidato
 *    inteiro cairia em 403 no dia da virada.
 *
 *    (b) *célula NÃO declarada por nenhuma rota* também cai no motor anterior.
 *    Sem isso, ligar `PERMISSION_ENGINE_ENABLED` viraria a decisão de rotas que
 *    NENHUMA família ligou em `PERMISSION_ENFORCED_ROUTES` — e pior, com células
 *    que não existem no catálogo (`user:admin_delete`, `worker:update`), que
 *    grupo nenhum poderia conceder. Isso contraria o cenário "rota ainda não
 *    virada se comporta como hoje" da spec e a decisão 6 do design. O conjunto
 *    de células declaradas vem da MESMA varredura que alimenta o catálogo, e
 *    nasce vazio: antes do boot publicar, este motor delega tudo.
 *
 * 2. **Falha ao resolver = negar** (spec: "Falha ao resolver permissões nega").
 *    Um `catch` que deixasse passar transformaria indisponibilidade de banco em
 *    acesso irrestrito — o oposto de fail-closed.
 *
 * 3. **Status antes de grupo.** Conta em admissão/suspensa/desativada é negada
 *    sem olhar células, para a tela poder dizer "conta em admissão" em vez de
 *    "sem permissão" (spec: "Conta em admissão ou desativada é negada antes de
 *    qualquer checagem").
 *
 * ⚠️ Este motor NÃO é o gate das rotas do painel — quem gateia é o
 * `PermissionMiddleware` (mesma decisão, mesma fonte, com auditoria e rollout
 * por família). Ele existe porque o `IAuthorizationEngine` é a porta que o
 * `AuthMiddleware.requirePermission` legado e o adapter do Cerbos já consomem.
 */

import { logger } from '@shared/logging';
import { cellKey, ENLITE_TENANT_ID, type PermissionClient } from '@modules/identity/permissions';
import { IAuthorizationEngine } from '../ports/IAuthorizationEngine';
import { AccessDecision, AuthContext } from '../domain/Auth';
import { isStaffAccount } from '../domain/AccountType';

type Resource = { type: string; id?: string; attrs?: Record<string, unknown> };

/**
 * `auditLogId` é obrigatório no contrato `AccessDecision`. Um id AQUI não
 * promete trilha nenhuma (quem grava é o `PermissionMiddleware`, tabela
 * `iam.permission_audit_log`) — é correlação de log, e o prefixo diz isso.
 */
function decisionId(): string {
  return `authz_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

function deny(reason: string): AccessDecision {
  return { allowed: false, reason, policies: ['group_permissions'], auditLogId: decisionId() };
}

export interface GroupPermissionEngineOptions {
  /**
   * A célula é governada pelo novo modelo? Recebe o conjunto DECLARADO pelas
   * rotas (via `UndeclaredRouteRegistry`). Omitido = governa tudo, forma que só
   * o teste usa — o wiring de produção sempre passa o conjunto real.
   */
  governsCell?: (resource: string, action: string) => boolean;
  tenantId?: string;
}

export class GroupPermissionEngine implements IAuthorizationEngine {
  private readonly governsCell: (resource: string, action: string) => boolean;
  private readonly tenantId: string;

  constructor(
    private readonly client: PermissionClient,
    /** Motor de quem este não decide (hoje o `SimplifiedAuthorizationEngine`). */
    private readonly fallbackEngine: IAuthorizationEngine,
    options: GroupPermissionEngineOptions = {},
  ) {
    this.governsCell = options.governsCell ?? (() => true);
    this.tenantId = options.tenantId ?? ENLITE_TENANT_ID;
  }

  async checkPermission(
    context: AuthContext,
    resource: Resource,
    action: string,
  ): Promise<AccessDecision> {
    if (!isStaffPrincipal(context) || !this.governsCell(resource.type, action)) {
      return this.fallbackEngine.checkPermission(context, resource, action);
    }

    const uid = context.principal.id;
    if (!uid) return deny('Principal sem identidade');

    try {
      const resolved = await this.client.resolve(uid, this.tenantId);
      if (resolved.status !== 'ACTIVE') {
        return deny(`Conta com status ${resolved.status ?? 'desconhecido'}`);
      }
      const cell = cellKey(resource.type, action);
      if (!resolved.permissions.includes(cell)) {
        return deny(`Sem a permissão ${cell}`);
      }
      return {
        allowed: true,
        reason: `Concedida por grupo (${cell})`,
        policies: ['group_permissions'],
        auditLogId: decisionId(),
      };
    } catch (err) {
      // Sem uid no log? Não: uid não é PII (é identificador de operador) e sem
      // ele o runbook não sabe QUEM ficou preso quando o banco oscila.
      logger.error({ err, uid, resource: resource.type, action }, '[perm] falha ao resolver permissões — negando');
      return deny('Falha ao resolver permissões');
    }
  }

  async checkPermissions(
    context: AuthContext,
    checks: Array<{ resource: Resource; action: string }>,
  ): Promise<AccessDecision[]> {
    return Promise.all(checks.map((check) => this.checkPermission(context, check.resource, check.action)));
  }

  /**
   * Mesma forma do motor anterior: a lista de ids nunca foi implementada por
   * nenhum dos dois (nenhum chamador usa), e inventar uma aqui seria pior que
   * a lista vazia honesta. O que muda é a DECISÃO, que agora é real.
   */
  async listAccessibleResources(
    context: AuthContext,
    resourceType: string,
    action: string,
  ): Promise<{ resourceIds: string[]; decision: AccessDecision }> {
    const decision = await this.checkPermission(context, { type: resourceType }, action);
    return { resourceIds: [], decision };
  }
}

/** Staff é quem tem CONTA de staff (`account_type`, D294) — não "quem está autenticado". */
export function isStaffPrincipal(context: AuthContext): boolean {
  return isStaffAccount(context.principal);
}
