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
