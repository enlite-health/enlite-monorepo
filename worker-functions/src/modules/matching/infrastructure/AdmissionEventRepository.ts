import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { loggingAls } from '@shared/logging';
import type { AdmissionEventInput, AdmissionEventSink } from '../application/ports/AdmissionMessagingPorts';

/**
 * AdmissionEventRepository — a trilha append-only da reunião (`admission_events`, migration 504).
 * Só INSERT: o banco recusa UPDATE/DELETE (trigger + REVOKE). `ref` guarda SÓ ids. `trace_id` vem do ALS.
 */
export class AdmissionEventRepository implements AdmissionEventSink {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  /** `ex`: um client de transação (o evento entra ATOMICAMENTE com a mudança de estado que ele registra). */
  async append(event: AdmissionEventInput, ex: Pick<Pool, 'query'> | Pick<PoolClient, 'query'> = this.db): Promise<void> {
    const traceId = loggingAls?.getStore?.()?.traceId ?? null;
    await ex.query(
      `INSERT INTO admission_events (appointment_id, kind, outcome, reason, ref, trace_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        event.appointmentId,
        event.kind,
        event.outcome ?? null,
        event.reason ?? null,
        event.ref ? JSON.stringify(event.ref) : null,
        traceId,
      ],
    );
  }
}
