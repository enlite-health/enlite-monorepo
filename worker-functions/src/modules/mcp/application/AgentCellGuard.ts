import type { ResolvedAuthz } from '@modules/identity/permissions';
import {
  AGENT_CAPABILITY_CELLS,
  AGENT_CAPABILITY_NAMES,
  AGENT_SYSTEM_CAPABILITIES,
  AGENT_TENANT_ID,
} from '../domain/AgentCapabilityCells';

export type AgentRefusalCode = 'missing_cell' | 'no_group' | 'account_not_active' | 'no_cell_declared';

/** Resultado do guard. `exception` = classe (b), sem célula do grupo (contexto de sistema). */
export type AgentCellDecision =
  | { ok: true; resource: string; action: string; exception: boolean }
  | { ok: false; code: AgentRefusalCode; resource: string; action: string };

/** O pedaço do `PermissionService` que o guard usa. */
export interface AuthzResolver {
  resolve(uid: string, tenantId: string): Promise<ResolvedAuthz>;
}

/** Formato de recusa de capability dentro de `tools/call`: resultado 200 `{content:[text], isError:true}` (FORMATO_RECUSA da M2.0.5). */
export function refusalResult(code: string, extra: Record<string, unknown> = {}): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text', text: JSON.stringify({ code, ...extra }) }], isError: true };
}

/**
 * Checagem por célula da capability do agente: `PermissionService.resolve(uid)` real, na ordem do `PermissionMiddleware.denialFor`
 * (status -> grupo -> célula). O cache de 30 s do `PermissionService` vale para a CÉLULA (o `status` do pânico é lido sem cache em
 * `requireAgentPrincipal`). Fail-closed: capability fora do mapa => `no_cell_declared`.
 */
export class AgentCellGuard {
  constructor(private readonly authz: AuthzResolver) {}

  async check(uid: string, capability: string): Promise<AgentCellDecision> {
    // hasOwnProperty: `constructor`/`toString` não podem virar capability por herança do Object.
    const sistema = Object.prototype.hasOwnProperty.call(AGENT_SYSTEM_CAPABILITIES, capability)
      ? AGENT_SYSTEM_CAPABILITIES[capability]
      : undefined;
    if (sistema) return { ok: true, ...sistema, exception: true };

    if (!Object.prototype.hasOwnProperty.call(AGENT_CAPABILITY_CELLS, capability)) return { ok: false, code: 'no_cell_declared', resource: 'mcp_capability', action: capability };
    const [resource, action] = AGENT_CAPABILITY_CELLS[capability].split(':');

    const resolved = await this.authz.resolve(uid, AGENT_TENANT_ID);
    if (resolved.status !== 'ACTIVE') return { ok: false, code: 'account_not_active', resource, action };
    if (resolved.groups.length === 0) return { ok: false, code: 'no_group', resource, action };
    const cells = resolved.permissions;
    if (!cells.includes(AGENT_CAPABILITY_CELLS[capability])) return { ok: false, code: 'missing_cell', resource, action };
    return { ok: true, resource, action, exception: false };
  }

  /**
   * Cobertura: quais capabilities da classe (a) o grupo do agente cobre HOJE. É o que a operação confere antes de ligar a Luz
   * (concessão das células em /admin/access) e o que o verificador do item 36 lê — sem executar capability nenhuma.
   */
  async coverage(uid: string): Promise<Array<{ capability: string; cell: string; granted: boolean }>> {
    const resolved = await this.authz.resolve(uid, AGENT_TENANT_ID);
    const cells = resolved.status === 'ACTIVE' ? resolved.permissions : [];
    const out: Array<{ capability: string; cell: string; granted: boolean }> = [];
    for (const capability of AGENT_CAPABILITY_NAMES) {
      out.push({ capability, cell: AGENT_CAPABILITY_CELLS[capability], granted: cells.includes(AGENT_CAPABILITY_CELLS[capability]) });
    }
    return out;
  }
}
