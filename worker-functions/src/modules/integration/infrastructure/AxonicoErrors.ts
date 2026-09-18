/**
 * Erros HTTP tipados do `AxonicoApiClient`, um por família de status medida em
 * `docs/funcionalidades/integracao-axonico/estado-integracao-axonico.md` (18/09/2026):
 *
 * - 422 → validação por campo (`AxonicoValidationError`, corpo em `data.errors`, objeto de
 *   arrays por campo).
 * - 400 / 403 / 412 / 500 → erro de negócio/servidor (`AxonicoBusinessError`, mensagem em
 *   `data.message`).
 * - 401 → sessão expirada (`AxonicoAuthError`) — NÃO é erro de negócio, é o gatilho do re-login
 *   em `AxonicoApiClient` (closure local `hasRelogged`, um retry, padrão de
 *   `AnaCareSessionClient.buildForceReloginFetch`). O cliente captura o 401 internamente para
 *   disparar o re-login; `AxonicoAuthError` só escapa para quem chama a porta se o 401 persistir
 *   DEPOIS do retry — erro definitivo, sem loop.
 *
 * Tipar os 3 casos evita `if (status === ...)` espalhado no use case (F3): o use case decide o
 * que fazer por `instanceof`, não por número de status cru.
 */

export class AxonicoValidationError extends Error {
  readonly status: number;
  readonly fieldErrors: Record<string, string[]>;

  constructor(method: string, path: string, fieldErrors: Record<string, string[]>) {
    super(`[AxonicoApiClient] ${method} ${path} — HTTP 422 (validação): ${JSON.stringify(fieldErrors)}`);
    this.name = 'AxonicoValidationError';
    this.status = 422;
    this.fieldErrors = fieldErrors;
  }
}

export class AxonicoBusinessError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, message: string) {
    super(`[AxonicoApiClient] ${method} ${path} — HTTP ${status}: ${message}`);
    this.name = 'AxonicoBusinessError';
    this.status = status;
  }
}

export class AxonicoAuthError extends Error {
  readonly status: number = 401;

  constructor(method: string, path: string) {
    super(`[AxonicoApiClient] ${method} ${path} — HTTP 401 (sessão expirada, sem sucesso após re-login)`);
    this.name = 'AxonicoAuthError';
  }
}
