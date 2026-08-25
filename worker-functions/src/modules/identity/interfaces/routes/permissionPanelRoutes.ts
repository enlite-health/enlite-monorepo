/**
 * src/modules/identity/interfaces/routes/permissionPanelRoutes.ts
 *
 * A família `admin.permissions` — a API de LEITURA do painel de acessos (F3 do
 * plano, task 4.1 na parte de leitura). Nasce com uma rota só, e a rota existe
 * por dois motivos, nesta ordem:
 *
 *  1. **É ela que declara `permission_management:read`.** Nenhuma rota do
 *     sistema declarava essa célula (medido: `git grep permission_management`
 *     achava só a `:write`, em `adminUsersRoutes.ts:72`). Com o
 *     `PERMISSION_CATALOG_SYNC_ENABLED` ligado na `stage` pelo #245, o sync
 *     conclui que a célula sumiu do código e a DESCONTINUA; `iam.effective_
 *     permissions` filtra `deprecated_at IS NULL`; e `iam.query_audit`
 *     (mig 280:143) passa a levantar **42501 para todo mundo, inclusive o
 *     Acesso Master**. É o efeito que hoje está no ar na QA. Declarada aqui, o
 *     próximo boot chama `sync_permission_cell`, que faz `deprecated_at = NULL`
 *     e loga `'revived'` — a trilha de auditoria volta sozinha.
 *  2. O catálogo é o desenho da MATRIZ da tela de grupo. Sem ele o gestor não
 *     tem o que marcar.
 *
 * ⚠️ O `requireStaff` fica ALÉM da célula, como nas outras famílias: enquanto
 * `admin.permissions` não estiver em `PERMISSION_ENFORCED_ROUTES` (F13), o
 * guard de papel é a ÚNICA proteção viva desta rota. Tirar agora seria abri-la.
 *
 * ⚠️ O catálogo NÃO carrega dado pessoal — é a lista de células do código
 * (`recurso:ação` + categoria + serviço dono). O que ele expõe é topologia, e é
 * por isso que a rota é gateada e não pública; o par público é o
 * `/.well-known/permissions`, que já roda atrás do guard interno (lex C14).
 */

import { Router } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import type { ListPermissionCatalogUseCase } from '@modules/identity/permissions';
import type { AuthMiddleware } from '../middleware/AuthMiddleware';
import type { PermissionMiddleware } from '../middleware/PermissionMiddleware';

export const ADMIN_PERMISSIONS_FAMILY = 'admin.permissions';

/**
 * Zod na borda (task 4.1). `includeDeprecated` é opt-in explícito: a tela de
 * grupo NÃO pode oferecer célula descontinuada para marcar — só a vista de
 * auditoria, que precisa mostrar o que um grupo tinha numa data.
 */
const CatalogQuery = z.object({
  includeDeprecated: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export function createPermissionPanelRoutes(
  listCatalog: ListPermissionCatalogUseCase,
  auth: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const perm = permissions.family(ADMIN_PERMISSIONS_FAMILY);

  router.get(
    '/permissions/catalog',
    auth.requireStaff(),
    perm.require('permission_management', 'read'),
    async (req, res) => {
      const query = CatalogQuery.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({ success: false, error: 'Invalid query parameters' });
        return;
      }

      // Sem `asyncHandler` na casa: rejeição de handler `async` não chega ao
      // error handler do Express 4 — vira `unhandledRejection` e a request
      // pendura até o timeout do cliente. O `try` é o que fecha isso.
      try {
        const categories = await listCatalog.execute({ includeDeprecated: query.data.includeDeprecated });
        res.json({ categories });
      } catch (err) {
        logger.error({ err }, '[perm] falha ao listar o catálogo de células');
        res.status(500).json({ success: false, error: 'Failed to list permission catalog' });
      }
    },
  );

  return router;
}
