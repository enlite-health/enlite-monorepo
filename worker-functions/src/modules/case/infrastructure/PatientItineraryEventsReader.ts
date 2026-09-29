/**
 * PatientItineraryEventsReader — leitura crua para a coluna "Próximos eventos/Substituição"
 * (D445.3). Molde de `PatientItineraryReader.ts`: roda inteiro em `inPatientTransaction` (RLS de
 * país), datas/horas saem como TEXTO (`to_char` — nunca `Date` do driver). Duas queries: (1) toda
 * alocação de serviço ATIVO que possa valer em algum dia do intervalo (`valid_from <= to` e
 * `valid_to` nulo ou `>= from` — o filtro fino por dia da semana é do expansor puro,
 * `itineraryEvents.ts`); (2) toda ausência ABERTA (não cancelada) com `on_date` dentro do
 * intervalo, sobre alocação do titular `ACTIVE` (mesmo predicado de `absenceSql.ts`, sem o
 * `substitute_worker_id IS NULL` — aqui interessa toda ausência, com ou sem substituto).
 *
 * Nome de prestador NÃO sai daqui — quem decifra é o caso de uso (`GetPatientItineraryEventsUseCase`),
 * com a célula, como o GET do itinerário (DX-12.5).
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from '../application/patientTransaction';
import type { ItineraryEventAssignmentRow, ItineraryEventAbsenceRow } from '../domain/itineraryEvents';

export interface ItineraryEventsRows {
  country: string;
  assignments: ItineraryEventAssignmentRow[];
  absences: ItineraryEventAbsenceRow[];
  /** Fonte cifrada do nome de cada worker distinto (titular + substituto) que aparece no intervalo. */
  workerNames: ItineraryEventWorkerNameRow[];
}

interface PatientCountryRow {
  id: string;
  country: string;
}

interface AssignmentJoinRow {
  assignment_id: string;
  slot_id: string;
  contracted_service_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  worker_id: string;
  valid_from: string;
  valid_to: string | null;
  status: 'ACTIVE' | 'ENDED' | 'CANCELLED';
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

interface AbsenceJoinRow {
  id: string;
  assignment_id: string;
  on_date: string;
  substitute_worker_id: string | null;
  sub_first_name_encrypted: string | null;
  sub_last_name_encrypted: string | null;
}

/** Fonte cifrada do nome de um worker (titular ou substituto) — mesma forma de `WorkerNameSource`. */
export interface ItineraryEventWorkerNameRow {
  workerId: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

export class PatientItineraryEventsReader {
  /** `null` = paciente inexistente/soft-deletado/outro país (RLS) — o caso de uso mapeia para 404. */
  async readForRange(patientId: string, from: string, to: string): Promise<ItineraryEventsRows | null> {
    return inPatientTransaction((client) => this.run(client, patientId, from, to));
  }

  private async run(client: PoolClient, patientId: string, from: string, to: string): Promise<ItineraryEventsRows | null> {
    const patientRes = await client.query<PatientCountryRow>(
      `SELECT id, country FROM patients WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    if ((patientRes.rowCount ?? 0) === 0) return null;
    const { country } = patientRes.rows[0];

    const assignmentsRes = await client.query<AssignmentJoinRow>(
      `SELECT a.id AS assignment_id, a.slot_id, s.contracted_service_id, s.weekday,
              to_char(s.start_time, 'HH24:MI') AS start_time,
              to_char(s.end_time, 'HH24:MI') AS end_time,
              a.worker_id,
              to_char(a.valid_from, 'YYYY-MM-DD') AS valid_from,
              to_char(a.valid_to, 'YYYY-MM-DD') AS valid_to,
              a.status,
              w.first_name_encrypted, w.last_name_encrypted
         FROM patient_itinerary_assignment a
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
         JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
         LEFT JOIN workers w ON w.id = a.worker_id
        WHERE pcs.patient_id = $1 AND pcs.active AND a.status = 'ACTIVE'
          AND a.valid_from <= $3::date
          AND (a.valid_to IS NULL OR a.valid_to >= $2::date)
        ORDER BY s.contracted_service_id, s.weekday, s.start_time`,
      [patientId, from, to],
    );

    const absencesRes = await client.query<AbsenceJoinRow>(
      `SELECT ab.id, ab.assignment_id, to_char(ab.on_date, 'YYYY-MM-DD') AS on_date, ab.substitute_worker_id,
              sw.first_name_encrypted AS sub_first_name_encrypted, sw.last_name_encrypted AS sub_last_name_encrypted
         FROM patient_itinerary_absence ab
         JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
         JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
         LEFT JOIN workers sw ON sw.id = ab.substitute_worker_id
        WHERE pcs.patient_id = $1 AND pcs.active
          AND ab.cancelled_at IS NULL
          AND ab.on_date BETWEEN $2::date AND $3::date
        ORDER BY ab.on_date`,
      [patientId, from, to],
    );

    const workerNames = new Map<string, ItineraryEventWorkerNameRow>();
    for (const r of assignmentsRes.rows) {
      if (!workerNames.has(r.worker_id)) {
        workerNames.set(r.worker_id, {
          workerId: r.worker_id,
          firstNameEncrypted: r.first_name_encrypted,
          lastNameEncrypted: r.last_name_encrypted,
        });
      }
    }
    for (const r of absencesRes.rows) {
      if (r.substitute_worker_id && !workerNames.has(r.substitute_worker_id)) {
        workerNames.set(r.substitute_worker_id, {
          workerId: r.substitute_worker_id,
          firstNameEncrypted: r.sub_first_name_encrypted,
          lastNameEncrypted: r.sub_last_name_encrypted,
        });
      }
    }

    return {
      country,
      assignments: assignmentsRes.rows.map((r) => ({
        assignmentId: r.assignment_id,
        slotId: r.slot_id,
        serviceId: r.contracted_service_id,
        weekday: r.weekday,
        startTime: r.start_time,
        endTime: r.end_time,
        workerId: r.worker_id,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        status: r.status,
      })),
      absences: absencesRes.rows.map((r) => ({
        absenceId: r.id,
        assignmentId: r.assignment_id,
        onDate: r.on_date,
        substituteWorkerId: r.substitute_worker_id,
      })),
      workerNames: [...workerNames.values()],
    };
  }
}
