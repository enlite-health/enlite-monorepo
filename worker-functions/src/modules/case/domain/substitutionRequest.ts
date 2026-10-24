/**
 * substitutionRequest — spec 069: o que o PEDIDO de substituição é, DERIVADO (nada disto é coluna). O cabeçalho só guarda
 * quem sai, o motivo e quando foi desfeito; tipo, período, nº de turnos, quem entra, "salvo <día>: nadie", "Ajustado",
 * Próximas × Pasadas e `undoable` saem daqui, lidos das ausências e do registro de trocas (checklist `modelar-dado`, D516).
 *
 *  - `shiftsOfWorkerInPeriod`: os turnos da pessoa no período (FR-10, US4) — o que a pré-visão mostra e o create grava.
 *  - `describeRequest`: a linha da aba "Sustituciones". "Entra" tem UMA fonte (P17): o substituto VIVO da ausência, ou a
 *    alocação nova ligada pelo `REPLACE` do pedido — nunca `change_log.incoming_worker_id` (congelado na criação).
 *
 * Função pura: datas são string `YYYY-MM-DD`; nada de `Date`/`Intl`.
 */
import { isVigente, type ItineraryAssignmentStatus } from './ServiceCoverageCalculator';
import { addDaysToDateString, dayCountInclusive, weekdayOfDateString } from './itineraryEvents';
import { slotValidOn, type OccurrenceAssignment, type OccurrenceSlot } from './serviceOccurrences';

export type SubstitutionRequestType = 'ONE_DAY' | 'DAYS' | 'PERMANENT';

export interface WorkerShift {
  date: string;
  slotId: string;
  assignmentId: string;
  startTime: string;
  endTime: string;
}

/** As datas de `[from, to]` (inclusive), em ordem. */
export function datesBetween(from: string, to: string): string[] {
  const count = dayCountInclusive(from, to);
  return count < 1 ? [] : Array.from({ length: count }, (_, i) => addDaysToDateString(from, i));
}

/** Os turnos que a pessoa tem nas `dates`: faixa vigente na data × alocação vigente DELA (`isVigente`). Ordem: data, início. */
export function shiftsOfWorkerInPeriod(
  slots: readonly OccurrenceSlot[],
  assignments: readonly OccurrenceAssignment[],
  workerId: string,
  dates: readonly string[],
): WorkerShift[] {
  const own = assignments.filter((a) => a.workerId === workerId);
  const shifts: WorkerShift[] = [];
  for (const date of dates) {
    const weekday = weekdayOfDateString(date);
    for (const slot of slots) {
      if (slot.weekday !== weekday || !slotValidOn(slot, date)) continue;
      for (const assignment of own) {
        if (assignment.slotId !== slot.slotId || !isVigente(assignment, date)) continue;
        shifts.push({ date, slotId: slot.slotId, assignmentId: assignment.assignmentId, startTime: slot.startTime, endTime: slot.endTime });
      }
    }
  }
  return shifts.sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)));
}

// ── descrição do pedido ───────────────────────────────────────────────────────────────────────

export interface RequestHeaderRow {
  id: string;
  outgoingWorkerId: string;
  reasonCode: string;
  createdAt: string;
  createdBy: string;
  undoneAt: string | null;
  undoneBy: string | null;
}

export interface RequestAbsenceRow {
  absenceId: string;
  assignmentId: string;
  onDate: string;
  startTime: string;
  endTime: string;
  substituteWorkerId: string | null;
  cancelledAt: string | null;
  assignmentStatus: ItineraryAssignmentStatus;
  assignmentValidTo: string | null;
}

export interface RequestLogRow {
  kind: 'ABSENCE' | 'REPLACE' | 'REMOVE' | 'SUBSTITUTE_CANCELLED';
  assignmentId: string | null;
  newAssignmentId: string | null;
  effectiveDate: string;
}

/** A alocação nova ligada por um `REPLACE` (P17): quem entra é o titular DELA, enquanto ela vive. */
export interface RequestNewAssignmentRow {
  assignmentId: string;
  workerId: string;
  status: ItineraryAssignmentStatus;
}

export type EntraKind = 'NOBODY' | 'PERSON' | 'PARTIAL' | 'MULTIPLE';

export interface RequestEntra {
  kind: EntraKind;
  /** Quem entra, sem repetição, na ordem do primeiro turno. */
  workerIds: string[];
  /** Datas em que ALGUM turno do pedido segue sem ninguém ("salvo <día>: nadie"). */
  uncoveredDates: string[];
}

export interface RequestShiftView {
  date: string;
  startTime: string | null;
  endTime: string | null;
  assignmentId: string | null;
  /** Quem entra neste turno; `null` = "Nadie todavía". */
  workerId: string | null;
}

export interface RequestView {
  /** `null` = ausência de ANTES da migration 548 ("Sin pedido (anterior)"). */
  requestId: string | null;
  legacy: boolean;
  type: SubstitutionRequestType;
  from: string;
  /** `null` no permanente (sem fim). */
  to: string | null;
  shiftCount: number;
  outgoingWorkerId: string;
  reasonCode: string | null;
  entra: RequestEntra;
  shifts: RequestShiftView[];
  createdAt: string | null;
  createdBy: string | null;
  undoneAt: string | null;
  undoneBy: string | null;
  undoable: boolean;
  adjusted: boolean;
  when: 'upcoming' | 'past';
}

function entraOf(shifts: readonly RequestShiftView[]): RequestEntra {
  const workerIds: string[] = [];
  const uncovered = new Set<string>();
  for (const s of shifts) {
    if (s.workerId === null) uncovered.add(s.date);
    else if (!workerIds.includes(s.workerId)) workerIds.push(s.workerId);
  }
  const uncoveredDates = [...uncovered].sort();
  let kind: EntraKind;
  if (workerIds.length === 0) kind = 'NOBODY';
  else if (uncoveredDates.length > 0) kind = 'PARTIAL';
  else kind = workerIds.length > 1 ? 'MULTIPLE' : 'PERSON';
  return { kind, workerIds, uncoveredDates };
}

function absenceShift(a: RequestAbsenceRow): RequestShiftView {
  return { date: a.onDate, startTime: a.startTime, endTime: a.endTime, assignmentId: a.assignmentId, workerId: a.substituteWorkerId };
}

function isStuck(a: RequestAbsenceRow): boolean {
  return a.assignmentStatus !== 'ACTIVE' || (a.assignmentValidTo !== null && a.assignmentValidTo < a.onDate);
}

function describePermanent(
  header: RequestHeaderRow,
  logRows: readonly RequestLogRow[],
  newAssignments: readonly RequestNewAssignmentRow[],
  hoje: string,
): RequestView {
  const exits = logRows.filter((r) => (r.kind === 'REPLACE' || r.kind === 'REMOVE') && r.assignmentId !== null);
  const newById = new Map(newAssignments.map((n) => [n.assignmentId, n]));
  const byTitular = new Map<string, { since: string; entering: string | null }>();
  for (const row of exits) {
    const since = row.kind === 'REMOVE' ? addDaysToDateString(row.effectiveDate, 1) : row.effectiveDate;
    const incoming = row.kind === 'REPLACE' && row.newAssignmentId ? newById.get(row.newAssignmentId) : undefined;
    const entering = incoming && incoming.status !== 'CANCELLED' ? incoming.workerId : null;
    const key = row.assignmentId as string;
    const current = byTitular.get(key);
    byTitular.set(key, { since: current && current.since < since ? current.since : since, entering: entering ?? current?.entering ?? null });
  }
  const since = [...byTitular.values()].map((v) => v.since).sort()[0];
  const shifts: RequestShiftView[] = [...byTitular.entries()].map(([assignmentId, v]) => ({
    date: v.since,
    startTime: null,
    endTime: null,
    assignmentId,
    workerId: v.entering,
  }));
  const undone = header.undoneAt !== null;
  return {
    requestId: header.id,
    legacy: false,
    type: 'PERMANENT',
    from: since,
    to: null,
    shiftCount: byTitular.size,
    outgoingWorkerId: header.outgoingWorkerId,
    reasonCode: header.reasonCode,
    entra: entraOf(shifts),
    shifts,
    createdAt: header.createdAt,
    createdBy: header.createdBy,
    undoneAt: header.undoneAt,
    undoneBy: header.undoneBy,
    undoable: !undone && since > hoje,
    adjusted: false,
    when: since >= hoje ? 'upcoming' : 'past',
  };
}

export function describeRequest(
  header: RequestHeaderRow,
  absences: readonly RequestAbsenceRow[],
  logRows: readonly RequestLogRow[],
  hoje: string,
  newAssignments: readonly RequestNewAssignmentRow[] = [],
): RequestView {
  if (logRows.some((r) => r.kind === 'REPLACE' || r.kind === 'REMOVE')) return describePermanent(header, logRows, newAssignments, hoje);

  const undone = header.undoneAt !== null;
  const live = absences.filter((a) => a.cancelledAt === null);
  const counted = undone || live.length === 0 ? absences : live;
  const sorted = [...counted].sort((a, b) => (a.onDate === b.onDate ? a.startTime.localeCompare(b.startTime) : a.onDate.localeCompare(b.onDate)));
  const shifts = sorted.map(absenceShift);
  const dates = [...new Set(sorted.map((a) => a.onDate))];
  return {
    requestId: header.id,
    legacy: false,
    type: dates.length > 1 ? 'DAYS' : 'ONE_DAY',
    from: dates[0] ?? '',
    to: dates.length > 1 ? dates[dates.length - 1] : null,
    shiftCount: shifts.length,
    outgoingWorkerId: header.outgoingWorkerId,
    reasonCode: header.reasonCode,
    entra: entraOf(shifts),
    shifts,
    createdAt: header.createdAt,
    createdBy: header.createdBy,
    undoneAt: header.undoneAt,
    undoneBy: header.undoneBy,
    undoable: !undone && live.some((a) => a.onDate >= hoje),
    adjusted: !undone && (absences.some((a) => a.cancelledAt !== null) || live.some(isStuck)),
    when: sorted.some((a) => a.onDate >= hoje) ? 'upcoming' : 'past',
  };
}

/** Ausência de ANTES da 548 (`request_id NULL`): uma linha "Sin pedido (anterior)", sem motivo e sem "Deshacer" (P2). */
export function describeLegacyAbsence(absence: RequestAbsenceRow, outgoingWorkerId: string, hoje: string): RequestView {
  const shift = absenceShift(absence);
  return {
    requestId: null,
    legacy: true,
    type: 'ONE_DAY',
    from: absence.onDate,
    to: null,
    shiftCount: 1,
    outgoingWorkerId,
    reasonCode: null,
    entra: entraOf([shift]),
    shifts: [shift],
    createdAt: null,
    createdBy: null,
    undoneAt: null,
    undoneBy: null,
    undoable: false,
    adjusted: false,
    when: absence.onDate >= hoje ? 'upcoming' : 'past',
  };
}
