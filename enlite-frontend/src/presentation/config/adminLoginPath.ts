/**
 * Destino ÚNICO do login do painel: o login único (`/login`) com `next` apontando para
 * o painel. `/admin/login` só redireciona para cá (AdminLoginRedirect). Nenhum outro
 * arquivo escreve a string da rota; todos chamam `adminLoginPath`.
 */
export const ADMIN_ROOT_PATH = '/admin';

export function adminLoginPath(next: string = ADMIN_ROOT_PATH): string {
  return `/login?next=${encodeURIComponent(next)}`;
}

/** `next` só é aceito como caminho interno (começa com `/`, não com `//`); senão volta ao painel. */
export function safeAdminNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : ADMIN_ROOT_PATH;
}
