// Erros de domínio do agendamento da admissão (movidos do service: ele estava no teto de linhas; re-exportados por ele).

/**
 * O horário pedido não pode mais ser reservado: ninguém livre depois do
 * re-check, corrida perdida na trava do banco, ou pedido dentro da janela de
 * antecedência mínima. Um código só porque, para o paciente, a saída é a mesma
 * nos três casos — escolher outro horário.
 */
export class SlotTakenError extends Error {
  readonly code = 'SLOT_TAKEN';
  constructor(message = 'Slot no longer available') {
    super(message);
    this.name = 'SlotTakenError';
  }
}

/** Patient not found, or not in the requested country. */
export class PatientNotFoundError extends Error {
  readonly code = 'PATIENT_NOT_FOUND';
  constructor(message = 'Patient not found') {
    super(message);
    this.name = 'PatientNotFoundError';
  }
}

/** Painel (spec 049 F3): o horário pedido já passou. */
export class SlotInPastError extends Error {
  readonly code = 'SLOT_IN_PAST';
  constructor(message = 'Slot is in the past') {
    super(message);
    this.name = 'SlotInPastError';
  }
}

/** Painel: o responsável escolhido não está no roster ativo do país do paciente. */
export class HostNotInRosterError extends Error {
  readonly code = 'HOST_NOT_IN_ROSTER';
  constructor(message = 'Host is not in the active roster of the patient country') {
    super(message);
    this.name = 'HostNotInRosterError';
  }
}

/** Painel: `slotStartISO` não é uma data/hora válida. */
export class InvalidSlotError extends Error {
  readonly code = 'INVALID_SLOT';
  constructor(message = 'Invalid slotStartISO') {
    super(message);
    this.name = 'InvalidSlotError';
  }
}
