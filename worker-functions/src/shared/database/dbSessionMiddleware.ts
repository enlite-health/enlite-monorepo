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

export function dbSessionMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const store = loggingAls.getStore();
  if (!store) return next();

  const session: DbSession = { released: false };
  store.dbSession = session;

  const release = (): void => {
    void releaseDbSession(session).catch((err) => {
      logger.error({ err }, '[abac] falha ao encerrar a sessão de banco da request');
    });
  };

  res.once('finish', release);
  res.once('close', release);

  next();
}
