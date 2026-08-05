import { Request, Response, NextFunction } from 'express';

/**
 * Default de `Cache-Control: no-store` para TODA resposta da API.
 *
 * Motivo (incidente 03/08): a API não mandava Cache-Control nenhum, e um 404 de
 * `/api/admin/auth/profile` (login de conta de teste inválida) ficou preso num cache
 * no caminho de rede do escritório — 404 é cacheável por heurística (RFC 9111 §4.2.2).
 * Por ~11min todo GET daquela URL vindo da rede recebia o 404 cacheado sem chegar ao
 * servidor, e o painel negava login de staff válido ("não possui permissões").
 *
 * Rotas intencionalmente cacheáveis (ex.: feed público de vagas) continuam funcionando:
 * este middleware roda ANTES das rotas, então um `setHeader('Cache-Control', ...)` no
 * controller sobrescreve o default.
 */
export function noStoreMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
