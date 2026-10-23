/**
 * Pedido de substituição (spec 069) — espelho do contrato das 6 rotas de
 * `worker-functions/.../adminSubstitutionRequestRoutes.ts`. Datas em `YYYY-MM-DD` (string, nunca
 * `Date`). Tipo, período, nº de turnos, "quem entra" e "Sin cubrir" chegam DERIVADOS: o front
 * apresenta, nunca recalcula (conflito de horário inclusive — a pré-visão chama a função do banco).
 */

import type { PatientItineraryEvent } from './PatientItinerary';

export type SubstitutionRequestType = 'ONE_DAY' | 'DAYS' | 'PERMANENT';
export type SubstitutionWhen = 'upcoming' | 'past';
export type EntraKind = 'NOBODY' | 'PERSON' | 'PARTIAL' | 'MULTIPLE';

export interface SubstitutionRequestEntra {
  kind: EntraKind;
  /** Quem entra, sem repetição, na ordem do primeiro turno. */
  workerIds: string[];
  /** Datas em que ALGUM turno do pedido segue sem ninguém ("salvo <día>: nadie"). */
  uncoveredDates: string[];
}

export interface SubstitutionRequestShift {
  date: string;
  startTime: string | null;
  endTime: string | null;
  assignmentId: string | null;
  /** Quem entra neste turno; `null` = "Nadie todavía". */
  workerId: string | null;
}

/** Uma linha de `GET .../substitution-requests` — `legacy` = ausência anterior ao pedido ("Sin pedido (anterior)"). */
export interface SubstitutionRequestItem {
  requestId: string | null;
  legacy: boolean;
  type: SubstitutionRequestType;
  from: string;
  /** `null` no permanente (sem fim). */
  to: string | null;
  shiftCount: number;
  outgoingWorkerId: string;
  reasonCode: string | null;
  entra: SubstitutionRequestEntra;
  shifts: SubstitutionRequestShift[];
  createdAt: string | null;
  createdBy: string | null;
  undoneAt: string | null;
  undoneBy: string | null;
  undoable: boolean;
  adjusted: boolean;
  when: SubstitutionWhen;
  outgoingDisplayName: string | null;
  /** Nome de quem entra, na ordem de `entra.workerIds`. */
  entraDisplayNames: Array<string | null>;
  /** Nome por turno (mesma ordem de `shifts`). */
  shiftDisplayNames: Array<string | null>;
}

export interface SubstitutionRequestsResult {
  patientId: string;
  serviceId: string;
  when: SubstitutionWhen;
  requests: SubstitutionRequestItem[];
}

/** "¿Quién no va a venir?" — uma linha por PESSOA. */
export interface OutgoingCandidate {
  workerId: string;
  displayName: string | null;
}

export interface PreviewShift {
  date: string;
  slotId: string;
  assignmentId: string;
  startTime: string;
  endTime: string;
}

/** Tri-estado da pré-visão: `unknown` = a chamada falhou e NUNCA vale como `free`. */
export type ConflictState = 'free' | 'conflict' | 'unknown';

export interface ConflictOverlap {
  weekday: number;
  startTime: string;
  durationMinutes: number;
  sameAddress: boolean;
}

export interface PreviewConflict {
  workerId: string;
  date: string;
  slotId: string;
  state: ConflictState;
  overlaps: ConflictOverlap[];
}

export interface StatusAfter {
  current: string | null;
  after: string | null;
  /** O pedido muda o estado do paciente? */
  changes: boolean;
}

export interface PermanentPreview {
  allocationCount: number;
  cancelledAbsences: number;
  clearedSubstitutes: number;
  pendingEntry: boolean;
}

export interface SubstitutionPreview {
  shifts: PreviewShift[];
  conflicts: PreviewConflict[];
  statusAfter: StatusAfter | null;
  permanent?: PermanentPreview;
}

export interface SubstitutionPeriodDays {
  type: 'ONE_DAY' | 'DAYS';
  outgoingWorkerId: string;
  from: string;
  to?: string;
}

export interface SubstitutionPeriodPermanent {
  type: 'PERMANENT';
  outgoingWorkerId: string;
  from: string;
}

export type SubstitutionPeriod = SubstitutionPeriodDays | SubstitutionPeriodPermanent;
export type SubstitutionPreviewBody = SubstitutionPeriod & { candidateWorkerIds: string[] };

/** Cada turno leva o substituto OBRIGATÓRIO e nullable no fio: `null` = "Nadie todavía" (chave ausente = 400). */
export interface SubstitutionShiftInput {
  date: string;
  slotId: string;
  substituteWorkerId: string | null;
}

export type CreateSubstitutionBody =
  | (SubstitutionPeriodDays & { reasonCategory: string; shifts: SubstitutionShiftInput[] })
  | (SubstitutionPeriodPermanent & {
      reasonCategory: string;
      destination?: 'RESERVE' | 'LEAVE_SERVICE';
      substituteWorkerId: string | null;
    });

export interface CreateSubstitutionResult {
  requestId: string;
  type: SubstitutionRequestType;
  from: string;
  to: string | null;
  shiftCount: number;
}

export interface UndoSubstitutionResult {
  requestId: string;
  type: SubstitutionRequestType;
  cancelledAbsences: number;
  cancelledEntries: number;
  restoredTitulars: number;
}

export interface CoverSubstitutionResult {
  requestId: string;
  type: SubstitutionRequestType;
  covered: number;
}

/**
 * O que abriu o fluxo "Nueva sustitución" (a F6 monta o fluxo): o botão do cabeçalho (`new`), o
 * "Cambiar" de um turno (`change`: pessoa e dia do turno pré-preenchidos) ou o "Asignar" de um
 * turno "Sin cubrir" (`assign`: a escolha de quem entra).
 */
export type SubstitutionFlowIntent =
  | { kind: 'new' }
  | { kind: 'change'; event: PatientItineraryEvent }
  | { kind: 'assign'; event: PatientItineraryEvent };
