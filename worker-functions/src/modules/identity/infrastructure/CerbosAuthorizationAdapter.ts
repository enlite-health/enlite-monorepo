import { IAuthorizationEngine } from '../ports/IAuthorizationEngine';
import {
  AuthContext,
  AccessDecision,
} from '../domain/Auth';

/**
 * O principal como o Cerbos espera.
 *
 * `permissions`/`countries` vêm da resolução por request do `AuthMiddleware`
 * (change `painel-grupos-permissao`). Sem eles o adapter mandava só `roles` e
 * QUALQUER policy escrita sobre permissão negava — o buraco apontado no
 * ADR-006. Listas VAZIAS quando o engine está desligado: é o estado real, não
 * um default permissivo.
 *
 * Uma função só porque `check` e `plan` divergiam — o `plan` mandava apenas
 * `tenantId`, então a mesma policy decidia diferente nos dois caminhos.
 */
function principalPayload(context: AuthContext): Record<string, unknown> {
  return {
    id: context.principal.id,
    roles: context.principal.roles,
    attr: {
      tenantId: context.principal.tenantId,
      permissions: context.principal.permissions ?? [],
      countries: context.principal.countries ?? [],
      country: context.principal.country,
    },
  };
}

/**
 * Cerbos Authorization Adapter
 * 
 * This adapter allows seamless migration to Cerbos (https://cerbos.dev)
 * without changing business logic.
 * 
 * Cerbos provides:
 * - Distributed policy management
 * - Fine-grained access control (RBAC + ABAC)
 * - Policy as code (YAML/JSON)
 * - Audit logging
 * - High performance (written in Go)
 * 
 * Migration Path:
 * 1. Start with LocalAuthorizationEngine (current)
 * 2. Deploy Cerbos sidecar/container
 * 3. Switch to CerbosAuthorizationAdapter
 * 4. Policies move to Cerbos server
 * 
 * To enable Cerbos:
 * ```typescript
 * const authz = new CerbosAuthorizationAdapter({
 *   cerbosEndpoint: 'http://localhost:3592',
 *   playgroundEnabled: process.env.NODE_ENV === 'development'
 * });
 * ```
 */
export class CerbosAuthorizationAdapter implements IAuthorizationEngine {
  private cerbosEndpoint: string;
  private playgroundEnabled: boolean;

  constructor(config: {
    cerbosEndpoint: string;
    playgroundEnabled?: boolean;
  }) {
    this.cerbosEndpoint = config.cerbosEndpoint;
    this.playgroundEnabled = config.playgroundEnabled ?? false;
  }

  async checkPermission(
    context: AuthContext,
    resource: { type: string; id?: string; attrs?: Record<string, unknown> },
    action: string
  ): Promise<AccessDecision> {
    try {
      const response = await fetch(`${this.cerbosEndpoint}/api/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId: context.metadata.requestId,
          principal: principalPayload(context),
          resource: {
            kind: resource.type,
            id: resource.id,
            attr: resource.attrs,
          },
          actions: [action],
        }),
      });

      if (!response.ok) {
        throw new Error(`Cerbos returned ${response.status}`);
      }

      const result = await response.json() as {
        results?: Record<string, string>;
        metadata?: {
          policies?: string[];
          auditId?: string;
        };
      };
      const allowed = result.results?.[action] === 'EFFECT_ALLOW';

      return {
        allowed,
        reason: allowed ? 'Cerbos allowed' : 'Cerbos denied',
        policies: result.metadata?.policies || [],
        auditLogId: result.metadata?.auditId || this.generateAuditLogId(),
      };
    } catch (error) {
      // Fail closed - deny access if Cerbos is unavailable
      console.error('[CERBOS] Failed to check permission', error);
      return {
        allowed: false,
        reason: 'Authorization service unavailable',
        policies: [],
        auditLogId: this.generateAuditLogId(),
      };
    }
  }

  async checkPermissions(
    context: AuthContext,
    checks: Array<{
      resource: { type: string; id?: string; attrs?: Record<string, unknown> };
      action: string;
    }>
  ): Promise<AccessDecision[]> {
    // Batch check implementation
    const results: AccessDecision[] = [];
    
    for (const check of checks) {
      results.push(await this.checkPermission(context, check.resource, check.action));
    }
    
    return results;
  }

  async listAccessibleResources(
    context: AuthContext,
    resourceType: string,
    action: string
  ): Promise<{ resourceIds: string[]; decision: AccessDecision }> {
    // Cerbos doesn't directly support listing accessible resources
    // This would require a custom policy or query pattern
    
    // Option 1: Query all resources and filter with Cerbos
    // Option 2: Use Cerbos Plan Resources API (newer feature)
    
    try {
      const response = await fetch(`${this.cerbosEndpoint}/api/plan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requestId: context.metadata.requestId,
          principal: principalPayload(context),
          resource: {
            kind: resourceType,
          },
          action,
        }),
      });

      if (!response.ok) {
        throw new Error(`Cerbos plan API returned ${response.status}`);
      }
      
      const result = await response.json() as {
        resourceIds?: string[];
        metadata?: {
          policies?: string[];
          auditId?: string;
        };
      };
      
      return {
        resourceIds: result.resourceIds || [],
        decision: {
          allowed: true,
          reason: 'Resource plan generated',
          policies: result.metadata?.policies || [],
          auditLogId: result.metadata?.auditId || this.generateAuditLogId(),
        },
      };
    } catch (error) {
      return {
        resourceIds: [],
        decision: {
          allowed: false,
          reason: 'Failed to generate resource plan',
          policies: [],
          auditLogId: this.generateAuditLogId(),
        },
      };
    }
  }

  /**
   * Get Cerbos Playground URL for testing policies
   */
  getPlaygroundUrl(): string | null {
    if (!this.playgroundEnabled) return null;
    return `${this.cerbosEndpoint}/playground`;
  }

  /**
   * Reload policies (useful for policy hot-reloading)
   */
  async reloadPolicies(): Promise<boolean> {
    try {
      const response = await fetch(`${this.cerbosEndpoint}/admin/reload`, {
        method: 'POST',
      });
      return response.ok;
    } catch (error) {
      console.error('[CERBOS] Failed to reload policies', error);
      return false;
    }
  }

  private generateAuditLogId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }
}

/**
 * Example Cerbos Policy (YAML format for Cerbos server)
 * Save as: /policies/worker_resource.yaml
 * 
 * ```yaml
 * apiVersion: api.cerbos.dev/v1
 * resourcePolicy:
 *   version: default
 *   resource: worker
 *   rules:
 *     - actions: ['create']
 *       roles:
 *         - service_worker
 *         - admin
 *       effect: EFFECT_ALLOW
 * 
 *     - actions: ['read', 'update']
 *       roles:
 *         - worker
 *         - admin
 *         - service_worker
 *       effect: EFFECT_ALLOW
 *       condition:
 *         match:
 *           expr: request.resource.attr.ownerId == request.principal.id
 * 
 *     - actions: ['delete']
 *       roles:
 *         - admin
 *         - super_admin
 *       effect: EFFECT_ALLOW
 * 
 *     - actions: ['list']
 *       roles:
 *         - admin
 *         - service_worker
 *         - n8n_worker
 *       effect: EFFECT_ALLOW
 *       condition:
 *         match:
 *           expr: request.resource.attr.tenantId == request.principal.attr.tenantId
 * ```
 */
