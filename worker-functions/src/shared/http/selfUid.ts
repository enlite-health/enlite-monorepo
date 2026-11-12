import type { Request } from 'express';

/**
 * Identidade da própria conta nas rotas "me" (D650, F21): vem SÓ do token verificado (`req.user.uid`).
 * Nenhum header de identidade vindo do cliente é lido (D650); sem token válido devolve `null`.
 */
export function selfUid(req: Request): string | null {
  return (req as Request & { user?: { uid?: string } }).user?.uid || null;
}
