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
