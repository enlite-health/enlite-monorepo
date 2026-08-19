// ── Global error handlers (must be registered before any other code) ──────────
// Prevents unhandled promise rejections (e.g. google-auth-library background
// retries in environments without ADC) from crashing the process.
// In production these are logged; orchestrators (Cloud Run) handle restarts.
import { reportError } from './shared/logging/ErrorReporter';

process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  reportError(
    reason instanceof Error ? reason : new Error(String(reason)),
    { source: 'unhandledRejection', promise: String(promise) },
  );
});

process.on('uncaughtException', (err: Error) => {
  reportError(err, { source: 'uncaughtException' });
  process.exit(1);
});

import express, { Request, Response } from 'express';
import { corsMiddleware } from '@shared/http/corsConfig';
import rateLimit from 'express-rate-limit';
import { WorkerControllerV2, JobsController, WorkerDocumentsMeController, AdminWorkerDocumentsController, WorkerAdditionalDocsMeController, AdminAdditionalDocsController, createAdminWorkerDocumentsRoutes, createWorkerDocumentsRoutes } from '@modules/worker';
import {
  AdminPatientsController,
  AdminPatientChatIdsController,
  AdminPatientChatRolesController,
  createAdminPatientsRoutes,
  PublicLeadsController,
} from '@modules/case';
import { UserController } from '@modules/identity';
import { AdminController, createAuthTelemetryRoutes, createAdminUsersRoutes } from '@modules/identity';
import {
  AuthMiddleware,
  MultiAuthService,
  SimplifiedAuthorizationEngine,
  CerbosAuthorizationAdapter,
  GroupPermissionEngine,
  mockAuthMiddleware,
  createMockAuthEndpoints,
} from '@modules/identity';
import { EncuadreController, VacanciesController, VacancyTalentumController, VacancyMatchController, WJAFunnelController, WJAFunnelTableController, EncuadreDashboardController, AnalyticsController, RecruitmentController, VacancyCrudController, PublicVacancyController, WorkerApplicationsController, VacancyAddressReviewController, PublicJobsController, AdmissionSchedulingController } from '@modules/matching';
import { AdminWorkersController, AdminWorkerTestFlagController, AdminWorkerProfileController, AdminWorkerServiceAreaController, createAdminWorkerRoutes } from '@modules/worker';
import { AdminWorkersAuxController } from './modules/worker/interfaces/controllers/AdminWorkersAuxController';
import { AdminTagCatalogController } from './modules/worker/interfaces/controllers/AdminTagCatalogController';
import { WorkerTimelineController } from './modules/worker/interfaces/controllers/WorkerTimelineController';
import { MessageTemplateRepository } from '@modules/notification/infrastructure/MessageTemplateRepository';
import { buildChatwootClient } from './bootstrap/buildChatwootClient';
import { buildMessagingService } from './bootstrap/buildMessagingService';
import { OutboxProcessor } from '@modules/notification/infrastructure/OutboxProcessor';
import { BulkDispatchScheduler } from '@modules/notification/infrastructure/BulkDispatchScheduler';
import { BulkDispatchTalentumScheduler } from '@modules/notification/infrastructure/BulkDispatchTalentumScheduler';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { createMessagingRoutes } from '@modules/notification/interfaces/routes/messagingRoutes';
import { correlationMiddleware } from './shared/logging/correlationMiddleware';
import { dbSessionMiddleware } from './shared/database/dbSessionMiddleware';
import { publicContextMiddleware, systemContextMiddleware } from './shared/database/systemContextMiddleware';
import { noStoreMiddleware } from './shared/http/noStoreMiddleware';
import { startServer } from './bootstrap/startServer';
import {
  createPermissionsBoundary,
  runPermissionsBootTasks,
  wirePermissionsModule,
} from './bootstrap/wirePermissionsModule';
import { createAnalyticsRoutes, createRecruitmentRoutes, createWorkerApplicationsRoutes, createAdminVacanciesRoutes, createWorkerEncuadreRoutes, InterviewSlotsController, VacancySocialLinksController } from '@modules/matching';
import { WorkerContextController } from '@modules/matching/interfaces/controllers/WorkerContextController';
import { createWorkerContextRoutes } from '@modules/matching/interfaces/routes/workerContextRoutes';
import { ReminderScheduler } from '@modules/notification/infrastructure/ReminderScheduler';
import { VacancyMeetLinksController } from '@modules/matching';
import { DomainEventProcessor } from '@shared/events/DomainEventProcessor';
import { DomainEventBacklogService } from '@shared/events/DomainEventBacklogService';
import { AnaCareMirrorHealthService } from '@shared/events/AnaCareMirrorHealthService';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { PubSubClient } from '@shared/events/PubSubClient';
import { createQualifiedInterviewHandler } from '@shared/events/handlers/QualifiedInterviewHandler';
import { createVacancyAutoInviteHandler } from '@shared/events/handlers/VacancyAutoInviteHandler';
import { createAnaCareMirrorHandler } from '@modules/integration/application/AnaCareMirrorEventHandler';
import { createPromoteBlockedApplicationsHandler } from '@modules/matching';
import { TokenService } from '@modules/notification/infrastructure/TokenService';
import { InternalController } from '@modules/notification/interfaces/controllers/InternalController';
import { createInternalRoutes } from '@modules/notification/interfaces/routes/internalRoutes';
import { internalAuthMiddleware } from '@modules/notification';
import { AdmissionSchedulingService } from '@modules/matching/application/AdmissionSchedulingService';
import { AdmissionReminderService } from '@modules/matching/application/AdmissionReminderService';
import { AdmissionReminderController } from '@modules/matching/interfaces/controllers/AdmissionReminderController';
import { RealAdmissionNotifier } from '@modules/matching/infrastructure/RealAdmissionNotifier';
import { RecruitmentHealthController } from '@modules/notification/interfaces/controllers/RecruitmentHealthController';
import { createSwaggerRouter, shouldGateDocs } from '@shared/openapi/swaggerRouter';
import { createClaimController } from './bootstrap/createClaimController';
import { createClaimRoutes } from '@modules/auth/interfaces/routes/claimRoutes';
import { AccountLinkController } from '@modules/account-link/AccountLinkController';
import { createAccountLinkRoutes } from '@modules/account-link/accountLinkRoutes';
import { registerAdminMaintenanceRoutes } from './bootstrap/registerAdminMaintenanceRoutes';
import { createAdminIntegrationsRoutes } from '@modules/integration';

const app = express();

// CORS — origens default + CORS_ALLOWED_ORIGINS (CSV). Ver shared/http/corsConfig.
app.use(corsMiddleware());

// Cache-Control: no-store por default (rotas cacheáveis sobrescrevem). Ver shared/http/noStoreMiddleware.
app.use(noStoreMiddleware);

app.use(express.json({
  limit: '60mb',
  verify: (req, _res, buf) => {
    // Rotas com validação HMAC do raw body (re-serializar o JSON não é confiável)
    if (
      req.url?.startsWith('/api/webhooks/clickup') ||
      req.url?.startsWith('/api/webhooks/periskope') ||
      req.url?.startsWith('/api/webhooks-test/periskope')
    ) {
      (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    }
  },
}));
app.use(express.urlencoded({ limit: '60mb', extended: true }));

// Correlation ID: extracts X-Cloud-Trace-Context or generates UUID.
// Must run before any auth/business middleware.
app.use(correlationMiddleware);

// Sessão de banco da request (contexto de país da RLS + devolução do client).
// Depois do correlation (que cria o store do ALS) e antes de qualquer rota.
app.use(dbSessionMiddleware);

app.use(mockAuthMiddleware);

// ── Auth services ─────────────────────────────────────────────────────────────
const authService = new MultiAuthService({
  enableApiKeys: true,
  enableJwt: false,
  enableGoogleIdToken: true,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  internalTokenSecret: process.env.INTERNAL_TOKEN_SECRET,
}, DatabaseConnection.getInstance().getPool());

// ── Permissões (painel de grupos, grupo 3) ────────────────────────────────────
// ANTES das rotas de propósito: o `PermissionMiddleware` é o que cada rota usa
// para declarar e decidir a célula, e o guard de rota-sem-declaração precisa
// estar montado antes delas para rodar. Neutro enquanto
// PERMISSION_ENGINE_ENABLED estiver off. Ver bootstrap/wirePermissionsModule.
const permissionsBoundary = createPermissionsBoundary({
  app,
  pool: DatabaseConnection.getInstance().getPool(),
  systemPool: DatabaseConnection.getInstance().getSystemPool(),
});
const permissionMiddleware = permissionsBoundary.middleware;

const useCerbos = process.env.USE_CERBOS === 'true';
const baseAuthzEngine = useCerbos && process.env.CERBOS_ENDPOINT
  ? new CerbosAuthorizationAdapter({
      cerbosEndpoint: process.env.CERBOS_ENDPOINT,
      playgroundEnabled: process.env.NODE_ENV === 'development',
    })
  : new SimplifiedAuthorizationEngine();

// Com o engine ligado, staff decide por CÉLULA; quem não é staff (app do
// prestador, serviço) continua no motor anterior — o enforcement por célula é
// do painel administrativo (spec permission-enforcement).
// ⚠️ `governsCell` é o que impede a flag global de virar a decisão de rotas que
// NENHUMA família ligou: `requirePermission` legado (`/api/users/:userId` etc.)
// usa células que nem existem no catálogo, e sem este recorte ninguém poderia
// concedê-las. Rota não virada continua se comportando como hoje (design 6).
const authzEngine = process.env.PERMISSION_ENGINE_ENABLED === 'true'
  ? new GroupPermissionEngine(permissionsBoundary.permissions.client, baseAuthzEngine, {
      governsCell: (resource, action) => permissionsBoundary.registry.declaresCell(resource, action),
    })
  : baseAuthzEngine;

const authMiddleware = new AuthMiddleware(authService, authzEngine, permissionsBoundary.permissions.client);

// ── Controller instances ──────────────────────────────────────────────────────
const workerController = new WorkerControllerV2();
const userController = new UserController();
const adminController = new AdminController();
const jobsController = new JobsController();
const workerDocumentsMeController = new WorkerDocumentsMeController();
const adminWorkerDocumentsController = new AdminWorkerDocumentsController();
const workerAdditionalDocsMeController = new WorkerAdditionalDocsMeController();
const adminAdditionalDocsController = new AdminAdditionalDocsController();
const encuadreController = new EncuadreController();
const analyticsController = new AnalyticsController();
const recruitmentController = new RecruitmentController();
const vacanciesController = new VacanciesController();
const vacancyCrudController = new VacancyCrudController();
const vacancyTalentumController = new VacancyTalentumController();
const vacancyMatchController = new VacancyMatchController();
const funnelController = new WJAFunnelController();
const funnelTableController = new WJAFunnelTableController();
const dashboardController = new EncuadreDashboardController();
const workerApplicationsController = new WorkerApplicationsController();
const adminWorkersController = new AdminWorkersController();
const adminWorkerTestFlagController = new AdminWorkerTestFlagController();
const adminWorkerProfileController = new AdminWorkerProfileController();
const adminWorkerServiceAreaController = new AdminWorkerServiceAreaController();
const adminWorkersAuxController = new AdminWorkersAuxController();
const adminTagCatalogController = new AdminTagCatalogController();
const workerTimelineController = new WorkerTimelineController(DatabaseConnection.getInstance().getPool());
const adminPatientsController = new AdminPatientsController();
const publicVacancyController = new PublicVacancyController();
const interviewSlotsController = new InterviewSlotsController();
const vacancyMeetLinksController = new VacancyMeetLinksController();
const vacancySocialLinksController = new VacancySocialLinksController();
const vacancyAddressReviewController = new VacancyAddressReviewController();
const publicJobsController = new PublicJobsController();
const workerContextController = new WorkerContextController();

const claimController = createClaimController();

// Messaging: shared instance with OutboxProcessor
const templateRepo = new MessageTemplateRepository();
const chatwootClient = buildChatwootClient();
const { messagingService, twilioMessagingService, periskopeMessagingService } =
  buildMessagingService(templateRepo, chatwootClient);
const outboxProcessor = new OutboxProcessor(messagingService, DatabaseConnection.getInstance().getPool());

// ========== Public Routes ==========
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// API docs (Swagger UI + spec). Em prod exige staff; em dev/test público.
app.use(
  '/api/docs',
  createSwaggerRouter({
    guards: shouldGateDocs() ? [authMiddleware.requireStaff()] : [],
  }),
);

createMockAuthEndpoints(app);

app.post('/api/workers/init', publicContextMiddleware('public:/api/workers/init'), (req: Request, res: Response) => {
  workerController.initWorker(req, res);
});

// Contexto público declarado por PREFIXO (não no `use('/api', ...)`, que rodaria
// para toda request /api/* antes de qualquer auth e mascararia caminho não
// classificado). Reivindicação de conta é pré-auth: o token vem no body.
app.use('/api/auth/claim', publicContextMiddleware('public:/api/auth/claim'));
app.use('/api/account-link/undo', publicContextMiddleware('public:/api/account-link/undo'));
app.use('/api', createClaimRoutes(claimController));

// Vínculo self-service de contas por colisão de telefone (ACCOUNT_LINK_ENABLED
// gate por request → OFF = 404 em tudo, prod neutro). openspec:
// vinculo-contas-colisao-telefone.
const accountLinkController = new AccountLinkController(DatabaseConnection.getInstance().getPool());
app.use('/api', createAccountLinkRoutes(accountLinkController, authMiddleware));

const workerLookupRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

app.get('/api/workers/lookup', workerLookupRateLimit, publicContextMiddleware('public:/api/workers/lookup'), (req: Request, res: Response) => {
  workerController.lookupByEmail(req, res);
});

app.get('/api/vacancies/:id', publicContextMiddleware('public:/api/vacancies/:id'), (req: Request, res: Response) => {
  publicVacancyController.getById(req, res);
});

app.get('/api/jobs', publicContextMiddleware('public:/api/jobs'), (req: Request, res: Response) => {
  jobsController.getJobs(req, res);
});

const publicJobsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

app.get('/api/public/v1/jobs', publicJobsRateLimit, publicContextMiddleware('public:/api/public/v1/jobs'), (req: Request, res: Response) => {
  publicJobsController.listActiveJobs(req, res);
});

// Public B2C patient intake (Task 1) — no staff auth, rate-limited like public jobs.
// CORS is handled by the global corsMiddleware (our own /admision page origin is allowed).
const publicLeadsController = new PublicLeadsController();
const publicLeadsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // write endpoint — tighter than the read-only jobs list
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

app.post('/api/public/v1/leads', publicLeadsRateLimit, publicContextMiddleware('public:/api/public/v1/leads'), (req: Request, res: Response) => {
  publicLeadsController.createLead(req, res);
});

// Public B2C admission scheduling (multi-country AR + BR) — no staff auth, rate-limited.
// Real notifier: immediate WhatsApp confirmation to the patient (direct Content
// API, no outbox — the patient is not a worker) + a 30-min-before reminder via
// Cloud Task. Injected in place of the default LoggingAdmissionNotifier.
const admissionNotifier = new RealAdmissionNotifier(
  twilioMessagingService,
  new CloudTasksClient(),
  DatabaseConnection.getInstance().getPool(),
);
const admissionSchedulingController = new AdmissionSchedulingController(
  new AdmissionSchedulingService(undefined, admissionNotifier),
);
const admissionSlotsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 30, // read endpoint
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});
const admissionBookRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10, // write endpoint — tighter
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

app.get('/api/public/v1/admission/slots', admissionSlotsRateLimit, publicContextMiddleware('public:/api/public/v1/admission/slots'), (req: Request, res: Response) => {
  admissionSchedulingController.getSlots(req, res);
});
app.post('/api/public/v1/admission/book', admissionBookRateLimit, publicContextMiddleware('public:/api/public/v1/admission/book'), (req: Request, res: Response) => {
  admissionSchedulingController.book(req, res);
});

// ========== Protected Worker Routes ==========
app.put('/api/workers/step', authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'update'), (req: Request, res: Response) => {
  workerController.saveStep(req, res);
});
app.get('/api/workers/me', authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'read'), (req: Request, res: Response) => {
  workerController.getProgress(req, res);
});
app.put('/api/workers/me/general-info', authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'update'), (req: Request, res: Response) => {
  workerController.saveGeneralInfo(req, res);
});
app.put('/api/workers/me/service-area', authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'update'), (req: Request, res: Response) => {
  workerController.saveServiceArea(req, res);
});
app.get('/api/workers/me/availability', authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'read'), (req: Request, res: Response) => {
  workerController.getAvailability(req, res);
});
app.put('/api/workers/me/availability', authMiddleware.requireAuth(), authMiddleware.requirePermission('worker', 'update'), (req: Request, res: Response) => {
  workerController.saveAvailability(req, res);
});

// ========== User Routes ==========
app.delete('/api/users/me', authMiddleware.requireAuth(), authMiddleware.requirePermission('user', 'delete'), (req: Request, res: Response) => {
  userController.deleteUser(req, res);
});
app.delete('/api/users/:userId', authMiddleware.requireAuth(), authMiddleware.requirePermission('user', 'admin_delete'), (req: Request, res: Response) => {
  userController.deleteUserById(req, res);
});

// ========== Service-to-Service Routes ==========
app.post('/api/internal/workers/webhook', authMiddleware.requireApiKey(), systemContextMiddleware('job:workers-webhook'), (req: Request, res: Response) => {
  res.status(200).json({ success: true, message: 'Webhook received' });
});

// ========== Worker Applications ==========
app.use('/api', createWorkerApplicationsRoutes(workerApplicationsController, authMiddleware));

// ========== Worker Documents (fixed + additional) ==========
app.use('/api', createWorkerDocumentsRoutes(
  workerDocumentsMeController, workerAdditionalDocsMeController,
  adminAdditionalDocsController, authMiddleware, permissionMiddleware,
));

// ========== Jobs refresh ==========
app.post('/api/jobs/refresh', authMiddleware.requireAuth(), (req: Request, res: Response) => {
  jobsController.refreshJobs(req, res);
});


// ========== Admin Module ==========
// Bootstrap sem auth por definição (cria o 1º admin). Além do guard interno
// (countAdmins() > 0 → 403), exige opt-in por env: o guard de count lê o banco,
// e uma role de runtime sob RLS que enxergasse 0 admins re-armaria a rota.
// Bootstrap sem auth: precisa CONTAR admins para se recusar (task 1.6). Sob RLS,
// sem contexto a contagem viria 0 e o bootstrap se RE-ARMARIA — por isso vai
// como sistema declarado, além do gate ADMIN_SETUP_ENABLED.
app.post('/api/admin/setup', systemContextMiddleware('bootstrap:admin-setup'), (req: Request, res: Response) => {
  if (process.env.ADMIN_SETUP_ENABLED !== 'true') {
    res.status(403).json({ success: false, error: 'Setup disabled' });
    return;
  }
  adminController.setup(req, res);
});
// Família `admin.users` — extraída para router próprio na task 3.5 (primeira a
// declarar célula). Ver modules/identity/interfaces/routes/adminUsersRoutes.ts.
app.use('/api/admin', createAdminUsersRoutes(adminController, authMiddleware, permissionMiddleware));
// NOTE: requireAuth (not requireAdmin) — auto-provisioning on first Google login.
app.get('/api/admin/auth/profile', authMiddleware.requireAuth(), (req: Request, res: Response) => {
  adminController.getProfile(req, res);
});
// Telemetria do login admin (frontend → servidor); rota modularizada.
app.use('/api', createAuthTelemetryRoutes(authMiddleware));

// ========== Worker Status & Encuadres ==========
app.use('/api', createWorkerEncuadreRoutes(encuadreController, authMiddleware));

// ========== Admin Workers & Worker Tags ==========
const staffOnly = authMiddleware.requireStaff();
app.use('/api/admin', createAdminWorkerRoutes({
  workers: adminWorkersController,
  aux: adminWorkersAuxController,
  testFlag: adminWorkerTestFlagController,
  profile: adminWorkerProfileController,
  serviceArea: adminWorkerServiceAreaController,
  tags: adminTagCatalogController,
  timeline: workerTimelineController,
}, authMiddleware, permissionMiddleware));

app.use('/api/admin', createAdminWorkerDocumentsRoutes(adminWorkerDocumentsController, authMiddleware, permissionMiddleware));

// ========== Admin Patients ==========
app.use(
  '/api/admin',
  createAdminPatientsRoutes(
    adminPatientsController,
    authMiddleware,
    permissionMiddleware,
    new AdminPatientChatIdsController(),
    new AdminPatientChatRolesController(),
  ),
);

// ========== Admin Dedup + Test Fixtures (extraído p/ bootstrap/) ==========
registerAdminMaintenanceRoutes(app, authMiddleware);

// ========== Admin Integrations (AnaCare mirror etc.) ==========
app.use('/api/admin', createAdminIntegrationsRoutes(authMiddleware));

// ========== Worker Context (triage-service / MCP internal) ==========
app.use('/api/admin', createWorkerContextRoutes(workerContextController, authMiddleware, permissionMiddleware));

// ========== Admin Vacancies (extracted router) ==========
app.use('/api/admin', createAdminVacanciesRoutes(
  vacanciesController,
  vacancyCrudController,
  vacancyTalentumController,
  vacancyMatchController,
  vacancyMeetLinksController,
  vacancySocialLinksController,
  funnelController,
  dashboardController,
  interviewSlotsController,
  authMiddleware,
  vacancyAddressReviewController,
  funnelTableController,
));

// ========== Analytics & BI (extracted router) ==========
app.use('/analytics', createAnalyticsRoutes(analyticsController, authMiddleware));

// ========== Recruitment (extracted router) ==========
app.use('/api', createRecruitmentRoutes(recruitmentController, authMiddleware));

// ========== Messaging Routes ==========
app.use('/api/admin/messaging', authMiddleware.requireStaff(), createMessagingRoutes(messagingService, templateRepo));

// ========== Internal Routes (Pub/Sub, Cloud Tasks, Cloud Scheduler) ==========
const dbPool = DatabaseConnection.getInstance().getPool();
const cloudTasksClient = new CloudTasksClient();
const pubsubClient = new PubSubClient();
const tokenService = new TokenService(dbPool);
const domainEventProcessor = new DomainEventProcessor(dbPool);

domainEventProcessor.registerHandler(
  'funnel_stage.qualified',
  createQualifiedInterviewHandler(dbPool, pubsubClient, tokenService),
);

domainEventProcessor.registerHandler(
  'vacancy.created',
  createVacancyAutoInviteHandler(dbPool, cloudTasksClient),
);

domainEventProcessor.registerHandler(
  'worker.mirror_requested',
  createAnaCareMirrorHandler(),
);

domainEventProcessor.registerHandler(
  'worker.registration_completed',
  createPromoteBlockedApplicationsHandler(dbPool),
);

const reminderScheduler = new ReminderScheduler(dbPool, cloudTasksClient, pubsubClient, tokenService);
const bulkDispatchScheduler = new BulkDispatchScheduler(dbPool, messagingService);
const bulkDispatchTalentumScheduler = new BulkDispatchTalentumScheduler(dbPool, messagingService);
const recruitmentHealthController = new RecruitmentHealthController(dbPool);
const domainEventBacklogService = new DomainEventBacklogService(dbPool);
const anaCareMirrorHealthService = new AnaCareMirrorHealthService(dbPool);
const internalController = new InternalController(domainEventProcessor, outboxProcessor, reminderScheduler, bulkDispatchScheduler, bulkDispatchTalentumScheduler, domainEventBacklogService, anaCareMirrorHealthService);
app.use('/api/internal', systemContextMiddleware('job:internal'), createInternalRoutes(internalController));

// Cloud Tasks: 30-min-before admission reminder (queue: admission-reminders).
// Kept on the app (not the notification router) to avoid a notification→matching
// import; guarded by the same internalAuthMiddleware (X-Internal-Secret).
const admissionReminderController = new AdmissionReminderController(
  new AdmissionReminderService(twilioMessagingService, dbPool),
);
app.post('/api/internal/reminders/admission-30min', internalAuthMiddleware, systemContextMiddleware('job:admission-reminder'), (req: Request, res: Response) =>
  admissionReminderController.handle(req, res),
);

// ========== Recruitment Health Dashboard ==========
app.get('/api/admin/recruitment/health', staffOnly, (req: Request, res: Response) =>
  recruitmentHealthController.getHealth(req, res),
);

// ========== Permissões (painel de grupos, grupo 2) ==========
// Neutro por padrão: registra os handlers de invalidação de cache, publica o
// catálogo em /.well-known (guard interno) e mede staff sem grupo. Os syncs que
// ESCREVEM no banco são gated (ver wirePermissionsModule).
wirePermissionsModule({
  app,
  boundary: permissionsBoundary,
  events: domainEventProcessor,
  internalGuard: internalAuthMiddleware,
});

// ========== MCP Server (feature-gated via MCP_ENABLED=true) ==========
if (process.env.MCP_ENABLED === 'true') {
  const { mountMcpRoutes } = require('@modules/mcp/bootstrap/mountMcpRoutes') as typeof import('@modules/mcp/bootstrap/mountMcpRoutes');
  mountMcpRoutes(app, dbPool);
}

// ========== Webhooks + Server start (async: ClickUp controller init) ==========
// Logic extracted to src/bootstrap/startServer.ts (line-limit compliance).
// `.catch` explícito: o boot valida a membership de app_runtime/app_system
// quando COUNTRY_RLS_ENABLED=true (ver assertDbRoleMembership). Falhou, o
// processo MORRE — servir com RLS sem grant é servir tela vazia calada, e a
// revisão anterior do Cloud Run continua atendendo enquanto esta não sobe.
startServer(app, useCerbos, { twilioMessagingService, periskopeMessagingService }, {
  // ANTES do listen e com TODAS as rotas montadas: varre o router, publica o
  // índice do guard e sincroniza o catálogo. Lança em UM caso só — engine
  // ligado com a migração de dados não marcada em `iam.rollout_state` —, e aí o
  // processo MORRE de propósito e a revisão anterior do Cloud Run segue
  // servindo. Qualquer outra falha aqui é logada e o boot segue: derrubar
  // worker-functions por causa do painel tiraria do ar app do prestador, leads
  // e webhooks (lex C2).
  beforeListen: () => runPermissionsBootTasks(app, permissionsBoundary),
})
  .catch((err) => {
    console.error('[startup] falha fatal ao subir o servidor:', err);
    process.exit(1);
  });

export { app };
