/**
 * ScheduledAttendanceReader — o que um prestador tem AGENDADO num serviço a partir de `today` (058 P5c; design trocas D4 "Agendamentos"):
 * (a) ausências abertas em que ele é o substituto (`on_date >= today`); (b) alocações `ACTIVE` dele que começam depois de hoje
 * (`valid_from > today`), com a alocação que cada uma substitui (a `ACTIVE` da mesma faixa que termina na véspera). Só leitura, no client recebido.
 */
import type { PoolClient } from 'pg';

export interface ScheduledSubstitution { absenceId: string; date: string }
export interface ScheduledEntry { allocationId: string; validFrom: string; replacesAllocationId: string | null }
export interface ScheduledAttendances { substitutions: ScheduledSubstitution[]; futureEntries: ScheduledEntry[] }

export function hasScheduledAttendances(s: ScheduledAttendances): boolean {
  return s.substitutions.length > 0 || s.futureEntries.length > 0;
}

export class ScheduledAttendanceReader {
  async listFor(client: PoolClient, serviceId: string, workerId: string, today: string): Promise<ScheduledAttendances> {
    const subs = await client.query<{ absence_id: string; on_date: string }>(
      `SELECT ab.id AS absence_id, to_char(ab.on_date,'YYYY-MM-DD') AS on_date
         FROM patient_itinerary_absence ab
         JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
        WHERE s.contracted_service_id = $1 AND ab.substitute_worker_id = $2
          AND ab.cancelled_at IS NULL AND ab.on_date >= $3::date
        ORDER BY ab.on_date, ab.id`,
      [serviceId, workerId, today],
    );
    const entries = await client.query<{ allocation_id: string; valid_from: string; replaces_allocation_id: string | null }>(
      `SELECT a.id AS allocation_id, to_char(a.valid_from,'YYYY-MM-DD') AS valid_from,
              (SELECT p.id FROM patient_itinerary_assignment p
                WHERE p.slot_id = a.slot_id AND p.status = 'ACTIVE' AND p.id <> a.id AND p.valid_to = a.valid_from - 1
                LIMIT 1) AS replaces_allocation_id
         FROM patient_itinerary_assignment a
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
        WHERE s.contracted_service_id = $1 AND a.worker_id = $2 AND a.status = 'ACTIVE' AND a.valid_from > $3::date
        ORDER BY a.valid_from, a.id`,
      [serviceId, workerId, today],
    );
    return {
      substitutions: subs.rows.map((r) => ({ absenceId: r.absence_id, date: r.on_date })),
      futureEntries: entries.rows.map((r) => ({ allocationId: r.allocation_id, validFrom: r.valid_from, replacesAllocationId: r.replaces_allocation_id })),
    };
  }
}
