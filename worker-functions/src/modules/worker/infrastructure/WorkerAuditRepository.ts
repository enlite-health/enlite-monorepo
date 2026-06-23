import { Pool, type PoolClient } from 'pg';
import type { Request } from 'express';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger, reportError, loggingAls } from '@shared/logging';
import { resolveEventType } from '@shared/audit/BaseAuditLogRepository';
import type { AuditActorType, EntityFieldDiff } from '@shared/audit/types';

/** Quem está realizando a edição admin. */
export interface WorkerAuditActor {
  userId?: string | null;
  email?: string | null;
  actorType?: AuditActorType;
  actorLabel?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  traceId?: string | null;
}

/** Extrai o ator (quem/de-onde) do request autenticado para o trilho de auditoria. */
export function extractWorkerAuditActor(req: Request): WorkerAuditActor {
  const user = (req as Request & { user?: { uid?: string; email?: string } }).user;
  return {
    userId: user?.uid ?? null,
    email: user?.email ?? null,
    actorType: 'HUMAN',
    actorLabel: 'admin_panel',
    ipAddress: req.ip ?? null,
    userAgent: req.headers?.['user-agent'] ?? null,
    traceId: loggingAls?.getStore()?.traceId ?? null,
  };
}

export interface RecordWorkerAuditParams {
  workerId: string;
  fields: EntityFieldDiff[];
  actor: WorkerAuditActor;
}

/** Mantém só valores que o tipo INET aceita; descarta 'unknown' e vazios. */
function sanitizeIp(ip?: string | null): string | null {
  if (!ip || ip === 'unknown') return null;
  return ip;
}

/**
 * WorkerAuditRepository
 *
 * Grava o trilho de auditoria detalhado de edições admin do worker em
 * `worker_admin_audit_log` — uma linha por campo alterado (antes→depois),
 * com ator (uid/email/IP/user-agent) e trace. Best-effort: uma falha na
 * auditoria NÃO derruba a edição (já efetivada), mas é reportada ao Error
 * Reporting via reportError.
 */
export class WorkerAuditRepository {
  private readonly pool: Pool;

  constructor() {
    this.pool = DatabaseConnection.getInstance().getPool();
  }

  /** Resolve o e-mail do ator via users (o req não propaga e-mail). Best-effort. */
  private async resolveActorEmail(actor: WorkerAuditActor): Promise<string | null> {
    if (actor.email) return actor.email;
    if (!actor.userId) return null;
    try {
      const r = await this.pool.query<{ email: string }>(
        'SELECT email FROM users WHERE firebase_uid = $1',
        [actor.userId],
      );
      return r.rows[0]?.email ?? null;
    } catch {
      return null;
    }
  }

  async recordFieldChanges({ workerId, fields, actor }: RecordWorkerAuditParams): Promise<void> {
    if (fields.length === 0) return;

    const actorEmail = await this.resolveActorEmail(actor);
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      for (const f of fields) {
        await client.query(
          `INSERT INTO worker_admin_audit_log
             (worker_id, event_type, field_name, changes,
              actor_user_id, actor_email, actor_type, actor_label, ip_address, user_agent, trace_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::inet, $10, $11)`,
          [
            workerId,
            resolveEventType(f.field),
            f.field,
            JSON.stringify({ before: f.before, after: f.after }),
            actor.userId ?? null,
            actorEmail,
            actor.actorType ?? 'HUMAN',
            actor.actorLabel ?? 'admin_panel',
            sanitizeIp(actor.ipAddress),
            actor.userAgent ?? null,
            actor.traceId ?? null,
          ],
        );
      }
      await client.query('COMMIT');
      logger.info({
        msg: 'worker admin edit audited',
        workerId,
        actorUserId: actor.userId ?? null,
        fields: fields.map((f) => f.field),
        ip: sanitizeIp(actor.ipAddress),
        traceId: actor.traceId ?? null,
      });
    } catch (err) {
      if (client) { try { await client.query('ROLLBACK'); } catch { /* ignore */ } }
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'WorkerAuditRepository:recordFieldChanges', workerId });
    } finally {
      if (client) client.release();
    }
  }
}
