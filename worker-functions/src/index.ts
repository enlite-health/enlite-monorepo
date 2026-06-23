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
import { AdminPatientsController, createAdminPatientsRoutes } from '@modules/case';
import { UserController } from '@modules/identity';
import { AdminController } from '@modules/identity';
import {
  AuthMiddleware,
  MultiAuthService,
  SimplifiedAuthorizationEngine,
  CerbosAuthorizationAdapter,
  mockAuthMiddleware,
  createMockAuthEndpoints,
} from '@modules/identity';
import { EncuadreController, VacanciesController, VacancyTalentumController, VacancyMatchController, WJAFunnelController, WJAFunnelTableController, EncuadreDashboardController, AnalyticsController, RecruitmentController, VacancyCrudController, PublicVacancyController, WorkerApplicationsController, VacancyAddressReviewController, PublicJobsController } from '@modules/matching';
import { AdminWorkersController, AdminWorkerTestFlagController, AdminWorkerProfileController, AdminWorkerServiceAreaController, createAdminWorkerRoutes } from '@modules/worker';
import { AdminWorkersAuxController } from './modules/worker/interfaces/controllers/AdminWorkersAuxController';
import { AdminTagCatalogController } from './modules/worker/interfaces/controllers/AdminTagCatalogController';
import { WorkerTimelineController } from './modules/worker/interfaces/controllers/WorkerTimelineController';
import { MessageTemplateRepository } from '@modules/notification/infrastructure/MessageTemplateRepository';
import { TwilioMessagingService } from '@modules/notification/infrastructure/TwilioMessagingService';
import { ChatwootClient } from '@modules/notification/infrastructure/ChatwootClient';
import { OutboxProcessor } from '@modules/notification/infrastructure/OutboxProcessor';
import { BulkDispatchScheduler } from '@modules/notification/infrastructure/BulkDispatchScheduler';
import { BulkDispatchTalentumScheduler } from '@modules/notification/infrastructure/BulkDispatchTalentumScheduler';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { createMessagingRoutes } from '@modules/notification/interfaces/routes/messagingRoutes';
import { correlationMiddleware } from './shared/logging/correlationMiddleware';
import { startServer } from './bootstrap/startServer';
import { createAnalyticsRoutes, createRecruitmentRoutes, createWorkerApplicationsRoutes, createAdminVacanciesRoutes, createWorkerEncuadreRoutes, InterviewSlotsController, VacancySocialLinksController } from '@modules/matching';
import { WorkerContextController } from '@modules/matching/interfaces/controllers/WorkerContextController';
import { createWorkerContextRoutes } from '@modules/matching/interfaces/routes/workerContextRoutes';
import { ReminderScheduler } from '@modules/notification/infrastructure/ReminderScheduler';
import { VacancyMeetLinksController } from '@modules/matching';
import { DomainEventProcessor } from '@shared/events/DomainEventProcessor';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { PubSubClient } from '@shared/events/PubSubClient';
import { createQualifiedInterviewHandler } from '@shared/events/handlers/QualifiedInterviewHandler';
import { createVacancyAutoInviteHandler } from '@shared/events/handlers/VacancyAutoInviteHandler';
import { TokenService } from '@modules/notification/infrastructure/TokenService';
import { InternalController } from '@modules/notification/interfaces/controllers/InternalController';
import { createInternalRoutes } from '@modules/notification/interfaces/routes/internalRoutes';
import { RecruitmentHealthController } from '@modules/notification/interfaces/controllers/RecruitmentHealthController';
import { createSwaggerRouter, shouldGateDocs } from '@shared/openapi/swaggerRouter';
import { createClaimController } from './bootstrap/createClaimController';
import { createClaimRoutes } from '@modules/auth/interfaces/routes/claimRoutes';
import { AdminDedupController } from './interfaces/controllers/dedup/AdminDedupController';
import { createDedupRoutes } from './interfaces/routes/dedupRoutes';

const app = express();

// CORS — origens default + CORS_ALLOWED_ORIGINS (CSV). Ver shared/http/corsConfig.
app.use(corsMiddleware());

app.use(express.json({
  limit: '60mb',
  verify: (req, _res, buf) => {
    if (req.url?.startsWith('/api/webhooks/clickup')) {
      (req as Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    }
  },
}));
app.use(express.urlencoded({ limit: '60mb', extended: true }));

// Correlation ID: extracts X-Cloud-Trace-Context or generates UUID.
// Must run before any auth/business middleware.
app.use(correlationMiddleware);

app.use(mockAuthMiddleware);

// ── Auth services ─────────────────────────────────────────────────────────────
const authService = new MultiAuthService({
  enableApiKeys: true,
  enableJwt: false,
  enableGoogleIdToken: true,
  googleClientId: process.env.GOOGLE_CLIENT_ID,
  internalTokenSecret: process.env.INTERNAL_TOKEN_SECRET,
}, DatabaseConnection.getInstance().getPool());

const useCerbos = process.env.USE_CERBOS === 'true';
const authzEngine = useCerbos && process.env.CERBOS_ENDPOINT
  ? new CerbosAuthorizationAdapter({
      cerbosEndpoint: process.env.CERBOS_ENDPOINT,
      playgroundEnabled: process.env.NODE_ENV === 'development',
    })
  : new SimplifiedAuthorizationEngine();

const authMiddleware = new AuthMiddleware(authService, authzEngine);

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
const adminDedupController = new AdminDedupController();

// Messaging: shared instance with OutboxProcessor
const templateRepo = new MessageTemplateRepository();
const chatwootClient = buildChatwootClient();
const messagingService = new TwilioMessagingService(templateRepo, chatwootClient);
const outboxProcessor = new OutboxProcessor(messagingService, DatabaseConnection.getInstance().getPool());

function buildChatwootClient(): ChatwootClient | null {
  if (process.env.CHATWOOT_MIRROR_ENABLED !== 'true') return null;
  const baseUrl = process.env.CHATWOOT_URL;
  const apiToken = process.env.CHATWOOT_API_TOKEN;
  const accountId = Number(process.env.CHATWOOT_ACCOUNT_ID || '1');
  const inboxId = Number(process.env.CHATWOOT_TWILIO_INBOX_ID || '1');
  if (!baseUrl || !apiToken) {
    console.warn('[Chatwoot] MIRROR_ENABLED=true mas CHATWOOT_URL/CHATWOOT_API_TOKEN ausentes — espelho desabilitado.');
    return null;
  }
  console.log(`[Chatwoot] Espelho de outbound habilitado (account=${accountId}, inbox=${inboxId})`);
  return new ChatwootClient({ baseUrl, apiToken, accountId, inboxId });
}

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

app.post('/api/workers/init', (req: Request, res: Response) => {
  workerController.initWorker(req, res);
});

app.use('/api', createClaimRoutes(claimController));

const workerLookupRateLimit = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

app.get('/api/workers/lookup', workerLookupRateLimit, (req: Request, res: Response) => {
  workerController.lookupByEmail(req, res);
});

app.get('/api/vacancies/:id', (req: Request, res: Response) => {
  publicVacancyController.getById(req, res);
});

app.get('/api/jobs', (req: Request, res: Response) => {
  jobsController.getJobs(req, res);
});

const publicJobsRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests' },
});

app.get('/api/public/v1/jobs', publicJobsRateLimit, (req: Request, res: Response) => {
  publicJobsController.listActiveJobs(req, res);
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
app.post('/api/internal/workers/webhook', authMiddleware.requireApiKey(), (req: Request, res: Response) => {
  res.status(200).json({ success: true, message: 'Webhook received' });
});

// ========== Worker Applications ==========
app.use('/api', createWorkerApplicationsRoutes(workerApplicationsController, authMiddleware));

// ========== Worker Documents (fixed + additional) ==========
app.use('/api', createWorkerDocumentsRoutes(
  workerDocumentsMeController, workerAdditionalDocsMeController,
  adminAdditionalDocsController, authMiddleware,
));

// ========== Jobs refresh ==========
app.post('/api/jobs/refresh', authMiddleware.requireAuth(), (req: Request, res: Response) => {
  jobsController.refreshJobs(req, res);
});


// ========== Admin Module ==========
app.post('/api/admin/setup', (req: Request, res: Response) => {
  adminController.setup(req, res);
});
app.post('/api/admin/users', authMiddleware.requireAdmin(), (req: Request, res: Response) => {
  adminController.createAdminUser(req, res);
});
app.get('/api/admin/users', authMiddleware.requireStaff(), (req: Request, res: Response) => {
  adminController.listAdminUsers(req, res);
});
app.delete('/api/admin/users/:id', authMiddleware.requireAdmin(), (req: Request, res: Response) => {
  adminController.deleteAdminUser(req, res);
});
app.post('/api/admin/users/:id/reset-password', authMiddleware.requireAdmin(), (req: Request, res: Response) => {
  adminController.resetAdminPassword(req, res);
});
app.patch('/api/admin/users/:id/role', authMiddleware.requireAdmin(), (req: Request, res: Response) => {
  adminController.updateAdminRole(req, res);
});
app.delete('/api/admin/users/by-email', authMiddleware.requireAdmin(), (req: Request, res: Response) => {
  adminController.deleteUserByEmail(req, res);
});
// NOTE: requireAuth (not requireAdmin) — auto-provisioning on first Google login.
app.get('/api/admin/auth/profile', authMiddleware.requireAuth(), (req: Request, res: Response) => {
  adminController.getProfile(req, res);
});

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
}, authMiddleware));

app.use('/api/admin', createAdminWorkerDocumentsRoutes(adminWorkerDocumentsController, authMiddleware));

// ========== Admin Patients ==========
app.use('/api/admin', createAdminPatientsRoutes(adminPatientsController, authMiddleware));

// ========== Admin Dedup (Centro de Duplicados) ==========
app.use('/api/admin/dedup', createDedupRoutes(adminDedupController, authMiddleware));

// ========== Worker Context (triage-service / MCP internal) ==========
app.use('/api/admin', createWorkerContextRoutes(workerContextController, authMiddleware));

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

const reminderScheduler = new ReminderScheduler(dbPool, cloudTasksClient, pubsubClient, tokenService);
const bulkDispatchScheduler = new BulkDispatchScheduler(dbPool, messagingService);
const bulkDispatchTalentumScheduler = new BulkDispatchTalentumScheduler(dbPool, messagingService);
const recruitmentHealthController = new RecruitmentHealthController(dbPool);
const internalController = new InternalController(domainEventProcessor, outboxProcessor, reminderScheduler, bulkDispatchScheduler, bulkDispatchTalentumScheduler);
app.use('/api/internal', createInternalRoutes(internalController));

// ========== Recruitment Health Dashboard ==========
app.get('/api/admin/recruitment/health', staffOnly, (req: Request, res: Response) =>
  recruitmentHealthController.getHealth(req, res),
);

// ========== MCP Server (feature-gated via MCP_ENABLED=true) ==========
if (process.env.MCP_ENABLED === 'true') {
  const { mountMcpRoutes } = require('@modules/mcp/bootstrap/mountMcpRoutes') as typeof import('@modules/mcp/bootstrap/mountMcpRoutes');
  mountMcpRoutes(app, dbPool);
}

// ========== Webhooks + Server start (async: ClickUp controller init) ==========
// Logic extracted to src/bootstrap/startServer.ts (line-limit compliance).
startServer(app, useCerbos);

export { app };
