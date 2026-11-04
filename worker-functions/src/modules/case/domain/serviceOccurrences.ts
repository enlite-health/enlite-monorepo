/**
 * serviceOccurrences — spec 069, FR-12/FR-13: as OCORRÊNCIAS do serviço (uma por faixa × data × alocação) lidas das
 * FAIXAS vigentes na data, nunca só das alocações. É a ÚNICA fonte de "Sin cubrir": a agenda ("Próximos días"), o cartão
 * do serviço, o Kanban e o alerta diário leem esta mesma lista (`itineraryAlerts.ts` só filtra e conta).
 *
 *  - faixa vigente na data (`slot.valid` contém a data, comparação de string `YYYY-MM-DD`, nunca `CURRENT_DATE`/`Date`);
 *  - uma linha por alocação vigente (`isVigente`, IMPORTADO de `ServiceCoverageCalculator.ts` — sem 2ª cópia): `covered`, ou
 *    `substituted`/`uncovered` se a ausência viva da (alocação, data) tem/não tem substituto;
 *  - faixa SEM alocação vigente na data = UMA linha `uncovered` com `assignmentId`/`titularWorkerId`/`absenceId` nulos;
 *  - turno noturno (20:00 + 720 min) pertence à data de INÍCIO: o dia da semana comparado é o da faixa.
 *
 * Função pura: nada de `Date` local/`Intl` aqui — as funções de data (`itineraryEvents.ts`) usam `Date.UTC`.
 */
import { isVigente, type ItineraryAssignmentStatus } from './ServiceCoverageCalculator';
import { addDaysToDateString, dayCountInclusive, weekdayOfDateString } from './itineraryEvents';

/** O horizonte do aviso "N turnos sin cubrir en los próximos 7 días": UMA constante, lida pelo cartão, pelo Kanban e pelo alerta. */
export const UNCOVERED_HORIZON_DAYS = 7;

export interface UncoveredWindow {
  from: string;
  to: string;
}

/** `[hoje, hoje + 6]` (hoje incluso, P8/P15): turno em `hoje + 7` não entra; "hoje" entra inteiro, sem olhar a hora. */
export function uncoveredWindow(asOf: string): UncoveredWindow {
  return { from: asOf, to: addDaysToDateString(asOf, UNCOVERED_HORIZON_DAYS - 1) };
}

export type OccurrenceStatus = 'covered' | 'substituted' | 'uncovered';

export interface OccurrenceSlot {
  slotId: string;
  serviceId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  /** Início da vigência da faixa (inclusivo). */
  validFrom: string;
  /** Último dia vigente da faixa, INCLUSIVO (o fio de `dateRangeWire.ts`); `null` = aberta. */
  validTo: string | null;
}

export interface OccurrenceAssignment {
  assignmentId: string;
  slotId: string;
  workerId: string;
  validFrom: string;
  validTo: string | null;
  status: ItineraryAssignmentStatus;
}

/** Ausência VIVA (não cancelada, sobre alocação ACTIVE vigente na data): o leitor já aplicou `liveAbsencePredicate`. */
export interface OccurrenceAbsence {
  absenceId: string;
  assignmentId: string;
  onDate: string;
  substituteWorkerId: string | null;
  requestId: string | null;
}

export interface ServiceOccurrence {
  date: string;
  weekday: number;
  serviceId: string;
  slotId: string;
  assignmentId: string | null;
  startTime: string;
  endTime: string;
  titularWorkerId: string | null;
  status: OccurrenceStatus;
  /** Quem atende de fato: o titular (`covered`), o substituto (`substituted`) ou `null` (`uncovered`). */
  workerId: string | null;
  substituteWorkerId: string | null;
  absenceId: string | null;
  requestId: string | null;
}

export interface ExpandOccurrenceFilters {
  serviceId?: string;
  workerId?: string;
}

/** A faixa vale na data? `validFrom` e `validTo` inclusivos (o fio de `dateRangeWire.ts`; a conversão do `daterange` mora só lá). */
export function slotValidOn(slot: OccurrenceSlot, date: string): boolean {
  return slot.validFrom <= date && (slot.validTo === null || date <= slot.validTo);
}

export function expandServiceOccurrences(
  slots: readonly OccurrenceSlot[],
  assignments: readonly OccurrenceAssignment[],
  absences: readonly OccurrenceAbsence[],
  from: string,
  to: string,
  filters: ExpandOccurrenceFilters = {},
): ServiceOccurrence[] {
  const assignmentsBySlot = new Map<string, OccurrenceAssignment[]>();
  for (const assignment of assignments) {
    const list = assignmentsBySlot.get(assignment.slotId);
    if (list) list.push(assignment);
    else assignmentsBySlot.set(assignment.slotId, [assignment]);
  }
  const absenceByKey = new Map<string, OccurrenceAbsence>();
  for (const absence of absences) absenceByKey.set(`${absence.assignmentId}|${absence.onDate}`, absence);

  const occurrences: ServiceOccurrence[] = [];
  const dayCount = dayCountInclusive(from, to);
  for (let i = 0; i < dayCount; i++) {
    const date = addDaysToDateString(from, i);
    const weekday = weekdayOfDateString(date);
    for (const slot of slots) {
      if (slot.weekday !== weekday || !slotValidOn(slot, date)) continue;
      if (filters.serviceId && slot.serviceId !== filters.serviceId) continue;

      const vigentes = (assignmentsBySlot.get(slot.slotId) ?? []).filter((a) => isVigente(a, date));
      if (vigentes.length === 0) {
        if (filters.workerId) continue;
        occurrences.push(occurrenceOf(slot, date, weekday, null, null));
        continue;
      }
      for (const assignment of vigentes) {
        const occurrence = occurrenceOf(slot, date, weekday, assignment, absenceByKey.get(`${assignment.assignmentId}|${date}`) ?? null);
        if (filters.workerId && occurrence.workerId !== filters.workerId && assignment.workerId !== filters.workerId) continue;
        occurrences.push(occurrence);
      }
    }
  }

  occurrences.sort((a, b) => (a.date === b.date ? a.startTime.localeCompare(b.startTime) : a.date.localeCompare(b.date)));
  return occurrences;
}

function occurrenceOf(
  slot: OccurrenceSlot,
  date: string,
  weekday: number,
  assignment: OccurrenceAssignment | null,
  absence: OccurrenceAbsence | null,
): ServiceOccurrence {
  const base = {
    date,
    weekday,
    serviceId: slot.serviceId,
    slotId: slot.slotId,
    assignmentId: assignment?.assignmentId ?? null,
    startTime: slot.startTime,
    endTime: slot.endTime,
    titularWorkerId: assignment?.workerId ?? null,
  };
  if (assignment === null) {
    return { ...base, status: 'uncovered', workerId: null, substituteWorkerId: null, absenceId: null, requestId: null };
  }
  if (absence === null) {
    return { ...base, status: 'covered', workerId: assignment.workerId, substituteWorkerId: null, absenceId: null, requestId: null };
  }
  const substituted = absence.substituteWorkerId !== null;
  return {
    ...base,
    status: substituted ? 'substituted' : 'uncovered',
    workerId: absence.substituteWorkerId,
    substituteWorkerId: absence.substituteWorkerId,
    absenceId: absence.absenceId,
    requestId: absence.requestId,
  };
}
