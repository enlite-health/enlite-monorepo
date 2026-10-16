// Erros de domínio do evento de enquadre (spec 052). Cada um carrega o `code` estável que a tela traduz; a tela NUNCA ecoa a mensagem.

/** A vaga não existe (ou não é de um país atendido). */
export class EnquadreVacancyNotFoundError extends Error {
  readonly code = 'VACANCY_NOT_FOUND';
  constructor() {
    super('Vacancy not found');
    this.name = 'EnquadreVacancyNotFoundError';
  }
}

/** O evento não existe ou não é desta vaga. */
export class EnquadreEventNotFoundError extends Error {
  readonly code = 'ENQUADRE_EVENT_NOT_FOUND';
  constructor() {
    super('Enquadre event not found');
    this.name = 'EnquadreEventNotFoundError';
  }
}

/** Algum escolhido não está em Completado ou já está num evento aberto desta vaga (a trava do banco também cai aqui). */
export class EnquadreWorkerNotAvailableError extends Error {
  readonly code = 'ENQUADRE_WORKER_NOT_AVAILABLE';
  constructor() {
    super('A chosen worker is not available for a new enquadre event');
    this.name = 'EnquadreWorkerNotAvailableError';
  }
}

/** Algum escolhido não tem e-mail válido: sem ele o Google não convida. Só a QUANTIDADE vai na mensagem. */
export class EnquadreWorkerEmailInvalidError extends Error {
  readonly code = 'ENQUADRE_WORKER_EMAIL_INVALID';
  constructor(readonly invalidCount: number) {
    super(`${invalidCount} chosen worker(s) without a valid e-mail`);
    this.name = 'EnquadreWorkerEmailInvalidError';
  }
}

/** A participação não existe neste evento (ou já saiu dele). */
export class EnquadreParticipantNotFoundError extends Error {
  readonly code = 'ENQUADRE_PARTICIPANT_NOT_FOUND';
  constructor() {
    super('Enquadre participant not found');
    this.name = 'EnquadreParticipantNotFoundError';
  }
}

/** O evento já está encerrado ou cancelado: é somente leitura. */
export class EnquadreEventNotOpenError extends Error {
  readonly code = 'ENQUADRE_EVENT_NOT_OPEN';
  constructor() {
    super('Enquadre event is not open');
    this.name = 'EnquadreEventNotOpenError';
  }
}

/** Só se encerra depois do horário de fim. */
export class EnquadreEventNotEndedError extends Error {
  readonly code = 'ENQUADRE_EVENT_NOT_ENDED';
  constructor() {
    super('Enquadre event has not ended yet');
    this.name = 'EnquadreEventNotEndedError';
  }
}

/** Tirar convocado já marcado (fora de Convocados) não é permitido: a marcação é um estágio da vaga. */
export class EnquadreParticipantAlreadyMarkedError extends Error {
  readonly code = 'ENQUADRE_PARTICIPANT_ALREADY_MARKED';
  constructor() {
    super('Participant already marked in this event');
    this.name = 'EnquadreParticipantAlreadyMarkedError';
  }
}

/** Não se cria evento com início no passado. */
export class EnquadreSlotInPastError extends Error {
  readonly code = 'ENQUADRE_SLOT_IN_PAST';
  constructor() {
    super('Enquadre event start is in the past');
    this.name = 'EnquadreSlotInPastError';
  }
}

/** O Google recusou a alteração do evento (convidados ou cancelamento): a transação faz ROLLBACK, nada fica gravado. */
export class EnquadreCalendarUpdateFailedError extends Error {
  readonly code = 'CALENDAR_UPDATE_FAILED';
  constructor() {
    super('Google Calendar update failed');
    this.name = 'EnquadreCalendarUpdateFailedError';
  }
}

/**
 * O miolo da mudança de estágio RECUSOU o movimento (motivo faltando/inválido) ou o prestador não pode se candidatar. Carrega
 * status e corpo IDÊNTICOS aos que `WJAFunnelController.moveEncuadre` devolve — o front já trata esses `code`.
 */
export class EnquadreMoveRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly body: Readonly<Record<string, unknown>>,
  ) {
    super(String(body.error ?? 'move_refused'));
    this.name = 'EnquadreMoveRefusedError';
  }
}
