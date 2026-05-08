import { Router, Request, Response } from 'express';
import { PartnerAuthMiddleware } from '../middleware/PartnerAuthMiddleware';
import { TalentumWebhookController } from '../controllers/TalentumWebhookController';
import { ClickUpPatientWebhookController } from '../controllers/ClickUpPatientWebhookController';
import { ClickUpHmacMiddleware } from '../middleware/ClickUpHmacMiddleware';
import { TwilioWebhookController } from '@modules/notification/interfaces/controllers/TwilioWebhookController';
import { InboundWhatsAppController } from '@modules/notification/interfaces/controllers/InboundWhatsAppController';

/**
 * Cria o router unificado de webhooks.
 * Reutilizado tanto para /api/webhooks/ (produção) quanto /api/webhooks-test/ (teste).
 * O PartnerAuthMiddleware determina isTest com base no prefixo da URL.
 */
export function createWebhookRoutes(
  partnerAuth: PartnerAuthMiddleware,
  inboundWhatsAppController?: InboundWhatsAppController,
  clickupPatientController?: ClickUpPatientWebhookController,
  clickupHmac?: ClickUpHmacMiddleware,
): Router {
  const router = Router();
  const talentumController = new TalentumWebhookController();
  const twilioController = new TwilioWebhookController();

  // ── Talentum — autenticado via partner key (X-Partner-Key) ──────
  router.post(
    '/talentum/prescreening',
    partnerAuth.requirePartnerKey(),
    (req: Request, res: Response) => talentumController.handlePrescreening(req, res),
  );

  // ── Twilio Status — auth próprio via X-Twilio-Signature (sem partner key) ──
  router.post(
    '/twilio/status',
    (req: Request, res: Response) => twilioController.handleStatusCallback(req, res),
  );

  // ── Twilio Inbound — respostas do worker via WhatsApp (Step 7) ──
  if (inboundWhatsAppController) {
    router.post(
      '/twilio/inbound',
      (req: Request, res: Response) => inboundWhatsAppController.handleInbound(req, res),
    );
  }

  // ── ClickUp Patient — autenticado via HMAC X-Signature ──────────
  if (clickupPatientController && clickupHmac) {
    router.post(
      '/clickup/patient',
      clickupHmac.verify(),
      (req: Request, res: Response) => clickupPatientController.handle(req, res),
    );
    // Liveness probe — sem auth, sem PII; usar em uptime check
    router.get(
      '/clickup/patient/_health',
      (req: Request, res: Response) => clickupPatientController.health(req, res),
    );
  }

  return router;
}
