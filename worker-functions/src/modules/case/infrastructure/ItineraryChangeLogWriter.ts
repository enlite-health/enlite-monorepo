/**
 * ItineraryChangeLogWriter — registro de trocas do itinerário (migration 494, change
 * itinerario-trocas-motivos-e-figma, Fase 2, design D3). Molde `ItineraryAbsenceWriter.ts`: UMA query
 * no `client` recebido; a transação é de quem chama e o `insert` roda no MESMO client da escrita da
 * troca (ausência, alocação…), nunca em transação própria.
 *
 * Append-only: só INSERT (o banco recusa UPDATE/DELETE ao `app_runtime`). `country` não é passado —
 * o trigger herda do serviço. Sem texto livre: pessoa só por id, motivo só por `code` do catálogo
 * (FK). Os CHECKs `picl_kind_check`/`picl_destination_by_kind` são a 2ª camada; quem decide o
 * `destination` de REPLACE/REMOVE é o caso de uso (Fases 4 e 6).
 */
import type { PoolClient } from 'pg';

export type ItineraryChangeKind = 'ABSENCE' | 'REPLACE' | 'REMOVE' | 'SUBSTITUTE_CANCELLED' | 'ENTRY_CANCELLED';
export type ItineraryChangeDestination = 'RESERVE' | 'LEAVE_SERVICE';

export interface InsertItineraryChangeInput {
  serviceId: string;
  kind: ItineraryChangeKind;
  outgoingWorkerId: string;
  incomingWorkerId?: string | null;
  assignmentId?: string | null;
  newAssignmentId?: string | null;
  absenceId?: string | null;
  /** `YYYY-MM-DD` — a data do efeito, nunca `now()`. */
  effectiveDate: string;
  reasonCode: string;
  destination?: ItineraryChangeDestination | null;
  actorUid: string;
}

export class ItineraryChangeLogWriter {
  async insert(client: PoolClient, input: InsertItineraryChangeInput): Promise<{ id: string }> {
    const res = await client.query<{ id: string }>(
      `INSERT INTO patient_itinerary_change_log
         (contracted_service_id, kind, outgoing_worker_id, incoming_worker_id, assignment_id, new_assignment_id,
          absence_id, effective_date, reason_code, destination, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10, $11)
       RETURNING id`,
      [
        input.serviceId,
        input.kind,
        input.outgoingWorkerId,
        input.incomingWorkerId ?? null,
        input.assignmentId ?? null,
        input.newAssignmentId ?? null,
        input.absenceId ?? null,
        input.effectiveDate,
        input.reasonCode,
        input.destination ?? null,
        input.actorUid,
      ],
    );
    return { id: res.rows[0].id };
  }
}
