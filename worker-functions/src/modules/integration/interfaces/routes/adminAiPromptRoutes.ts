/**
 * adminAiPromptRoutes — /api/admin/ai-prompts/* (spec 029, T013/T019b)
 *
 * Monta os cinco manipuladores que `AiPromptController` (T012/T019b/T033) já implementa:
 *   GET  /ai-prompts             → list
 *   GET  /ai-prompts/{slug}      → get
 *   PUT  /ai-prompts/{slug}      → update
 *   POST /ai-prompts/{slug}/undo → undo
 *   POST /ai-prompts/{slug}/preview → preview (T033; `ai_prompt:update`, não `read`)
 *
 * `restore` é de fase posterior (Fase 5) — não entra aqui.
 *
 * Mesmo mecanismo de `adminIntegrationsRoutes.ts` (vizinho neste diretório, mesmo módulo
 * `integration`): reusa `ADMIN_INTEGRATIONS_FAMILY` — não há necessidade de família nova só para
 * três rotas, e criar uma exigiria entrar em `ALL_PERMISSION_FAMILIES`
 * (`permissionFamilies.ts`) e no e2e `permission-enforcement-all-families`, fora do escopo desta
 * task. `perm.require('ai_prompt', 'read'|'update', { untilEnforced: 'admin' })` gera exatamente
 * as células `ai_prompt:read`/`ai_prompt:update` que `AiPromptController` já checa via
 * `cellsOfRequest(req)` (`cellKey(resource, action)` = `${resource}:${action}`).
 *
 * `untilEnforced: 'admin'`: enquanto a família `admin.integrations` não estiver ligada em
 * `PERMISSION_ENFORCED_ROUTES` (ou o engine desligado), o guard cai para a checagem de papel
 * ADMIN de antes do ABAC — mesmo amortecedor das outras rotas novas desta família
 * (`adminIntegrationsRoutes.ts`). Com a família enforced, a checagem real por célula assume e o
 * `untilEnforced` deixa de ser lido.
 */

import { Router, Request, Response } from 'express';
import type { AuthMiddleware, PermissionMiddleware } from '@modules/identity';
import { ADMIN_INTEGRATIONS_FAMILY } from '@modules/identity/permissions';
import { AiPromptController } from '../controllers/AiPromptController';

export function createAdminAiPromptRoutes(
  controller: AiPromptController,
  authMiddleware: AuthMiddleware,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const staffOnly = authMiddleware.requireStaff();
  const perm = permissions.family(ADMIN_INTEGRATIONS_FAMILY);

  /** GET /api/admin/ai-prompts — lista os três prompts, com conteúdo. */
  router.get(
    '/ai-prompts',
    staffOnly,
    perm.require('ai_prompt', 'read', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.list(req, res),
  );

  /** GET /api/admin/ai-prompts/{slug} — um prompt. 404 se o slug não é do conjunto fechado. */
  router.get(
    '/ai-prompts/:slug',
    staffOnly,
    perm.require('ai_prompt', 'read', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.get(req, res),
  );

  /** PUT /api/admin/ai-prompts/{slug} — grava conteúdo novo com lock otimista (`version`). */
  router.put(
    '/ai-prompts/:slug',
    staffOnly,
    perm.require('ai_prompt', 'update', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.update(req, res),
  );

  /**
   * POST /api/admin/ai-prompts/{slug}/undo — desfaz a última alteração, um passo, sem alvo (T019b).
   * MESMA célula de `update` (`ai_prompt:update`) — nunca `ai_prompt:restore`, que é da Fase 5.
   */
  router.post(
    '/ai-prompts/:slug/undo',
    staffOnly,
    perm.require('ai_prompt', 'update', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.undo(req, res),
  );

  /**
   * POST /api/admin/ai-prompts/{slug}/preview — exemplo com o texto em edição, caso real, sem gravar
   * (T033). Exige `ai_prompt:update`: é operação de quem edita, não de quem só lê.
   */
  router.post(
    '/ai-prompts/:slug/preview',
    staffOnly,
    perm.require('ai_prompt', 'update', { untilEnforced: 'admin' }),
    (req: Request, res: Response) => controller.preview(req, res),
  );

  return router;
}
