import type { Pool, PoolClient } from 'pg';
import { logger } from '@shared/logging';
import { AGENT_WRITE_LIMIT_PER_MIN, isAgentWrite } from '../domain/AgentCapabilityCells';
import type { AdmitResult, AgentCallRecord, AgentWriteLimiter } from '../application/AgentWriteLimiter';
import { insertAgentAuditRow } from './PgAgentAuditRepository';

const LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('agent-write:' || $1))`;
/** Conta ALLOW de escrita do agente na janela de 60 s (índice parcial `idx_pal_agente_user_created`); `retry` = quando a mais antiga sai da janela. */
const COUNT_SQL = `
  SELECT count(*)::int AS n,
         GREATEST(1, ceil(extract(epoch FROM (min(created_at) + interval '60 seconds' - now())) * 1000))::int AS retry_ms
    FROM iam.permission_audit_log
   WHERE actor_kind = 'agente' AND user_id = $1 AND decision = 'ALLOW' AND action <> 'read'
     AND created_at > now() - interval '60 seconds'`;

/**
 * Limitador de escritas no BANCO, fail-closed (contrato §5). Uma transação por chamada:
 *  1. (só escrita) `pg_advisory_xact_lock` por uid — serializa as instâncias;
 *  2. (só escrita) conta as ALLOW da janela; `>= teto` => grava a linha DENY e recusa;
 *  3. grava a linha ALLOW e COMMITA — a capability roda DEPOIS (a linha é "intenção": se a capability falhar, ela fica e conta).
 * Erro de pool/lock/SELECT/INSERT => `AGENT_LIMITER_UNAVAILABLE`; o chamador NÃO executa a capability.
 */
export class PgAgentWriteLimiter implements AgentWriteLimiter {
  constructor(
    private readonly pool: Pick<Pool, 'connect'>,
    private readonly limitPerMin: number = AGENT_WRITE_LIMIT_PER_MIN,
  ) {}

  async admit(call: AgentCallRecord): Promise<AdmitResult> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      let result: AdmitResult = { ok: true };
      if (isAgentWrite(call.action)) {
        await client.query(LOCK_SQL, [call.uid]);
        const r = await client.query<{ n: number; retry_ms: number | null }>(COUNT_SQL, [call.uid]);
        const { n, retry_ms: retryMs } = r.rows[0];
        if (n >= this.limitPerMin) result = { ok: false, code: 'AGENT_RATE_LIMITED', retryAfterMs: retryMs ?? 1 };
      }
      await insertAgentAuditRow(client, call, result.ok ? 'ALLOW' : 'DENY');
      await client.query('COMMIT');
      return result;
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      logger.error({ error: err instanceof Error ? err.name : 'error' }, '[mcp-agente] limitador indisponível — chamada recusada (fail-closed)');
      return { ok: false, code: 'AGENT_LIMITER_UNAVAILABLE' };
    } finally {
      client?.release();
    }
  }
}
