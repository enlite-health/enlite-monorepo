import { ApiError } from '@infrastructure/http/ApiError';

/**
 * Traduz a falha da API dos pedidos para a chave de i18n. O discriminador é o `code` ESTÁVEL do backend
 * (e o status HTTP) — a frase de `error` é para humano e pode mudar.
 */
export function pedidosIaErrorKey(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return 'admin.pedidosIa.errors.forbidden';
    if (err.status === 404) return 'admin.pedidosIa.errors.notFound';
    if (err.status === 409 || err.code === 'DECISAO_JA_REGISTRADA') return 'admin.pedidosIa.errors.alreadyDecided';
    if (err.code === 'MOTIVO_OBRIGATORIO' || err.code === 'COMENTARIO_OBRIGATORIO') return 'admin.pedidosIa.errors.required';
  }
  return 'admin.pedidosIa.errors.generic';
}
