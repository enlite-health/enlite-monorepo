// Erros de domínio da tela Entrevistadores (spec 055). Cada um carrega o `code` estável que a tela traduz; a tela NUNCA ecoa a mensagem.

/** R1: o uid não é de um usuário staff ativo (inexistente, desativado ou prestador). */
export class InterviewHostUserNotEligibleError extends Error {
  readonly code = 'INTERVIEW_HOST_USER_NOT_ELIGIBLE';
  constructor() {
    super('User is not an active staff user');
    this.name = 'InterviewHostUserNotEligibleError';
  }
}

export class InterviewHostNotFoundError extends Error {
  readonly code = 'INTERVIEW_HOST_NOT_FOUND';
  constructor() {
    super('Interview host not found');
    this.name = 'InterviewHostNotFoundError';
  }
}

/** A pessoa já está na lista ativa: editar é PATCH, não POST. */
export class InterviewHostAlreadyActiveError extends Error {
  readonly code = 'INTERVIEW_HOST_ALREADY_ACTIVE';
  constructor() {
    super('Interview host is already active');
    this.name = 'InterviewHostAlreadyActiveError';
  }
}
