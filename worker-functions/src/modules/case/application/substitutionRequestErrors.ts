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
