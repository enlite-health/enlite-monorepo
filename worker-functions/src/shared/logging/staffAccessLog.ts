/**
 * src/shared/logging/staffAccessLog.ts
 *
 * Registro de acesso de COLABORADOR ao painel — uma linha por request de staff,
 * atrás de `STAFF_ACCESS_LOG_ENABLED` (default OFF).
 *
 * Existe para uma finalidade única e temporária: descobrir QUE TELAS cada pessoa
 * do time usa, para montar os grupos de permissão sem tirar acesso de quem
 * trabalha. Escrita é atribuível desde a D95; **leitura é ponto cego total**, e
 * 15 das 22 pessoas do staff só leem.
 *
 * ⚠️ LEIA ANTES DE MEXER — este arquivo tem condições jurídicas embutidas
 * (`openspec/changes/painel-grupos-permissao/lex-veredito-0.2.md`, D125):
 *
 *  - **A linha NÃO pode emitir `traceId`** (condição M1-5). Por isso existe uma
 *    instância PRÓPRIA de pino aqui, deliberadamente sem o `mixin()` do
 *    `Logger.ts`: o `traceId` é a chave que permite juntar esta linha com o log
 *    de request do Cloud Run, que guarda a URL **crua** — e com ela se
 *    reconstrói "o colaborador X abriu o paciente <uuid>". Usar o `logger`
 *    comum aqui reintroduz exatamente o risco que a condição remove.
 *  - **A rota sai SEMPRE do template do Express**, nunca de `req.originalUrl`:
 *    o template já vem sem identificador (`/api/admin/workers/:id`). Medido que
 *    `req.baseUrl` sobrevive até o `finish` nesta versão do Express.
 *  - **Nada de corpo, query string, IP ou user-agent.**
 *
 * O que a linha guarda: `uid` (pseudônimo — é dado pessoal, re-identificável por
 * JOIN em `users`), método, rota e status. O `event` fixo é o que o sink usa
 * para mandar isto a um bucket regional dedicado (condição M1-3).
 */

import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import { loggingAls } from './als';

/** Chave do sink/exclusion do Cloud Logging (M1-3) — não renomear sem refazer o sink. */
export const STAFF_ACCESS_EVENT = 'staff_access';

/** Rota que o Express não casou (404, erro antes do router). */
export const UNMATCHED_ROUTE = '<unmatched>';

const STAFF_ACTOR_SOURCE = 'admin_panel';
const STAFF_ID_PREFIX = 'staff:';

export interface StaffAccessEntry {
  event: typeof STAFF_ACCESS_EVENT;
  uid: string;
  method: string;
  route: string;
  status: number;
}

/**
 * Instância separada do `logger` de `Logger.ts` — **de propósito**, para não
 * herdar o `mixin()` que injeta `traceId`. Ver M1-5 no cabeçalho.
 */
export function createStaffAccessLogger(destination?: pino.DestinationStream) {
  return pino(
    {
      messageKey: 'message',
      formatters: {
        level() {
          return { severity: 'INFO' };
        },
      },
    },
    destination,
  );
}

const defaultLogger = createStaffAccessLogger();

/** `true` só com a flag explicitamente ligada. */
export function isStaffAccessLogEnabled(): boolean {
  return process.env.STAFF_ACCESS_LOG_ENABLED === 'true';
}

/**
 * Só staff entra na medição. O recorte por papel é o da D95: o `AuthMiddleware`
 * marca `admin_panel` para o painel e `worker_self` para o app do prestador —
 * sem isso, uma edição do candidato entraria como trabalho do time.
 */
export function staffUidFromAls(): string | null {
  const actor = loggingAls.getStore()?.actor;
  if (!actor || actor.source !== STAFF_ACTOR_SOURCE) return null;
  if (!actor.id.startsWith(STAFF_ID_PREFIX)) return null;
  const uid = actor.id.slice(STAFF_ID_PREFIX.length);
  return uid.length > 0 ? uid : null;
}

/** Template do Express (`/api/admin/workers/:id`) — nunca a URL crua. */
export function routeTemplate(req: Request): string {
  const path = req.route?.path;
  if (typeof path !== 'string') return UNMATCHED_ROUTE;
  const template = `${req.baseUrl ?? ''}${path}`;
  return template.length > 0 ? template : UNMATCHED_ROUTE;
}

export function createStaffAccessLogMiddleware(logger = defaultLogger) {
  return function staffAccessLogMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (!isStaffAccessLogEnabled()) return next();

    res.on('finish', () => {
      // Lido no finish, e não aqui: o ator só é preenchido depois, pelo
      // AuthMiddleware, no MESMO objeto de store.
      const uid = staffUidFromAls();
      if (!uid) return;

      const entry: StaffAccessEntry = {
        event: STAFF_ACCESS_EVENT,
        uid,
        method: req.method,
        route: routeTemplate(req),
        status: res.statusCode,
      };
      logger.info(entry, 'staff access');
    });

    next();
  };
}

export const staffAccessLogMiddleware = createStaffAccessLogMiddleware();
