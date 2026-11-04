import type { TFunction } from 'i18next';
import { ApiError } from '@infrastructure/http/ApiError';

/** Mensagem humana de um erro da API de entrevistadores: traduz pelo `code` estável, nunca ecoa a mensagem do servidor. */
export function interviewHostErrorMessage(err: unknown, t: TFunction): string {
  const code = err instanceof ApiError ? err.code : undefined;
  if (code && /^[A-Z_]+$/.test(code)) {
    const key = `admin.interviewHosts.errors.${code}`;
    const msg = t(key, { defaultValue: '' });
    if (msg) return msg;
  }
  return t('admin.interviewHosts.saveError');
}
