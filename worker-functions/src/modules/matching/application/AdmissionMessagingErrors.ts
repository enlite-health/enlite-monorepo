/** Erros de domínio do reenvio (spec 049 §4.2.1). A rota HTTP (F3) os traduz em 409. */
export class ResendLimitReached extends Error {
  constructor(public readonly kind: string, public readonly attempt: number) {
    super(`resend_limit_reached: ${kind} já está na tentativa ${attempt}`);
    this.name = 'ResendLimitReached';
  }
}

export class ResendNotAllowed extends Error {
  constructor(public readonly reason: string) {
    super(`resend_not_allowed: ${reason}`);
    this.name = 'ResendNotAllowed';
  }
}
