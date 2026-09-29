/**
 * itineraryEvents — expansão pura de faixa × datas para a coluna "Próximos eventos/Substituição"
 * (D445.3/D445.4). SEM materializar ocorrências, SEM tabela nova: dado um intervalo `[from, to]` e
 * as linhas de alocação/ausência já lidas do banco, gera um evento por (slot, data) em que HÁ
 * alocação vigente naquela data — a mesma noção de vigência de `isVigente`
 * (`ServiceCoverageCalculator.ts`), reimplementada aqui só sobre string `YYYY-MM-DD` (nunca
 * `Date`/fuso do processo — os dois lados da conta, `date` e `validFrom/validTo`, já chegam como
 * string do leitor).
 *
 * Ausência aberta (não cancelada) na mesma (assignmentId, data) sobrepõe o evento: com substituto →
 * `substituted` (quem cobre é o substituto); sem substituto → `uncovered` (ninguém cobre — o mesmo
 * alerta do Kanban, `itineraryAlerts.ts`, agora no grão de evento).
 */

export type ItineraryEventStatus = 'covered' | 'substituted' | 'uncovered';

export interface ItineraryEventAssignmentRow {
  assignmentId: string;
  slotId: string;
  serviceId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  workerId: string;
  validFrom: string;
  validTo: string | null;
  status: 'ACTIVE' | 'ENDED' | 'CANCELLED';
}

export interface ItineraryEventAbsenceRow {
  absenceId: string;
  assignmentId: string;
  onDate: string;
  substituteWorkerId: string | null;
}

export interface ItineraryEvent {
  date: string;
  weekday: number;
  serviceId: string;
  slotId: string;
  assignmentId: string;
  startTime: string;
  endTime: string;
  titularWorkerId: string;
  status: ItineraryEventStatus;
  /** Quem cobre de fato nesta data: o titular (`covered`), o substituto (`substituted`) ou `null` (`uncovered`). */
  workerId: string | null;
  substituteWorkerId: string | null;
  absenceId: string | null;
}

export interface ExpandItineraryEventsFilters {
  serviceId?: string;
  workerId?: string;
}

/** `YYYY-MM-DD` → dia da semana (0 = domingo … 6 = sábado), sempre por `Date.UTC` — nunca fuso local do processo. */
export function weekdayOfDateString(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `YYYY-MM-DD` + N dias (N pode ser negativo), sempre por `Date.UTC`. */
export function addDaysToDateString(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + days));
  const y = next.getUTCFullYear();
  const m = String(next.getUTCMonth() + 1).padStart(2, '0');
  const d = String(next.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Quantidade de dias no intervalo `[from, to]`, inclusive dos dois extremos (1 dia = mesma data). */
export function dayCountInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const fromMs = Date.UTC(fy, fm - 1, fd);
  const toMs = Date.UTC(ty, tm - 1, td);
  return Math.round((toMs - fromMs) / 86_400_000) + 1;
}

function isAssignmentVigenteAt(row: ItineraryEventAssignmentRow, date: string): boolean {
  return row.status === 'ACTIVE' && row.validFrom <= date && (row.validTo === null || row.validTo >= date);
}

export function expandItineraryEvents(
  assignments: ItineraryEventAssignmentRow[],
  absences: ItineraryEventAbsenceRow[],
  from: string,
  to: string,
  filters: ExpandItineraryEventsFilters = {},
): ItineraryEvent[] {
  const absenceByKey = new Map<string, ItineraryEventAbsenceRow>();
  for (const absence of absences) absenceByKey.set(`${absence.assignmentId}|${absence.onDate}`, absence);

  const events: ItineraryEvent[] = [];
  const dayCount = dayCountInclusive(from, to);
  for (let i = 0; i < dayCount; i++) {
    const date = addDaysToDateString(from, i);
    const weekday = weekdayOfDateString(date);
    for (const assignment of assignments) {
      if (assignment.weekday !== weekday) continue;
      if (!isAssignmentVigenteAt(assignment, date)) continue;

      const absence = absenceByKey.get(`${assignment.assignmentId}|${date}`);
      let status: ItineraryEventStatus = 'covered';
      let workerId: string | null = assignment.workerId;
      let substituteWorkerId: string | null = null;
      let absenceId: string | null = null;
      if (absence) {
        absenceId = absence.absenceId;
        substituteWorkerId = absence.substituteWorkerId;
        if (absence.substituteWorkerId) {
          status = 'substituted';
          workerId = absence.substituteWorkerId;
        } else {
          status = 'uncovered';
          workerId = null;
        }
      }

      if (filters.serviceId && assignment.serviceId !== filters.serviceId) continue;
      if (filters.workerId && workerId !== filters.workerId && assignment.workerId !== filters.workerId) continue;

      events.push({
        date,
        weekday,
        serviceId: assignment.serviceId,
        slotId: assignment.slotId,
        assignmentId: assignment.assignmentId,
        startTime: assignment.startTime,
        endTime: assignment.endTime,
        titularWorkerId: assignment.workerId,
        status,
        workerId,
        substituteWorkerId,
        absenceId,
      });
    }
  }

  events.sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)));
  return events;
}
