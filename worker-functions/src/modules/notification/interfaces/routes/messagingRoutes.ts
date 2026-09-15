import { Router } from 'express';
import { MessagingController } from '../controllers/MessagingController';
import { IMessagingService } from '../../domain/IMessagingService';
import { MessageTemplateRepository } from '../../infrastructure/MessageTemplateRepository';
import type { PermissionMiddleware } from '@modules/identity';

/**
 * ── Família `admin.messaging` (task 3.5-A4) ─────────────────────────────────
 * Mapa rota→célula: `openspec/changes/painel-grupos-permissao/route-permission-map.md`.
 *
 * ⚠️ Estrutura DIFERENTE das outras famílias: este router não recebe
 * `AuthMiddleware`. O guard de papel é aplicado no MOUNT
 * (`app.use('/api/admin/messaging', authMiddleware.requireStaff(), …)`), e
 * continua lá — o guard de célula entra AQUI, por rota, porque as células
 * diferem entre elas.
 *
 * ⚠️ TRÊS CÉLULAS, NÃO UMA — e a separação é o ponto deste PR:
 *
 *   · `messaging:send`  — disparar mensagem (vacancy-match, direct, bulk).
 *   · `messaging:read`  — listar templates.
 *   · `messaging:write` — CRIAR / EDITAR / DESATIVAR template. **Célula NOVA.**
 *
 * O mapa da 0.6 dava `messaging:send` também ao CRUD de template. Está errado, e
 * o motivo é de RAIO, não de nomenclatura: cada linha de `message_templates`
 * amarra um `slug` a um **`content_sid` — o HSM aprovado pela Meta** —, e é ele
 * que o `TwilioMessagingService` usa no envio. Então:
 *   · enviar   = uma mensagem, para uma pessoa, com um template já aprovado;
 *   · editar   = mudar o que TODO envio futuro daquele slug faz, inclusive qual
 *                HSM aprovado é usado, para todos os remetentes e destinatários.
 * Com uma célula só, quem pode disparar reescreve o texto que todo mundo dispara.
 * Decisão do Gabriel, 20/08. `messaging:write` NÃO existe no seed da 206: nasce
 * com as outras duas do A4 quando o A7 ligar `PERMISSION_CATALOG_SYNC_ENABLED`.
 */
import { ADMIN_MESSAGING_FAMILY } from '@modules/identity/permissions';
export { ADMIN_MESSAGING_FAMILY };

export function createMessagingRoutes(
  messagingService: IMessagingService,
  templateRepo: MessageTemplateRepository,
  permissions: PermissionMiddleware,
): Router {
  const router = Router();
  const controller = new MessagingController(messagingService, templateRepo);
  const perm = permissions.family(ADMIN_MESSAGING_FAMILY);

  // POST /api/admin/messaging/whatsapp/vacancy-match — convite de match (template decidido por status do worker)
  router.post('/whatsapp/vacancy-match', perm.require('messaging', 'send'), (req, res) => controller.sendVacancyMatch(req, res));

  // POST /api/admin/messaging/whatsapp/direct — envia template a número direto
  router.post('/whatsapp/direct', perm.require('messaging', 'send'), (req, res) => controller.sendDirect(req, res));

  // GET  /api/admin/messaging/templates — lista templates (?all=true inclui inativos)
  router.get('/templates', perm.require('messaging', 'read'), (req, res) => controller.listTemplates(req, res));

  // POST /api/admin/messaging/templates — cria template (upsert por slug)
  router.post('/templates', perm.require('messaging', 'create'), (req, res) => controller.createTemplate(req, res));

  // PUT  /api/admin/messaging/templates/:slug — atualiza template
  router.put('/templates/:slug', perm.require('messaging', 'update'), (req, res) => controller.updateTemplate(req, res));

  // DELETE /api/admin/messaging/templates/:slug — desativa template (soft delete)
  router.delete('/templates/:slug', perm.require('messaging', 'update'), (req, res) => controller.deleteTemplate(req, res));

  // POST /api/admin/messaging/bulk-dispatch-incomplete — dispara complete_register_ofc
  //   para todos os workers com encuadre que têm docs ou perfil incompletos
  router.post('/bulk-dispatch-incomplete', perm.require('messaging', 'send'), (req, res) => controller.bulkDispatchIncomplete(req, res));

  return router;
}
