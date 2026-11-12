import { ApiError } from '@infrastructure/http/ApiError';
import { CostsApiError } from '@infrastructure/http/AdminCostsApiService';

export interface CustosErro {
  key: string;
  seconds?: number;
}

/** Traduz a falha da API de custos para chave i18n. O discriminador é o `code` estável (e o status) — nunca a frase. */
export function custosErrorKey(err: unknown): CustosErro {
  if (err instanceof ApiError) {
    if (err.status === 403) return { key: 'admin.custos.errors.forbidden' };
    if (err.status === 429 || err.code === 'sync_rate_limited') {
      return { key: 'admin.custos.errors.rateLimited', seconds: err instanceof CostsApiError ? err.retryAfterSeconds : undefined };
    }
    if (err.code === 'bytes_limit') return { key: 'admin.custos.errors.bytesLimit' };
  }
  return { key: 'admin.custos.errors.generic' };
}
