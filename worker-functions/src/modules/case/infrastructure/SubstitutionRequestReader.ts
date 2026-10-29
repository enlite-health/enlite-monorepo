/**
 * SubstitutionRequestReader — leitura crua dos pedidos de substituição de UM serviço (spec 069, FR-20) e das pessoas que podem
 * "não vir" (US3). Tudo no `client` da transação (RLS de país); datas/horas por `to_char` (nunca `Date` do driver). Nome só
 * CIFRADO — quem decifra é o caso de uso, com a célula (DX-12.5). O que é tipo, período, nº de turnos, Entra, "Ajustado" NÃO
 * é lido: é derivado em `domain/substitutionRequest.ts`.
 */
import type { PoolClient } from 'pg';
import type { ItineraryAssignmentStatus } from '../domain/ServiceCoverageCalculator';
import type { RequestAbsenceRow, RequestHeaderRow, RequestLogRow, RequestNewAssignmentRow } from '../domain/substitutionRequest';

export interface RequestScopedAbsence extends RequestAbsenceRow {
  /** `null` = ausência de ANTES da migration 548. */
  requestId: string | null;
  /** O titular da alocação (o "sai" da linha "Sin pedido (anterior)"). */
  titularWorkerId: string;
}

export interface RequestScopedLog extends RequestLogRow {
  requestId: string;
  /** Destino do `REMOVE`/`REPLACE` (o "Elegir quién entra" do permanente grava o mesmo no `REPLACE`). */
  destination?: 'RESERVE' | 'LEAVE_SERVICE' | null;
}

export interface WorkerNameSourceRow {
  workerId: string;
  firstNameEncrypted: string | null;
  lastNameEncrypted: string | null;
}

export interface ServiceRequestRows {
  country: string;
  headers: RequestHeaderRow[];
  absences: RequestScopedAbsence[];
  logRows: RequestScopedLog[];
  newAssignments: RequestNewAssignmentRow[];
  workerNames: WorkerNameSourceRow[];
}

export interface OutgoingCandidateRows {
  country: string;
  workers: WorkerNameSourceRow[];
}

const ISO_TS = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

interface NameJoinRow {
  id: string;
  first_name_encrypted: string | null;
  last_name_encrypted: string | null;
}

async function readCountry(client: PoolClient, patientId: string, serviceId: string): Promise<string | null> {
  const res = await client.query<{ country: string }>(
    `SELECT p.country
       FROM patient_contracted_services pcs
       JOIN patients p ON p.id = pcs.patient_id AND p.deleted_at IS NULL
      WHERE pcs.id = $1 AND pcs.patient_id = $2`,
    [serviceId, patientId],
  );
  return res.rows[0]?.country ?? null;
}

async function readNames(client: PoolClient, workerIds: Iterable<string>): Promise<WorkerNameSourceRow[]> {
  const ids = [...new Set(workerIds)];
  if (ids.length === 0) return [];
  const res = await client.query<NameJoinRow>(
    `SELECT id, first_name_encrypted, last_name_encrypted FROM workers WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const byId = new Map(res.rows.map((r) => [r.id, r]));
  return ids.map((workerId) => ({
    workerId,
    firstNameEncrypted: byId.get(workerId)?.first_name_encrypted ?? null,
    lastNameEncrypted: byId.get(workerId)?.last_name_encrypted ?? null,
  }));
}

interface HeaderJoinRow {
  id: string;
  outgoing_worker_id: string;
  reason_code: string;
  created_at: string;
  created_by: string;
  undone_at: string | null;
  undone_by: string | null;
}
interface AbsenceJoinRow {
  id: string;
  assignment_id: string;
  request_id: string | null;
  on_date: string;
  start_time: string;
  slot_end: string;
  substitute_worker_id: string | null;
  cancelled_at: string | null;
  status: ItineraryAssignmentStatus;
  valid_to: string | null;
  titular_worker_id: string;
}
interface LogJoinRow {
  request_id: string;
  kind: RequestLogRow['kind'];
  assignment_id: string | null;
  new_assignment_id: string | null;
  effective_date: string;
  destination: 'RESERVE' | 'LEAVE_SERVICE' | null;
}
interface NewAssignmentJoinRow {
  id: string;
  worker_id: string;
  status: ItineraryAssignmentStatus;
}

export class SubstitutionRequestReader {
  /** D4: `SELECT … FOR UPDATE` do cabeçalho (sem linha = nada travado; o `loadRequest` responde 404). */
  async lockHeader(client: PoolClient, serviceId: string, requestId: string): Promise<void> {
    await client.query(`SELECT id FROM patient_itinerary_substitution_request WHERE id = $1 AND contracted_service_id = $2 FOR UPDATE`, [requestId, serviceId]);
  }

  /** `null` = serviço inexistente, de outro paciente ou de outro país (RLS) — o caso de uso mapeia para 404. */
  async readForServiceWith(client: PoolClient, patientId: string, serviceId: string): Promise<ServiceRequestRows | null> {
    const country = await readCountry(client, patientId, serviceId);
    if (country === null) return null;

    const headersRes = await client.query<HeaderJoinRow>(
      `SELECT id, outgoing_worker_id, reason_code,
              to_char(created_at AT TIME ZONE 'UTC', ${ISO_TS}) AS created_at, created_by,
              to_char(undone_at AT TIME ZONE 'UTC', ${ISO_TS}) AS undone_at, undone_by
         FROM patient_itinerary_substitution_request
        WHERE contracted_service_id = $1
        ORDER BY created_at DESC, id`,
      [serviceId],
    );

    const absencesRes = await client.query<AbsenceJoinRow>(
      `SELECT ab.id, ab.assignment_id, ab.request_id, to_char(ab.on_date, 'YYYY-MM-DD') AS on_date,
              to_char(s.start_time, 'HH24:MI') AS start_time,
              to_char(s.start_time + make_interval(mins => s.duration_minutes), 'HH24:MI') AS slot_end,
              ab.substitute_worker_id,
              to_char(ab.cancelled_at AT TIME ZONE 'UTC', ${ISO_TS}) AS cancelled_at,
              a.status, to_char(a.valid_to, 'YYYY-MM-DD') AS valid_to, a.worker_id AS titular_worker_id
         FROM patient_itinerary_absence ab
         JOIN patient_itinerary_assignment a ON a.id = ab.assignment_id
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
        WHERE s.contracted_service_id = $1
        ORDER BY ab.on_date, s.start_time, ab.id`,
      [serviceId],
    );

    const logRes = await client.query<LogJoinRow>(
      `SELECT request_id, kind, assignment_id, new_assignment_id, to_char(effective_date, 'YYYY-MM-DD') AS effective_date, destination
         FROM patient_itinerary_change_log
        WHERE contracted_service_id = $1 AND request_id IS NOT NULL
        ORDER BY created_at, id`,
      [serviceId],
    );

    const newIds = [...new Set(logRes.rows.map((r) => r.new_assignment_id).filter((id): id is string => id !== null))];
    const newRes =
      newIds.length === 0
        ? { rows: [] as NewAssignmentJoinRow[] }
        : await client.query<NewAssignmentJoinRow>(`SELECT id, worker_id, status FROM patient_itinerary_assignment WHERE id = ANY($1::uuid[])`, [newIds]);

    const names = new Set<string>();
    for (const h of headersRes.rows) names.add(h.outgoing_worker_id);
    for (const a of absencesRes.rows) {
      names.add(a.titular_worker_id);
      if (a.substitute_worker_id) names.add(a.substitute_worker_id);
    }
    for (const n of newRes.rows) names.add(n.worker_id);

    return {
      country,
      headers: headersRes.rows.map((r) => ({
        id: r.id,
        outgoingWorkerId: r.outgoing_worker_id,
        reasonCode: r.reason_code,
        createdAt: r.created_at,
        createdBy: r.created_by,
        undoneAt: r.undone_at,
        undoneBy: r.undone_by,
      })),
      absences: absencesRes.rows.map((r) => ({
        absenceId: r.id,
        assignmentId: r.assignment_id,
        requestId: r.request_id,
        onDate: r.on_date,
        startTime: r.start_time,
        endTime: r.slot_end,
        substituteWorkerId: r.substitute_worker_id,
        cancelledAt: r.cancelled_at,
        assignmentStatus: r.status,
        assignmentValidTo: r.valid_to,
        titularWorkerId: r.titular_worker_id,
      })),
      logRows: logRes.rows.map((r) => ({
        requestId: r.request_id,
        kind: r.kind,
        assignmentId: r.assignment_id,
        newAssignmentId: r.new_assignment_id,
        effectiveDate: r.effective_date,
        destination: r.destination,
      })),
      newAssignments: newRes.rows.map((r) => ({ assignmentId: r.id, workerId: r.worker_id, status: r.status })),
      workerNames: await readNames(client, names),
    };
  }

  /** US3: pessoas com alocação `ACTIVE` vigente OU futura neste serviço (`valid_to` nulo ou `>= today`), uma linha por pessoa. */
  async readOutgoingCandidatesWith(client: PoolClient, patientId: string, serviceId: string, todayFor: (country: string) => string): Promise<OutgoingCandidateRows | null> {
    const country = await readCountry(client, patientId, serviceId);
    if (country === null) return null;
    const res = await client.query<{ worker_id: string }>(
      `SELECT DISTINCT a.worker_id
         FROM patient_itinerary_assignment a
         JOIN patient_itinerary_slot s ON s.id = a.slot_id
        WHERE s.contracted_service_id = $1 AND a.status = 'ACTIVE'
          AND (a.valid_to IS NULL OR a.valid_to >= $2::date)`,
      [serviceId, todayFor(country)],
    );
    return { country, workers: await readNames(client, res.rows.map((r) => r.worker_id)) };
  }
}
