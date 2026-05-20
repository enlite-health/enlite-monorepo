export interface McpAuditEvent {
  timestamp: string;                      // ISO
  principal: string;                      // nome do service principal
  onBehalfOfWorkerId: string | null;
  capability: string;
  argsRedacted: Record<string, unknown>;  // PII sanitizada
  outcome: 'success' | 'error';
  errorCode?: string;
  errorMessage?: string;
  latencyMs: number;
}
