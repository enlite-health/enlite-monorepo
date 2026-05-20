import { Router } from 'express';
import { MessagingController } from '../controllers/MessagingController';
import { IMessagingService } from '../../domain/IMessagingService';
import { MessageTemplateRepository } from '../../infrastructure/MessageTemplateRepository';

/** Rota pública temporária — remover após configurar autenticação no cron. */
export function createPublicBulkDispatchRoute(
  messagingService: IMessagingService,
  templateRepo: MessageTemplateRepository,
): Router {
  const router = Router();
  const controller = new MessagingController(messagingService, templateRepo);
  router.post('/bulk-dispatch-incomplete', (req, res) => controller.bulkDispatchIncomplete(req, res));
  return router;
}

export function createMessagingRoutes(
  messagingService: IMessagingService,
  templateRepo: MessageTemplateRepository,
): Router {
  const router = Router();
  const controller = new MessagingController(messagingService, templateRepo);

  // POST /api/admin/messaging/whatsapp/vacancy-match — convite de match (template decidido por status do worker)
  router.post('/whatsapp/vacancy-match', (req, res) => controller.sendVacancyMatch(req, res));

  // POST /api/admin/messaging/whatsapp/direct — envia template a número direto
  router.post('/whatsapp/direct', (req, res) => controller.sendDirect(req, res));

  // GET  /api/admin/messaging/templates — lista templates (?all=true inclui inativos)
  router.get('/templates', (req, res) => controller.listTemplates(req, res));

  // POST /api/admin/messaging/templates — cria template (upsert por slug)
  router.post('/templates', (req, res) => controller.createTemplate(req, res));

  // PUT  /api/admin/messaging/templates/:slug — atualiza template
  router.put('/templates/:slug', (req, res) => controller.updateTemplate(req, res));

  // DELETE /api/admin/messaging/templates/:slug — desativa template (soft delete)
  router.delete('/templates/:slug', (req, res) => controller.deleteTemplate(req, res));

  // POST /api/admin/messaging/bulk-dispatch-incomplete — dispara complete_register_ofc
  //   para todos os workers com encuadre que têm docs ou perfil incompletos
  router.post('/bulk-dispatch-incomplete', (req, res) => controller.bulkDispatchIncomplete(req, res));

  return router;
}
