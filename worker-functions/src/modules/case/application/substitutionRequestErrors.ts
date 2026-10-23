/**
 * Erros de domínio do pedido de substituição (spec 069). O controller (`AdminSubstitutionRequestController`) os mapeia para
 * HTTP; os já existentes (`ServiceExitReason*Error`, `AbsenceAlreadyExistsError`, `ItineraryOverlapError`, `AbsenceDateInPastError`)
 * são REUSADOS, não redeclarados.
 */

/** O serviço não existe, é de outro paciente ou de outro país (RLS) — 404. */
export class SubstitutionServiceNotFoundError extends Error {
  constructor(
    readonly patientId: string,
    readonly serviceId: string,
  ) {
    super(`Service not found for substitution request: ${serviceId} (patientId=${patientId})`);
    this.name = 'SubstitutionServiceNotFoundError';
  }
}

/** O período começa antes de hoje (data de operação do país) — 422 `ABSENCE_DATE_IN_PAST` (mesmo código da ausência avulsa). */
export class SubstitutionPeriodInPastError extends Error {
  constructor(readonly from: string) {
    super(`Substitution period starts in the past: ${from}`);
    this.name = 'SubstitutionPeriodInPastError';
  }
}

/** A pessoa não tem nenhum turno no período (US4) — 422 `SUBSTITUTION_NO_SHIFTS_IN_PERIOD`. */
export class SubstitutionNoShiftsInPeriodError extends Error {
  constructor(
    readonly outgoingWorkerId: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(`Worker has no shifts in the period ${from}..${to}`);
    this.name = 'SubstitutionNoShiftsInPeriodError';
  }
}

/** Os turnos do corpo não são exatamente os turnos da pessoa no período (a tela ficou velha) — 422 `SUBSTITUTION_SHIFTS_MISMATCH`. */
export class SubstitutionShiftsMismatchError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(`Substitution shifts do not match the worker's shifts in the period (expected ${expected}, received ${received})`);
    this.name = 'SubstitutionShiftsMismatchError';
  }
}

/** O pedido não existe, é de outro serviço/paciente ou de outro país (RLS) — 404. */
export class SubstitutionRequestNotFoundError extends Error {
  constructor(readonly requestId: string) {
    super(`Substitution request not found: ${requestId}`);
    this.name = 'SubstitutionRequestNotFoundError';
  }
}

/** O pedido já foi desfeito (`undone_at`) — 409 `REQUEST_ALREADY_UNDONE`. */
export class SubstitutionRequestAlreadyUndoneError extends Error {
  constructor(readonly requestId: string) {
    super(`Substitution request already undone: ${requestId}`);
    this.name = 'SubstitutionRequestAlreadyUndoneError';
  }
}

/** Nada futuro a desfazer (pedido todo passado, FR-22; permanente a partir de hoje, FR-33) — 409 `REQUEST_NOT_UNDOABLE`. */
export class SubstitutionRequestNotUndoableError extends Error {
  constructor(readonly requestId: string) {
    super(`Substitution request is not undoable: ${requestId}`);
    this.name = 'SubstitutionRequestNotUndoableError';
  }
}

/** P5: a pessoa tem entrada FUTURA no serviço (reemplazo agendado) — "No vuelve más" é recusado; desfaça o pedido que a trouxe. 409 `WORKER_HAS_PENDING_ENTRY`. */
export class WorkerHasPendingEntryError extends Error {
  constructor(readonly workerId: string) {
    super('Worker has a pending (future) entry in this service');
    this.name = 'WorkerHasPendingEntryError';
  }
}

/**
 * D1 (QA caça 069): a pessoa já tem uma SAÍDA AGENDADA (`valid_to` numa alocação ativa do serviço) — "No vuelve más" é recusado, porque
 * `scheduleAllocationEnd` sobrescreveria o fim e desfazer o 2º pedido o apagaria (`clearScheduledEnd`). `exitDate` = o 1º dia SEM ela
 * (`valid_to + 1`). Desfaça a substituição que agendou a saída para mudar a data. 409 `WORKER_HAS_SCHEDULED_EXIT`.
 */
export class WorkerHasScheduledExitError extends Error {
  constructor(
    readonly workerId: string,
    readonly exitDate: string,
  ) {
    super('Worker already has a scheduled exit in this service');
    this.name = 'WorkerHasScheduledExitError';
  }
}

/** "Elegir quién entra" num pedido sem nenhum turno futuro sem ninguém — 409 `NOTHING_TO_COVER`. */
export class SubstitutionNothingToCoverError extends Error {
  constructor(readonly requestId: string) {
    super(`Substitution request has nothing left to cover: ${requestId}`);
    this.name = 'SubstitutionNothingToCoverError';
  }
}
