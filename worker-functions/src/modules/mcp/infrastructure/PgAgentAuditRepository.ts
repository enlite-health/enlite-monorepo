import type { PoolClient } from 'pg';
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
