import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { IAuthorizationEngine } from '../ports/IAuthorizationEngine';
import { AuthContext, AccessDecision } from '../domain/Auth';

type Resource = { type: string; id?: string; attrs?: Record<string, unknown> };

/** Pedido já resolvido para o vocabulário Cedar (quem monta é o `ClientEntityLoader`, T205). */
export interface CedarRequest {
  principal: { type: string; id: string };
  resource: { type: string; id: string };
  context?: Record<string, unknown>;
  entities: unknown[];
}

/** Monta principal/recurso/entidades a partir do token + recurso. Erro aqui = deny (fail-closed). */
export interface ClientEntityProvider {
  load(context: AuthContext, resource: Resource, action: string): Promise<CedarRequest>;
}

export interface CedarClientPolicyEngineOptions {
  /** Texto `.cedarschema`. */
  schema: string;
  /** Texto das políticas estáticas (`.cedar`); vazio = deny-all. */
  policies: string;
  entityProvider: ClientEntityProvider;
}

/**
 * Motor de autorização do plano do cliente (Cedar 4.14.0 embutido, DF-15).
 * Mesma interface do engine de não-staff atual. Nega por padrão; qualquer falha
 * (schema, política, carregador, avaliação) nega e nunca lança. O log não leva
 * uid nem e-mail: só `policyIds` e a decisão.
 */
export class CedarClientPolicyEngine implements IAuthorizationEngine {
  private readonly schema: string;
  private readonly policies: string;
  private readonly provider: ClientEntityProvider;

  constructor(opts: CedarClientPolicyEngineOptions) {
    this.schema = opts.schema;
    this.policies = opts.policies;
    this.provider = opts.entityProvider;
    // Falha cedo: schema ou política que não valida impede o boot, não vira "allow" calado.
    const parsed = cedar.checkParseSchema(this.schema);
    if (parsed.type !== 'success') {
      throw new Error(`Cedar schema inválido: ${JSON.stringify(parsed.errors)}`);
    }
    const v = cedar.validate({
      schema: this.schema,
      policies: { staticPolicies: this.policies },
      validationSettings: { mode: 'strict' },
    });
    if (v.type !== 'success' || v.validationErrors.length > 0) {
      throw new Error(
        `Cedar política não valida contra o schema: ${JSON.stringify(
          v.type === 'success' ? v.validationErrors : v.errors
        )}`
      );
    }
  }

  async checkPermission(
    context: AuthContext,
    resource: Resource,
    action: string
  ): Promise<AccessDecision> {
    try {
      const req = await this.provider.load(context, resource, action);
      const ans = cedar.isAuthorized({
        principal: req.principal,
        action: { type: 'Action', id: action },
        resource: req.resource,
        context: (req.context ?? {}) as never,
        schema: this.schema,
        validateRequest: true,
        policies: { staticPolicies: this.policies },
        entities: req.entities as never,
      });
      if (ans.type !== 'success') return this.deny('evaluation_error');
      const allowed = ans.response.decision === 'allow';
      return {
        allowed,
        reason: allowed ? 'Permitido por política' : 'Negado (nenhuma política permite)',
        policies: ans.response.diagnostics.reason,
        auditLogId: this.auditId(),
      };
    } catch {
      return this.deny('engine_error');
    }
  }

  async checkPermissions(
    context: AuthContext,
    checks: Array<{ resource: Resource; action: string }>
  ): Promise<AccessDecision[]> {
    return Promise.all(checks.map((c) => this.checkPermission(context, c.resource, c.action)));
  }

  async listAccessibleResources(
    context: AuthContext,
    resourceType: string,
    action: string
  ): Promise<{ resourceIds: string[]; decision: AccessDecision }> {
    // Sem recurso concreto o Cedar não enumera: nega (listagem é da T207/consulta por vínculo).
    void context;
    void resourceType;
    void action;
    return { resourceIds: [], decision: this.deny('list_not_supported') };
  }

  private deny(reason: string): AccessDecision {
    return { allowed: false, reason, policies: [], auditLogId: this.auditId() };
  }

  private auditId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}
