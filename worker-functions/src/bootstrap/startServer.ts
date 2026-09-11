/**
 * Async bootstrap: wires webhook routes and starts the HTTP server.
 * Extracted from src/index.ts to keep that file under the 400-line limit.
 */
import { Express } from 'express';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { createWebhookRoutes, PartnerAuthMiddleware, GoogleApiKeyValidator, WebhookPartnerRepository } from '@modules/integration';
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
import { buildChatwootClient } from './buildChatwootClient';
import { PeriskopeNoteService } from '@modules/notification/infrastructure/PeriskopeNoteService';
import { ChatwootMirrorController } from '@modules/notification/interfaces/controllers/ChatwootMirrorController';
import { GoogleCalendarService } from '@modules/matching';
import { systemContextMiddleware } from '@shared/database/systemContextMiddleware';
import { assertDbRoleMembership } from '@shared/database/assertDbRoleMembership';

/** Concretos de mensageria (não o RoutingMessagingService) — TriggerWorkerHandoverUseCase
 *  precisa garantir que AMBOS os canais recebam o envio correspondente, independente
 *  de qual canal o worker está no momento (parecer do Architect). */
export interface StartServerMessagingDeps {
  twilioMessagingService: TwilioMessagingService;
  periskopeMessagingService: PeriskopeMessagingService;
}

export interface StartServerHooks {
  /**
   * Roda com TODAS as rotas montadas e ANTES do `listen`. Lançar aqui impede o
   * servidor de aceitar tráfego — é o lugar de gate que precisa do router
   * pronto (ex.: catálogo de permissões, task 3.7). Sem hook, nada muda.
   */
  beforeListen?: () => Promise<void>;
}

export async function startServer(
  app: Express,
  useCerbos: boolean,
  messagingDeps: StartServerMessagingDeps,
  hooks: StartServerHooks = {},
): Promise<void> {
  // ── Gate de boot da RLS de país ──────────────────────────────────────────
  // Com COUNTRY_RLS_ENABLED=true, sem a membership de app_runtime/app_system o
  // processo NÃO sobe: melhor a revisão falhar no deploy do que servir tela
  // vazia. Flag off = nenhuma query (ver assertDbRoleMembership).
  await assertDbRoleMembership(
    DatabaseConnection.getInstance().getRawPool(),
    DatabaseConnection.getInstance().getSystemPool(),
  );

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

  // Espelho do inbound pro Chatwoot (faz a Luz ver a resposta e responder).
  // buildChatwootClient retorna null se CHATWOOT_MIRROR_ENABLED != 'true' — e o
  // envio do mirror ainda é gated por CHATWOOT_INBOUND_MIRROR_ENABLED no controller.
  const inboundWhatsAppController = new InboundWhatsAppController(
    DatabaseConnection.getInstance().getPool(),
    bookSlotUseCase,
    handleReminderResponseUseCase,
    triggerHandoverUseCase,
    buildChatwootClient() ?? undefined,
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

  // Contexto de SISTEMA declarado (ABAC país, task 3.3): webhook não é staff e
  // não herda país de ninguém — ele processa os dois países por definição.
  app.use('/api/webhooks', systemContextMiddleware('webhook:partners'), createWebhookRoutes(partnerAuth, inboundWhatsAppController, periskopeWebhookController));
  app.use('/api/webhooks-test', systemContextMiddleware('webhook:partners-test'), createWebhookRoutes(partnerAuth, inboundWhatsAppController, periskopeWebhookController));

  // Espelho da conversa da Luz (Chatwoot) → NOTA no Periskope, pro time ver e assumir.
  // Configurar um 2º webhook message_created no Chatwoot apontando pra cá (go-live).
  // Gated por PERISKOPE_NOTE_MIRROR_ENABLED — neutro até virar a flag.
  const chatwootMirrorController = new ChatwootMirrorController(new PeriskopeNoteService());
  app.post('/api/webhooks/chatwoot/mirror', systemContextMiddleware('webhook:chatwoot-mirror'), (req, res) => chatwootMirrorController.handle(req, res));

  // ── Gates que precisam do router pronto ───────────────────────────────────
  // Depois de TODAS as rotas (as de webhook são montadas acima) e antes do
  // listen: quem lançar aqui não sobe, e o `.catch` do index.ts mata o processo.
  if (hooks.beforeListen) await hooks.beforeListen();

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

  // ── Graceful shutdown (MEDIUM do review ABAC 14/08) ────────────────────────
  // O Cloud Run manda SIGTERM e dá ~10s antes do SIGKILL. Sem handler, o
  // processo morre no meio: requests em voo cortadas e — pior sob RLS — clients
  // fixados com GUC de país nunca passam pelo release. A ordem é: parar de
  // aceitar → esperar as requests em voo (teto de 8s, o SIGKILL vem antes do
  // server.timeout de 5min) → drenar os pools. `process.once`: o segundo SIGTERM
  // mata na hora, como antes.
  process.once('SIGTERM', () => {
    console.log('[shutdown] SIGTERM — parando de aceitar conexões e drenando pools');
    const forceExit = setTimeout(() => {
      console.error('[shutdown] teto de 8s estourado — saindo com requests em voo');
      process.exit(1);
    }, 8000);
    forceExit.unref();

    server.close(() => {
      void DatabaseConnection.getInstance()
        .close()
        .catch((err: unknown) => console.error('[shutdown] falha ao drenar pools:', err))
        .finally(() => {
          console.log('[shutdown] pools drenados — fim limpo');
          process.exit(0);
        });
    });
  });
}
