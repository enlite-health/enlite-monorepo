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
import { PeriskopeInboundRouter } from '@modules/notification/application/PeriskopeInboundRouter';
import { TriggerWorkerHandoverUseCase } from '@modules/notification/application/TriggerWorkerHandoverUseCase';
import { InboundWhatsAppController } from '@modules/notification/interfaces/controllers/InboundWhatsAppController';
import { PeriskopeWebhookController } from '@modules/notification/interfaces/controllers/PeriskopeWebhookController';
import { PeriskopeTicketService } from '@modules/notification/infrastructure/PeriskopeTicketService';
import { TwilioMessagingService } from '@modules/notification/infrastructure/TwilioMessagingService';
import { PeriskopeMessagingService } from '@modules/notification/infrastructure/PeriskopeMessagingService';
import { GoogleCalendarService } from '@modules/matching';

/** Concretos de mensageria (não o RoutingMessagingService) — TriggerWorkerHandoverUseCase
 *  precisa garantir que AMBOS os canais recebam o envio correspondente, independente
 *  de qual canal o worker está no momento (parecer do Architect). */
export interface StartServerMessagingDeps {
  twilioMessagingService: TwilioMessagingService;
  periskopeMessagingService: PeriskopeMessagingService;
}

export async function startServer(
  app: Express,
  useCerbos: boolean,
  messagingDeps: StartServerMessagingDeps,
): Promise<void> {
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
  // Handover Twilio → Periskope (fundação do roteamento por worker).
  // PeriskopeTicketService é best-effort e não exige config para instanciar
  // (loga warning interno se faltar env — ver PeriskopeTicketService).
  const ticketService = new PeriskopeTicketService();
  const triggerHandoverUseCase = new TriggerWorkerHandoverUseCase(
    DatabaseConnection.getInstance().getPool(),
    messagingDeps.twilioMessagingService,
    messagingDeps.periskopeMessagingService,
    ticketService,
  );

  const inboundWhatsAppController = new InboundWhatsAppController(
    DatabaseConnection.getInstance().getPool(),
    bookSlotUseCase,
    handleReminderResponseUseCase,
    triggerHandoverUseCase,
  );

  // ── Periskope inbound webhook (migração Chatwoot → Periskope) ──
  // Habilitado por PERISKOPE_WEBHOOK_ENABLED=true; a validação de assinatura
  // usa PERISKOPE_WEBHOOK_SECRET (sem secret, valida nada — só dev/test).
  let periskopeWebhookController: PeriskopeWebhookController | undefined;
  if (process.env.PERISKOPE_WEBHOOK_ENABLED === 'true') {
    const periskopeInboundRouter = new PeriskopeInboundRouter(
      DatabaseConnection.getInstance().getPool(),
      bookSlotUseCase,
      handleReminderResponseUseCase,
    );
    periskopeWebhookController = new PeriskopeWebhookController(
      DatabaseConnection.getInstance().getPool(),
      handleReminderResponseUseCase,
      periskopeInboundRouter,
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
