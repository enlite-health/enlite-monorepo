import { logger } from '@shared/logging';
import type { AgentCellDecision } from './AgentCellGuard';
import { refusalResult } from './AgentCellGuard';
import type { AgentCallRecord, AgentWriteLimiter } from './AgentWriteLimiter';

/** O que a trilha precisa saber da chamada (vem dos headers; ambos OPCIONAIS — a trilha é telemetria, não gate). */
export interface AgentCallInput {
  uid: string;
  capability: string;
  resourceId?: string | null;
  gatilhoId?: string | null;
  registroVersao?: string | null;
  ip?: string | null;
}

/** Valor gravado em `registro_versao` quando o header não vem (a coluna é NOT NULL para agente). */
export const REGISTRO_VERSAO_NAO_INFORMADO = 'nao-informado';

export type GateResult<T> =
  | { allowed: true; value: T; decision: Extract<AgentCellDecision, { ok: true }> }
  | { allowed: false; refusal: ReturnType<typeof refusalResult> };

interface Deps {
  guard: { check(uid: string, capability: string): Promise<AgentCellDecision> };
  limiter: AgentWriteLimiter;
  audit: { recordDeny(call: AgentCallRecord): Promise<void> };
}

/**
 * Porta do agente, passo por chamada (contrato §5): célula -> limitador -> auditoria -> executa.
 * Exatamente 1 linha em `iam.permission_audit_log` por chamada (ALLOW ou DENY): o limitador grava a ALLOW (e a DENY de teto) na
 * própria transação e COMMITA antes de a capability rodar; o guard recusa por célula gravando a DENY aqui.
 */
export class AgentCallGate {
  constructor(private readonly deps: Deps) {}

  async run<T>(input: AgentCallInput, execute: (decision: Extract<AgentCellDecision, { ok: true }>) => Promise<T>): Promise<GateResult<T>> {
    const base = {
      uid: input.uid,
      resourceId: input.resourceId ?? null,
      gatilhoId: input.gatilhoId?.trim() || null,
      registroVersao: input.registroVersao?.trim() || REGISTRO_VERSAO_NAO_INFORMADO,
      ip: input.ip ?? null,
    };

    let decision: AgentCellDecision;
    try {
      decision = await this.deps.guard.check(input.uid, input.capability);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.name : 'error' }, '[mcp-agente] guard por célula indisponível — chamada recusada (fail-closed)');
      return { allowed: false, refusal: refusalResult('AGENT_AUTHZ_UNAVAILABLE', { capability: input.capability }) };
    }
    if (!decision.ok) {
      await this.deps.audit.recordDeny({ ...base, resource: decision.resource, action: decision.action });
      return {
        allowed: false,
        refusal: refusalResult(decision.code, { capability: input.capability, cell: `${decision.resource}:${decision.action}` }),
      };
    }

    const admit = await this.deps.limiter.admit({ ...base, resource: decision.resource, action: decision.action });
    if (!admit.ok) {
      const refusal =
        admit.code === 'AGENT_RATE_LIMITED'
          ? refusalResult(admit.code, {
              capability: input.capability,
              retryAfterMs: admit.retryAfterMs,
              message: `Rate limit exceeded for ${input.capability}. Retry after ${admit.retryAfterMs}ms`,
            })
          : refusalResult(admit.code, { capability: input.capability });
      return { allowed: false, refusal };
    }

    // A linha ALLOW já está commitada: se a capability falhar daqui para frente, a linha fica e conta no teto (conservador).
    return { allowed: true, value: await execute(decision), decision };
  }
}
