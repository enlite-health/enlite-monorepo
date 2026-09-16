/**
 * AnaCareHttpErrorBase — forma estrutural comum aos dois erros HTTP tipados do Ana Care
 * (achado 3 da F2 de anacare-conferencia-de-horas: `AnaCareHttpError` aqui e `AnaCareApiError`
 * em `AnaCareClient.ts` tinham `method`/`path`/`status`/`body` + mesmo formato de mensagem
 * duplicados). Cada mecanismo de acesso — sessão por cookie aqui, `X-Agency-Key` no outro —
 * mantém sua PRÓPRIA subclasse com seu próprio `name` e tag de mensagem: a base só existe para
 * não repetir a estrutura, nunca para fundir os dois em um erro só (`instanceof` continua
 * distinguindo qual cliente falhou).
 */
export abstract class AnaCareHttpErrorBase extends Error {
  readonly status: number;
  readonly body: string;

  protected constructor(tag: string, method: string, path: string, status: number, body: string) {
    super(`${tag} ${method} ${path} — HTTP ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

/**
 * AnaCareHttpError — erro tipado de resposta HTTP não-ok do cliente de sessão do Ana Care
 * (login por cookie, `/api/shifts/`, `/api/patients/`). Distinto de `AnaCareApiError`
 * (mecanismo de X-Agency-Key em `AnaCareClient.ts`) — sessões diferentes, erros diferentes.
 */
export class AnaCareHttpError extends AnaCareHttpErrorBase {
  constructor(method: string, path: string, status: number, body: string) {
    super('[AnaCareSessionClient]', method, path, status, body);
    this.name = 'AnaCareHttpError';
  }
}

/** Marca falha de rede/timeout do fetch (não chegou a ter status HTTP). */
export class AnaCareTimeoutError extends Error {
  constructor(method: string, path: string) {
    super(`[AnaCareSessionClient] ${method} ${path} — timeout/network error`);
    this.name = 'AnaCareTimeoutError';
  }
}
