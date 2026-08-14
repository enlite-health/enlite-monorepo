/**
 * src/shared/database/dbSessionMiddleware.ts
 *
 * Abre a sessão de banco da request e — o ponto crítico — GARANTE a devolução do
 * client fixado quando a resposta termina, inclusive quando o cliente desliga no
 * meio (`close` sem `finish`). Sem isso o pool (max 20) esvaziaria em minutos.
 *
 * Montado logo depois do `correlationMiddleware` (que cria o store do ALS) e
 * ANTES das rotas: quem autentica só precisa preencher `session.context`.
 */

import type { Request, Response, NextFunction } from 'express';
import { loggingAls, logger } from '@shared/logging';
import { releaseDbSession, type DbSession } from './requestDbSession';

/** Segmento que identifica UMA pessoa/registro (uuid, número, telefone, token). */
const IDENTIFIER_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[+%\d][\d+%._-]*|[0-9a-zA-Z_-]{20,})$/i;

/**
 * Rota sem identificadores: `/api/admin/patients/<uuid>` → `/api/admin/patients/:id`.
 *
 * O aviso de request não classificada (rlsAwarePool) precisa dizer QUAL endpoint
 * é — mas o path cru carrega id de paciente e até telefone (`/dedup/groups/
 * <telefone>`), que não pode ir para o Cloud Logging. Sanitizar na origem é o
 * único ponto em que dá para garantir isso uma vez só.
 */
export function sanitizeRoute(path: string): string {
  return path
    .split('/')
    .map((segment) => (IDENTIFIER_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
}

export function dbSessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const store = loggingAls.getStore();
  if (!store) return next();

  const session: DbSession = { released: false };
  store.dbSession = session;
  store.requestMethod = req.method;
  store.requestRoute = sanitizeRoute(req.path);

  const release = (): void => {
    void releaseDbSession(session).catch((err) => {
      logger.error({ err }, '[abac] falha ao encerrar a sessão de banco da request');
    });
  };

  res.once('finish', release);
  res.once('close', release);

  next();
}
