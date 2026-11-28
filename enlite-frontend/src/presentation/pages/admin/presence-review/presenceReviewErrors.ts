import { ApiError } from '@infrastructure/http/ApiError';

/** O `code` ESTÁVEL do backend (e o status HTTP) decide a chave de i18n; a frase de `error` é para humano e pode mudar. */
export function presenceReviewErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 409 || err.code === 'EXCEPTION_ALREADY_DECIDED') return 'admin.presenceReview.errors.alreadyDecided';
    if (err.status === 404 || err.code === 'EXCEPTION_NOT_FOUND') return 'admin.presenceReview.errors.notFound';
    if (err.status === 503 || err.code === 'UPSTREAM_UNAVAILABLE') return 'admin.presenceReview.errors.unavailable';
  }
  return 'admin.presenceReview.errors.generic';
}

/** 403 da rota = a conta não tem a célula (mesmo com o engine do front desligado): a página mostra "Sin acceso". */
export const isForbidden = (err: unknown): boolean => err instanceof ApiError && err.status === 403;
