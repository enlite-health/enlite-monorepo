import { ApiError } from '@infrastructure/http/ApiError';

/**
 * Traduz a falha da API do painel para a chave de i18n. O discriminador é o
 * `code` ESTÁVEL do 409 — a frase de `error` é para humano e pode mudar.
 */
export function panelErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.code === 'last_manager') return 'admin.access.group.lastManager';
    if (err.code === 'system_group') return 'admin.access.group.systemGroup';
    if (err.code === 'duplicate_name') return 'admin.access.group.duplicateName';
    if (err.status === 404) return 'admin.access.group.notFound';
  }
  return 'admin.access.group.error';
}
