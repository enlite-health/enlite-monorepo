/**
 * Anti-lockout pelos caminhos INDIRETOS (migration 296).
 *
 * "Gestor" = staff ACTIVE com `permission_management:write` vigente. O banco recusa
 * (SQLSTATE 23514, mensagem com `anti-lockout`) qualquer operação que deixaria zero
 * gestores — nas funções da 279 e, desde a 296, no trigger de `users`. Este módulo é
 * o vocabulário TS desse contrato: o código de erro que a API devolve e o reconhecimento
 * do erro do banco, num lugar só.
 */

/** Código de erro da API — o mesmo que o painel já devolve (`permissionPanelWriteRoutes`). */
export const LAST_MANAGER_ERROR = 'last_manager';

export const LAST_MANAGER_MESSAGE =
  'Operação rejeitada: deixaria zero gestores com permission_management:write (anti-lockout)';

/** O RAISE das funções/trigger de `iam` — 23514 com `anti-lockout` no texto. */
export function isAntiLockoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const pg = err as { code?: unknown; message?: unknown };
  return pg.code === '23514' && typeof pg.message === 'string' && pg.message.includes('anti-lockout');
}
