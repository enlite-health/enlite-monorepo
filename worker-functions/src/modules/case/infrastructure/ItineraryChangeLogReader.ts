/**
 * ItineraryChangeLogReader — leitura do registro de trocas (C9, design D3/D4). `listByService` roda
 * dentro de `inPatientTransaction` (RLS de país; memória `connect-cru-sem-actor-context-da-500`) ou
 * no client que o chamador já tem (`listByServiceWith`). `LEFT JOIN service_exit_reasons` só para o
 * `reasonLabel` (o rótulo vive no catálogo; se o item sumir do join, o rótulo vem `null`).
 * Sem nome de prestador: pessoa só por id.
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from '../application/patientTransaction';
import type { ItineraryChangeDestination, ItineraryChangeKind } from './ItineraryChangeLogWriter';

export interface ItineraryChangeEntry {
  id: string;
  kind: ItineraryChangeKind;
  effectiveDate: string;
  outgoingWorkerId: string;
  incomingWorkerId: string | null;
  reasonCode: string;
  reasonLabel: string | null;
  destination: ItineraryChangeDestination | null;
  createdBy: string;
  createdAt: string;
}

interface ChangeRow {
  id: string;
  kind: ItineraryChangeKind;
  effective_date: string;
  outgoing_worker_id: string;
  incoming_worker_id: string | null;
  reason_code: string;
  reason_label: string | null;
  destination: ItineraryChangeDestination | null;
  created_by: string;
  created_at: Date | string;
}

export class ItineraryChangeLogReader {
  /** `null` = serviço inexistente/de outro paciente/fora da RLS (o controller mapeia para 404). */
  async listByService(patientId: string, serviceId: string): Promise<ItineraryChangeEntry[] | null> {
    return inPatientTransaction((client) => this.listByServiceWith(client, patientId, serviceId));
  }

  async listByServiceWith(client: PoolClient, patientId: string, serviceId: string): Promise<ItineraryChangeEntry[] | null> {
    const svc = await client.query('SELECT 1 FROM patient_contracted_services WHERE id = $2 AND patient_id = $1', [patientId, serviceId]);
    if ((svc.rowCount ?? 0) === 0) return null;
    const res = await client.query<ChangeRow>(
      `SELECT l.id, l.kind, to_char(l.effective_date,'YYYY-MM-DD') AS effective_date,
              l.outgoing_worker_id, l.incoming_worker_id, l.reason_code, ser.label AS reason_label,
              l.destination, l.created_by, l.created_at
         FROM patient_itinerary_change_log l
         LEFT JOIN service_exit_reasons ser ON ser.code = l.reason_code
        WHERE l.contracted_service_id = $1
        ORDER BY l.created_at DESC, l.id`,
      [serviceId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      effectiveDate: r.effective_date,
      outgoingWorkerId: r.outgoing_worker_id,
      incomingWorkerId: r.incoming_worker_id,
      reasonCode: r.reason_code,
      reasonLabel: r.reason_label,
      destination: r.destination,
      createdBy: r.created_by,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    }));
  }
}
