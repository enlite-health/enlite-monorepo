/**
 * Porta do limitador de ESCRITAS do agente (contrato §5). A implementação de produção vive no BANCO
 * (`PgAgentWriteLimiter`): o balde em memória (`WriteRateLimiter`) vale N× com N instâncias do Cloud Run.
 */

/** Uma chamada de capability do agente = 1 linha em `iam.permission_audit_log` (ALLOW ou DENY). */
export interface AgentCallRecord {
  uid: string;
  /** Par `recurso`/`ação` da célula da capability (ou `mcp_capability`/<nome> quando `no_cell_declared`). */
  resource: string;
  action: string;
  /** `X-On-Behalf-Of-Worker-Id` (só ID). */
  resourceId?: string | null;
  /** Id da mensagem do prestador que originou a chamada (header opcional). NUNCA texto. */
  gatilhoId?: string | null;
  /** Versão do registro que governava o agente; `'nao-informado'` quando o header não veio (a trilha é telemetria, não gate). */
  registroVersao: string;
  ip?: string | null;
}

export type AdmitResult =
  | { ok: true }
  | { ok: false; code: 'AGENT_RATE_LIMITED'; retryAfterMs: number }
  | { ok: false; code: 'AGENT_LIMITER_UNAVAILABLE' };

export interface AgentWriteLimiter {
  /**
   * Admite ou recusa UMA chamada, gravando a linha da trilha na mesma transação:
   * leitura => só a linha ALLOW; escrita => trava por uid, conta o teto, grava ALLOW ou DENY.
   * Commita ANTES de a capability rodar. Nunca lança: erro de infraestrutura => `AGENT_LIMITER_UNAVAILABLE` (fail-closed).
   */
  admit(call: AgentCallRecord): Promise<AdmitResult>;
}
