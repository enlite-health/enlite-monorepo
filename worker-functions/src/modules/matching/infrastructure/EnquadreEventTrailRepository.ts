import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { loggingAls } from '@shared/logging';
import type { AdmissionEventInput } from '../application/ports/AdmissionMessagingPorts';
import type { Ex, SubjectTrail } from '../application/ports/PostCallPorts';

/**
 * EnquadreEventTrailRepository — a trilha append-only do evento de enquadre (`enquadre_event_trail`, migration 521), no molde de
 * `AdmissionEventRepository`. Só INSERT: o banco recusa UPDATE/DELETE (trigger + REVOKE). Mesmos nomes de etapa (`kind`) da
 * admissão. `appointmentId` do `AdmissionEventInput` carrega aqui o id do EVENTO. `ref` guarda SÓ ids, hashes e contagens.
 */
export class EnquadreEventTrailRepository implements SubjectTrail {
  constructor(private readonly db: Pool = DatabaseConnection.getInstance().getPool()) {}

  /** `ex`: o client da transação (o registro entra ATOMICAMENTE com a mudança de estado que ele descreve). */
  async append(event: AdmissionEventInput, ex: Ex = this.db): Promise<void> {
    const traceId = loggingAls?.getStore?.()?.traceId ?? null;
    await ex.query(
      `INSERT INTO enquadre_event_trail (event_id, kind, outcome, reason, ref, trace_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [event.appointmentId, event.kind, event.outcome ?? null, event.reason ?? null, event.ref ? JSON.stringify(event.ref) : null, traceId],
    );
  }
}
