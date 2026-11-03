import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logging';
import { AGENT_TENANT_ID } from '../domain/AgentCapabilityCells';
import type { AgentCallRecord } from '../application/AgentWriteLimiter';

/**
 * Trilha do agente em `iam.permission_audit_log` (contrato §6). `actor_kind` vai SEMPRE explícito no INSERT, nunca pelo DEFAULT
 * (`humano`): omiti-lo gravaria o agente como pessoa. O caminho humano (`PgPermissionAuditRepository`) não é tocado.
 */
const INSERT_AGENT_AUDIT_SQL = `
  INSERT INTO iam.permission_audit_log
    (tenant_id, user_id, resource, action, resource_id, decision, ip_address, actor_kind, gatilho_id, registro_versao)
  VALUES ($1, $2, $3, $4, $5, $6, $7, 'agente', $8, $9)`;

/** INSERT numa transação já aberta (o limitador grava ALLOW/DENY junto com a contagem). */
export async function insertAgentAuditRow(
  client: Pick<PoolClient, 'query'>,
  call: AgentCallRecord,
  decision: 'ALLOW' | 'DENY',
): Promise<void> {
  await client.query(INSERT_AGENT_AUDIT_SQL, [
    AGENT_TENANT_ID,
    call.uid,
    call.resource,
    call.action,
    call.resourceId ?? null,
    decision,
    call.ip ?? null,
    call.gatilhoId ?? null,
    call.registroVersao,
  ]);
}

/**
 * Linha DENY que NÃO passa pelo limitador (recusa por célula: `missing_cell`, `no_group`, `no_cell_declared`...). Uma instrução só.
 * Falha de gravação vira log (só o nome do erro): a chamada JÁ está recusada, a trilha não a libera nem a derruba.
 */
export class PgAgentAuditRepository {
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async recordDeny(call: AgentCallRecord): Promise<void> {
    try {
      await insertAgentAuditRow(this.pool, call, 'DENY');
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.name : 'error' }, '[mcp-agente] falha ao gravar a linha DENY da trilha do agente');
    }
  }
}
