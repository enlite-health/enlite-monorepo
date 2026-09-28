/**
 * PatientItineraryReader — leitura crua do itinerário de um paciente (fase 7, DX-7.6).
 *
 * `readPatientItinerary` roda TUDO dentro de `inPatientTransaction` (RLS de país; memória
 * `connect-cru-sem-actor-context-da-500`): as 3 leituras (paciente, serviços ativos, slots +
 * alocações) usam o MESMO client de transação — nunca `pool.query` cru, que chegaria sem
 * `app.user_country` e a policy da 411 recusaria. O pool também não é pego no construtor nem no
 * topo do módulo: `inPatientTransaction` já cuida disso.
 *
 * Datas e horas saem do banco como TEXTO (`to_char`) — o driver `pg` converteria `date`/`time` em
 * `Date` à meia-noite LOCAL do processo, e o fuso do Cloud Run não é o do teste nem o do usuário
 * (a conversão certa é `GetPatientItineraryUseCase` + `localParts`).
 *
 * Nenhuma coluna de nome/telefone; nenhuma leitura da tabela de alocação antiga — a alocação
 * antiga não entra na conta nova (critério 11).
 */
import type { PoolClient } from 'pg';
import { inPatientTransaction } from '../application/patientTransaction';
import type { ItineraryAssignmentStatus } from '../domain/ServiceCoverageCalculator';
import { uncoveredAbsenceSelect } from './absenceSql';

export type { ItineraryAssignmentStatus };

export interface ItineraryServiceRow {
  id: string;
  weeklyHours: number | null;
  authorizedHours: number | null;
}

/**
 * Uma linha por par (slot, alocação) — `LEFT JOIN`, então um slot sem alocação vem com todos os
 * campos de alocação `null` (uma linha só, não zero).
 */
export interface ItinerarySlotRow {
  id: string;
  contractedServiceId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  active: boolean;
  assignmentId: string | null;
  workerId: string | null;
  applicationId: string | null;
  validFrom: string | null;
  validTo: string | null;
  status: ItineraryAssignmentStatus | null;
}

/** Uma ausência sem substituto (a candidata a "dia descoberto" — DX-13.9). Sem `workerId`/nome. */
export interface ItineraryUncoveredAbsenceRow {
  serviceId: string;
  date: string;
  startTime: string;
  endTime: string;
}

export interface ItineraryRows {
  country: string;
  services: ItineraryServiceRow[];
  slots: ItinerarySlotRow[];
  /** Opcional: nasce só na Fase 13. Sem filtro de vigência aqui — `uncoveredDayAlerts` decide (caso de uso). */
  uncoveredAbsences?: ItineraryUncoveredAbsenceRow[];
}

interface PatientCountryRow {
  id: string;
  country: string;
}

interface ServiceRow {
  id: string;
  weekly_hours: string | null;
  authorized_hours: string | null;
}

interface SlotJoinRow {
  id: string;
  contracted_service_id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  active: boolean;
  assignment_id: string | null;
  worker_id: string | null;
  application_id: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: ItineraryAssignmentStatus | null;
}

interface UncoveredAbsenceJoinRow {
  contracted_service_id: string;
  on_date: string;
  start_time: string;
  end_time: string;
}

export class PatientItineraryReader {
  /** `null` = paciente inexistente, soft-deletado, ou de outro país (RLS) — o caso de uso mapeia para 404. */
  async readPatientItinerary(patientId: string): Promise<ItineraryRows | null> {
    return inPatientTransaction((client) => this.run(client, patientId));
  }

  private async run(client: PoolClient, patientId: string): Promise<ItineraryRows | null> {
    const patientRes = await client.query<PatientCountryRow>(
      `SELECT id, country FROM patients WHERE id = $1 AND deleted_at IS NULL`,
      [patientId],
    );
    if ((patientRes.rowCount ?? 0) === 0) return null;
    const { country } = patientRes.rows[0];

    // Só serviço ATIVO: serviço baixado não tem cobertura a medir.
    const servicesRes = await client.query<ServiceRow>(
      `SELECT id, weekly_hours, authorized_hours
         FROM patient_contracted_services
        WHERE patient_id = $1 AND active
        ORDER BY created_at, id`,
      [patientId],
    );

    const slotsRes = await client.query<SlotJoinRow>(
      `SELECT s.id, s.contracted_service_id, s.weekday,
              to_char(s.start_time, 'HH24:MI') AS start_time,
              to_char(s.end_time, 'HH24:MI') AS end_time,
              s.active,
              a.id AS assignment_id, a.worker_id, a.application_id,
              to_char(a.valid_from, 'YYYY-MM-DD') AS valid_from,
              to_char(a.valid_to, 'YYYY-MM-DD') AS valid_to,
              a.status
         FROM patient_itinerary_slot s
         JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
         LEFT JOIN patient_itinerary_assignment a ON a.slot_id = s.id
        WHERE pcs.patient_id = $1 AND pcs.active
        ORDER BY s.contracted_service_id, s.weekday, s.start_time, a.valid_from`,
      [patientId],
    );

    // Ausência sem substituto (DX-13.9): sem filtro de data aqui — `uncoveredDayAlerts` (caso de
    // uso) decide `date >= asOf`. Nenhuma coluna de nome/telefone; `ab.substitute_worker_id IS NULL`
    // exclui quem já tem substituto (coberto, não é alerta). Fragmento único em `absenceSql.ts`
    // (só conta ausência sobre alocação ACTIVE e vigente na data — gate parcial #1).
    const uncoveredRes = await client.query<UncoveredAbsenceJoinRow>(
      uncoveredAbsenceSelect('pcs.patient_id = $1 AND pcs.active'),
      [patientId],
    );

    return {
      country,
      services: servicesRes.rows.map((r) => ({
        id: r.id,
        weeklyHours: r.weekly_hours != null ? Number(r.weekly_hours) : null,
        authorizedHours: r.authorized_hours != null ? Number(r.authorized_hours) : null,
      })),
      slots: slotsRes.rows.map((r) => ({
        id: r.id,
        contractedServiceId: r.contracted_service_id,
        weekday: r.weekday,
        startTime: r.start_time,
        endTime: r.end_time,
        active: r.active,
        assignmentId: r.assignment_id,
        workerId: r.worker_id,
        applicationId: r.application_id,
        validFrom: r.valid_from,
        validTo: r.valid_to,
        status: r.status,
      })),
      uncoveredAbsences: uncoveredRes.rows.map((r) => ({
        serviceId: r.contracted_service_id,
        date: r.on_date,
        startTime: r.start_time,
        endTime: r.end_time,
      })),
    };
  }
}
