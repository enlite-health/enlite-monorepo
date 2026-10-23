/**
 * occurrenceInputs — spec 069 (FR-12): a leitura crua que alimenta `expandServiceOccurrences`, UMA vez, para os três leitores
 * (eventos da agenda, itinerário do paciente, agregado do Kanban). Três consultas no `client` da transação (RLS de país):
 *  (1) as FAIXAS cuja vigência `valid` toca a janela (não só as vigentes hoje — a expansão decide por data);
 *  (2) as alocações ACTIVE que tocam a janela, nessas faixas;
 *  (3) as ausências VIVAS (`liveAbsencePredicate`: não cancelada, sobre alocação ACTIVE vigente na data) com `on_date` na janela.
 * Datas/horas saem como TEXTO (`to_char`) — nunca `Date` do driver. Nenhuma coluna de nome/telefone/endereço.
 *
 * O chamador escreve o escopo (`scopeSql` sobre os aliases `pcs`/`s`) e a janela (`fromSql`/`toSql`) numerando os `$n` do
 * `params`: assim o leitor do Kanban pode passar a janela como SQL (`CURRENT_DATE - 1` … — SUPERCONJUNTO da janela do país,
 * quem decide é a expansão) sem um 2º jeito de montar a consulta.
 */
import type { PoolClient } from 'pg';
import { slotEndTimeSql } from '@shared/sql/serviceScheduleSql';
import { liveAbsencePredicate } from './absenceSql';
import { toWire } from '../domain/dateRangeWire';
import type { OccurrenceAbsence, OccurrenceAssignment, OccurrenceSlot } from '../domain/serviceOccurrences';
import type { ItineraryAssignmentStatus } from '../domain/ServiceCoverageCalculator';

export interface OccurrenceInputs {
  slots: OccurrenceSlot[];
  assignments: OccurrenceAssignment[];
  absences: OccurrenceAbsence[];
}

export interface OccurrenceScope {
  /** Condição sobre `pcs` (patient_contracted_services) — já inclui `pcs.active`. */
  scopeSql: string;
  /** JOINs extras (ex.: `patients p`) que o `scopeSql` use. */
  extraJoin?: string;
  fromSql: string;
  toSql: string;
  params: unknown[];
}

/** Os mesmos dados, por paciente (o Kanban lê todos os pacientes do filtro numa leitura só). */
export type OccurrenceInputsByPatient = Map<string, OccurrenceInputs>;

interface SlotRow {
  patient_id: string;
  slot_id: string;
  service_id: string;
  weekday: number;
  start_time: string;
  slot_end: string;
  /** `daterange` em texto (`[2026-01-01,)`): quem converte para o fio é `dateRangeWire.toWire` — o único dono. */
  valid_range: string;
}
interface AssignmentRow {
  patient_id: string;
  assignment_id: string;
  slot_id: string;
  worker_id: string;
  valid_from: string;
  valid_to: string | null;
  status: ItineraryAssignmentStatus;
}
interface AbsenceRow {
  patient_id: string;
  absence_id: string;
  assignment_id: string;
  on_date: string;
  substitute_worker_id: string | null;
  request_id: string | null;
}

export async function readOccurrenceInputsByPatient(client: PoolClient, scope: OccurrenceScope): Promise<OccurrenceInputsByPatient> {
  const { scopeSql, extraJoin = '', fromSql, toSql, params } = scope;
  const window = `daterange((${fromSql})::date, (${toSql})::date, '[]')`;
  const slotTouchesWindow = `s.valid && ${window}`;

  const slotsRes = await client.query<SlotRow>(
    `SELECT pcs.patient_id, s.id AS slot_id, s.contracted_service_id AS service_id, s.weekday,
            to_char(s.start_time, 'HH24:MI') AS start_time, ${slotEndTimeSql('s')} AS slot_end,
            s.valid::text AS valid_range
       FROM patient_itinerary_slot s
       JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
       ${extraJoin}
      WHERE ${scopeSql} AND ${slotTouchesWindow}
      ORDER BY pcs.patient_id, s.contracted_service_id, s.weekday, s.start_time`,
    params,
  );

  const assignmentsRes = await client.query<AssignmentRow>(
    `SELECT pcs.patient_id, a.id AS assignment_id, a.slot_id, a.worker_id,
            to_char(a.valid_from, 'YYYY-MM-DD') AS valid_from, to_char(a.valid_to, 'YYYY-MM-DD') AS valid_to, a.status
       FROM patient_itinerary_assignment a
       JOIN patient_itinerary_slot s ON s.id = a.slot_id
       JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
       ${extraJoin}
      WHERE ${scopeSql} AND ${slotTouchesWindow}
        AND a.status = 'ACTIVE'
        AND a.valid_from <= (${toSql})::date
        AND (a.valid_to IS NULL OR a.valid_to >= (${fromSql})::date)
      ORDER BY pcs.patient_id, a.slot_id, a.valid_from, a.id`,
    params,
  );

  const absencesRes = await client.query<AbsenceRow>(
    `SELECT pcs.patient_id, ab.id AS absence_id, ab.assignment_id, to_char(ab.on_date, 'YYYY-MM-DD') AS on_date,
            ab.substitute_worker_id, ab.request_id
       FROM patient_itinerary_absence ab
       JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
       JOIN patient_itinerary_slot s ON s.id = a.slot_id
       JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
       ${extraJoin}
      WHERE ${scopeSql} AND ${liveAbsencePredicate('ab', 'a')}
        AND ab.on_date BETWEEN (${fromSql})::date AND (${toSql})::date
      ORDER BY pcs.patient_id, ab.on_date, ab.id`,
    params,
  );

  const byPatient: OccurrenceInputsByPatient = new Map();
  const of = (patientId: string): OccurrenceInputs => {
    let inputs = byPatient.get(patientId);
    if (!inputs) {
      inputs = { slots: [], assignments: [], absences: [] };
      byPatient.set(patientId, inputs);
    }
    return inputs;
  };
  for (const r of slotsRes.rows) {
    const { validFrom, validTo } = toWire(r.valid_range);
    of(r.patient_id).slots.push({
      slotId: r.slot_id,
      serviceId: r.service_id,
      weekday: r.weekday,
      startTime: r.start_time,
      endTime: r.slot_end,
      validFrom,
      validTo,
    });
  }
  for (const r of assignmentsRes.rows) {
    of(r.patient_id).assignments.push({
      assignmentId: r.assignment_id,
      slotId: r.slot_id,
      workerId: r.worker_id,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      status: r.status,
    });
  }
  for (const r of absencesRes.rows) {
    of(r.patient_id).absences.push({
      absenceId: r.absence_id,
      assignmentId: r.assignment_id,
      onDate: r.on_date,
      substituteWorkerId: r.substitute_worker_id,
      requestId: r.request_id,
    });
  }
  return byPatient;
}

export const EMPTY_OCCURRENCE_INPUTS: OccurrenceInputs = Object.freeze({ slots: [], assignments: [], absences: [] }) as OccurrenceInputs;

/** As faixas/alocações/ausências vivas de UM serviço do paciente no intervalo exato `[from, to]` (pré-visão e criação do pedido). */
export async function readServiceOccurrenceInputs(
  client: PoolClient,
  patientId: string,
  serviceId: string,
  from: string,
  to: string,
): Promise<OccurrenceInputs> {
  const byPatient = await readOccurrenceInputsByPatient(client, {
    scopeSql: 'pcs.patient_id = $1 AND pcs.id = $2 AND pcs.active',
    fromSql: '$3::date',
    toSql: '$4::date',
    params: [patientId, serviceId, from, to],
  });
  return byPatient.get(patientId) ?? EMPTY_OCCURRENCE_INPUTS;
}
