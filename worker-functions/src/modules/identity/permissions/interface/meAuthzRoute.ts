/**
 * src/modules/identity/permissions/interface/meAuthzRoute.ts
 *
 * `GET /v1/me/authz` — o contrato agregado do painel (design 11, D115 §7). O
 * front carrega isto UMA vez no login e decide tudo com ele: `feature
 * indisponível → esconde`, `sem célula → desabilita com motivo`.
 *
 * O `GetMyAuthzUseCase` já existia desde o grupo 2; o que faltava era a porta
 * HTTP — `git grep '/v1/me' -- src/` só achava comentário, e o e2e exercitava o
 * USE CASE, nunca a rota. Esta é a rota.
 *
 * ⚠️ **SEM célula, de propósito — e não é esquecimento.** Esta rota descreve o
 * próprio ator para ele mesmo. Gatear em `permission_management:read` trancaria
 * fora justamente quem ainda não tem grupo, que é o público da tela de
 * boas-vindas; e gatear numa célula NOVA (`me:read`) criaria uma célula que
 * ninguém tem — no flip, o painel inteiro em branco para todo mundo. É o mesmo
 * raciocínio que pôs `GET /api/admin/auth/profile` em `EXEMPT_ROUTES` (D116):
 * *self* não é decisão de staff. `requireStaff()` continua sendo o portão.
 *
 * Ela também não vaza: o `uid` vem do principal autenticado, NUNCA do path ou
 * da query — não existe `GET /v1/users/:uid/authz` aqui, e é por isso que não
 * há IDOR a testar nesta rota.
 *
 * ⚠️ Falha ao resolver responde **500, não contrato vazio.** Contrato vazio é
 * indistinguível de "conta sem grupo" na tela: o front mostraria a tela de
 * boas-vindas para um admin por causa de uma oscilação do Cloud SQL, e ninguém
 * saberia. Fail-closed aqui é dizer que falhou.
 *
 * O `staffGuard` e o `uidOf` vêm INJETADOS pelo wiring, pelo mesmo motivo do
 * `wellKnownPermissionsRoute`: o módulo é extraível e não conhece o esquema de
 * autenticação da casa.
 */

import { Router, type Request, type RequestHandler } from 'express';
import { logger } from '@shared/logging';
import type { GetMyAuthzUseCase } from '../application/GetMyAuthzUseCase';
import { ENLITE_TENANT_ID } from '../domain/tenant';

export interface MeAuthzRouterDeps {
  getMyAuthz: GetMyAuthzUseCase;
  /** `authMiddleware.requireStaff()` da casa. */
  staffGuard: RequestHandler;
  /** Extração do uid do principal — a MESMA do `PermissionMiddleware`. */
  uidOf: (req: Request) => string | null;
  tenantId?: string;
}

export function createMeAuthzRouter(deps: MeAuthzRouterDeps): Router {
  const router = Router();
  const tenantId = deps.tenantId ?? ENLITE_TENANT_ID;

  router.get('/me/authz', deps.staffGuard, async (req, res) => {
    const uid = deps.uidOf(req);
    if (!uid) {
      // Alcançável: `requireStaff` aceita principal cuja forma não carrega
      // `uid` (chave de API de serviço). Serviço não tem contrato de painel.
      res.status(401).json({ success: false, error: 'Unauthenticated' });
      return;
    }

    try {
      res.json(await deps.getMyAuthz.execute({ uid, tenantId }));
    } catch (err) {
      logger.error({ err, uid }, '[perm] falha ao montar o contrato de authz do painel');
      res.status(500).json({ success: false, error: 'Failed to resolve authorization' });
    }
  });

  return router;
}
