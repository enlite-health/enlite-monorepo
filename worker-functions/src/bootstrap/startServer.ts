/**
 * Async bootstrap: wires webhook routes and starts the HTTP server.
 * Extracted from src/index.ts to keep that file under the 400-line limit.
 */
import { Express } from 'express';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { createWebhookRoutes, PartnerAuthMiddleware, GoogleApiKeyValidator, WebhookPartnerRepository } from '@modules/integration';
import { ClickUpPatientWebhookController } from '@modules/integration/interfaces/webhooks/controllers/ClickUpPatientWebhookController';
import { ClickUpHmacMiddleware } from '@modules/integration/interfaces/webhooks/middleware/ClickUpHmacMiddleware';
import { PubSubClient } from '@shared/events/PubSubClient';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { BookSlotFromWhatsAppUseCase } from '@modules/notification/application/BookSlotFromWhatsAppUseCase';
import { HandleReminderResponseUseCase } from '@modules/notification/application/HandleReminderResponseUseCase';
import { InboundWhatsAppController } from '@modules/notification/interfaces/controllers/InboundWhatsAppController';
import { PeriskopeWebhookController } from '@modules/notification/interfaces/controllers/PeriskopeWebhookController';
import { GoogleCalendarService } from '@modules/matching';

export async function startServer(app: Express, useCerbos: boolean): Promise<void> {
  // ── Partner Auth (sync) ──────────────────────────────────────────────────
  const googleValidator = new GoogleApiKeyValidator();
  const webhookPartnerRepo = new WebhookPartnerRepository();
  const partnerAuth = new PartnerAuthMiddleware(googleValidator, webhookPartnerRepo);

  const googleCalendarService = new GoogleCalendarService();
  const bookSlotUseCase = new BookSlotFromWhatsAppUseCase(
    DatabaseConnection.getInstance().getPool(),
    new PubSubClient(),
    new CloudTasksClient(),
    googleCalendarService,
  );
  const handleReminderResponseUseCase = new HandleReminderResponseUseCase(
    DatabaseConnection.getInstance().getPool(),
    new PubSubClient(),
    googleCalendarService,
  );
  const inboundWhatsAppController = new InboundWhatsAppController(
    DatabaseConnection.getInstance().getPool(),
    bookSlotUseCase,
    handleReminderResponseUseCase,
  );

  // ── Periskope inbound webhook (migração Chatwoot → Periskope) ──
  // Habilitado por PERISKOPE_WEBHOOK_ENABLED=true; a validação de assinatura
  // usa PERISKOPE_WEBHOOK_SECRET (sem secret, valida nada — só dev/test).
  let periskopeWebhookController: PeriskopeWebhookController | undefined;
  if (process.env.PERISKOPE_WEBHOOK_ENABLED === 'true') {
    periskopeWebhookController = new PeriskopeWebhookController(
      DatabaseConnection.getInstance().getPool(),
      handleReminderResponseUseCase,
    );
    console.log('[startup] Periskope inbound webhook route enabled');
  }

  // ── ClickUp Patient webhook (async: fetches field definitions from ClickUp API) ──
  const clickupSecret = process.env.CLICKUP_WEBHOOK_SECRET;
  let clickupPatientController: ClickUpPatientWebhookController | undefined;
  let clickupHmac: ClickUpHmacMiddleware | undefined;
  if (clickupSecret) {
    try {
      clickupPatientController = await ClickUpPatientWebhookController.create();
      clickupHmac = new ClickUpHmacMiddleware(clickupSecret);
    } catch (err) {
      console.error('[startup] ClickUp webhook controller init failed — route will be unavailable:', err);
    }
  } else {
    console.warn('[startup] CLICKUP_WEBHOOK_SECRET not set — ClickUp webhook route will be unavailable');
  }

  app.use('/api/webhooks', createWebhookRoutes(partnerAuth, inboundWhatsAppController, clickupPatientController, clickupHmac, periskopeWebhookController));
  app.use('/api/webhooks-test', createWebhookRoutes(partnerAuth, inboundWhatsAppController, clickupPatientController, clickupHmac, periskopeWebhookController));

  // ── Start Server ──────────────────────────────────────────────────────────
  const PORT = process.env.PORT || 8080;

  console.log('[EventDriven] Services wired — no polling timers');

  const server = app.listen(PORT, () => {
    console.log(`Enlite Backend running on port ${PORT}`);
    console.log(`Authorization engine: ${useCerbos ? 'Cerbos' : 'Local'}`);
  });

  server.timeout = 300000; // 5 minutos
  server.keepAliveTimeout = 310000;
  server.headersTimeout = 320000;
}
