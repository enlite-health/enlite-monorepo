/** Reunião não existe (ou não é deste paciente, ou o paciente é de outro país — a RLS esconde). */
export class AppointmentNotFoundError extends Error {
  readonly code = 'APPOINTMENT_NOT_FOUND';
  constructor() {
    super('Admission appointment not found');
    this.name = 'AppointmentNotFoundError';
  }
}

/** Só reunião `booked` cancela. */
export class AppointmentNotCancellableError extends Error {
  readonly code = 'APPOINTMENT_NOT_CANCELLABLE';
  constructor(public readonly status: string) {
    super(`Admission appointment in status "${status}" cannot be cancelled`);
    this.name = 'AppointmentNotCancellableError';
  }
}

/** O reenvio perdeu o claim da tentativa: outro clique já está mandando (ou mandou) a mesma tentativa. */
export class ResendInProgressError extends Error {
  readonly code = 'RESEND_IN_PROGRESS';
  constructor() {
    super('Another resend of this message is already in progress');
    this.name = 'ResendInProgressError';
  }
}

/** Ensaio pago só existe para reunião `booked` de paciente `is_test` (spec 050 R-19). `reason` é um enum fechado. */
export class PaidRehearsalNotAllowedError extends Error {
  readonly code = 'PAID_REHEARSAL_NOT_ALLOWED';
  constructor(public readonly reason: 'patient_not_test' | 'appointment_not_booked') {
    super(`Paid rehearsal not allowed: ${reason}`);
    this.name = 'PaidRehearsalNotAllowedError';
  }
}

/** A reunião já tem liberação VIGENTE: liberar de novo não estende o prazo (R-19). */
export class PaidRehearsalAlreadyActiveError extends Error {
  readonly code = 'PAID_REHEARSAL_ALREADY_ACTIVE';
  constructor() {
    super('A paid rehearsal release is already active for this appointment');
    this.name = 'PaidRehearsalAlreadyActiveError';
  }
}

/** Reprocesso do resumo recusado (spec 050 R-38): reunião encerrada/terminal ou já concluída. `reason` é um enum fechado. */
export class SummaryRetryNotAllowedError extends Error {
  readonly code = 'SUMMARY_RETRY_NOT_ALLOWED';
  constructor(public readonly reason: 'appointment_not_booked' | 'already_done' | 'import_terminal') {
    super(`Summary retry not allowed: ${reason}`);
    this.name = 'SummaryRetryNotAllowedError';
  }
}

/** A reunião já gastou as autorizações de reprocesso do resumo (R-38): 409, sem nova rodada paga. */
export class SummaryRetryLimitReachedError extends Error {
  readonly code = 'SUMMARY_RETRY_LIMIT_REACHED';
  constructor() {
    super('The summary retry authorization limit for this appointment was reached');
    this.name = 'SummaryRetryLimitReachedError';
  }
}
