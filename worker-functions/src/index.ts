// ── Global error handlers (must be registered before any other code) ──────────
// Prevents unhandled promise rejections (e.g. google-auth-library background
// retries in environments without ADC) from crashing the process.
// In production these are logged; orchestrators (Cloud Run) handle restarts.
process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
  console.error('[UnhandledRejection]', reason);
});

process.on('uncaughtException', (err: Error) => {
  console.error('[UncaughtException]', err);
});

import express, { Request, Response } from 'express';
import cors from 'cors';
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
import { EncuadreController, VacanciesController, VacancyTalentumController, VacancyMatchController, EncuadreFunnelController, EncuadreFunnelTableController, EncuadreDashboardController, AnalyticsController, RecruitmentController, VacancyCrudController, PublicVacancyController, WorkerApplicationsController, VacancyAddressReviewController, PublicJobsController } from '@modules/matching';
import { AdminWorkersController } from '@modules/worker';
import { AdminWorkersAuxController } from './modules/worker/interfaces/controllers/AdminWorkersAuxController';
import { MessageTemplateRepository } from '@modules/notification/infrastructure/MessageTemplateRepository';
import { TwilioMessagingService } from '@modules/notification/infrastructure/TwilioMessagingService';
import { OutboxProcessor } from '@modules/notification/infrastructure/OutboxProcessor';
import { BulkDispatchScheduler } from '@modules/notification/infrastructure/BulkDispatchScheduler';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { createWebhookRoutes, PartnerAuthMiddleware, GoogleApiKeyValidator, WebhookPartnerRepository } from '@modules/integration';
import { createMessagingRoutes } from '@modules/notification/interfaces/routes/messagingRoutes';
import { createAnalyticsRoutes, createRecruitmentRoutes, createWorkerApplicationsRoutes, createAdminVacanciesRoutes, createWorkerEncuadreRoutes, InterviewSlotsController, VacancySocialLinksController } from '@modules/matching';
import { ReminderScheduler } from '@modules/notification/infrastructure/ReminderScheduler';
import { VacancyMeetLinksController } from '@modules/matching';
import { DomainEventProcessor } from '@shared/events/DomainEventProcessor';
import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import { PubSubClient } from '@shared/events/PubSubClient';
import { createQualifiedInterviewHandler } from '@shared/events/handlers/QualifiedInterviewHandler';
import { TokenService } from '@modules/notification/infrastructure/TokenService';
import { InternalController } from '@modules/notification/interfaces/controllers/InternalController';
import { createInternalRoutes } from '@modules/notification/interfaces/routes/internalRoutes';
import { BookSlotFromWhatsAppUseCase } from '@modules/notification/application/BookSlotFromWhatsAppUseCase';
import { HandleReminderResponseUseCase } from '@modules/notification/application/HandleReminderResponseUseCase';
import { InboundWhatsAppController } from '@modules/notification/interfaces/controllers/InboundWhatsAppController';
import { GoogleCalendarService } from '@modules/matching';

const app = express();

// CORS configuration
const allowedOrigins = [
  'https://enlite-frontend-121472682203.southamerica-west1.run.app',
  'https://app.enlite.health',
  'https://enlite-n8n-121472682203.southamerica-west1.run.app',
  'https://n8n.enlite.health',
  'http://localhost:3000', // Local development
  'http://localhost:5173', // Vite default port
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Partner-Key'],
}));

app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));


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
const funnelController = new EncuadreFunnelController();
const funnelTableController = new EncuadreFunnelTableController();
const dashboardController = new EncuadreDashboardController();
const workerApplicationsController = new WorkerApplicationsController();
const adminWorkersController = new AdminWorkersController();
const adminWorkersAuxController = new AdminWorkersAuxController();
const adminPatientsController = new AdminPatientsController();
const publicVacancyController = new PublicVacancyController();
const interviewSlotsController = new InterviewSlotsController();
const vacancyMeetLinksController = new VacancyMeetLinksController();
const vacancySocialLinksController = new VacancySocialLinksController();
const vacancyAddressReviewController = new VacancyAddressReviewController();
const publicJobsController = new PublicJobsController();

// Messaging: shared instance with OutboxProcessor
const templateRepo = new MessageTemplateRepository();
const messagingService = new TwilioMessagingService(templateRepo);
const outboxProcessor = new OutboxProcessor(messagingService, DatabaseConnection.getInstance().getPool());

// ========== Public Routes ==========
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

createMockAuthEndpoints(app);

app.post('/api/workers/init', (req: Request, res: Response) => {
  workerController.initWorker(req, res);
});

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

// ========== Admin Workers ==========
const staffOnly = authMiddleware.requireStaff();
const adminOnly = authMiddleware.requireAdmin();
app.get('/api/admin/workers/stats', staffOnly, (req: Request, res: Response) => adminWorkersAuxController.getWorkerDateStats(req, res));
app.get('/api/admin/workers/by-phone', staffOnly, (req: Request, res: Response) => adminWorkersController.getWorkerByPhone(req, res));
app.get('/api/admin/workers/case-options', staffOnly, (req: Request, res: Response) => adminWorkersAuxController.listCaseOptions(req, res));
app.post('/api/admin/workers/sync-talentum', staffOnly, (req: Request, res: Response) => adminWorkersAuxController.syncTalentumWorkers(req, res));
// export MUST be registered before /:id to avoid param capture
app.get('/api/admin/workers/export', adminOnly, (req: Request, res: Response) => adminWorkersController.exportWorkers(req, res));
app.get('/api/admin/workers/:id', staffOnly, (req: Request, res: Response) => adminWorkersController.getWorkerById(req, res));
app.get('/api/admin/workers', staffOnly, (req: Request, res: Response) => adminWorkersController.listWorkers(req, res));

app.use('/api/admin', createAdminWorkerDocumentsRoutes(adminWorkerDocumentsController, authMiddleware));

// ========== Admin Patients ==========
app.use('/api/admin', createAdminPatientsRoutes(adminPatientsController, authMiddleware));

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

// ========== Webhooks — Partner Auth ==========
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

app.use('/api/webhooks', createWebhookRoutes(partnerAuth, inboundWhatsAppController));
app.use('/api/webhooks-test', createWebhookRoutes(partnerAuth, inboundWhatsAppController));

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

const reminderScheduler = new ReminderScheduler(dbPool, cloudTasksClient, pubsubClient, tokenService);
const bulkDispatchScheduler = new BulkDispatchScheduler(dbPool, messagingService);
const internalController = new InternalController(domainEventProcessor, outboxProcessor, reminderScheduler, bulkDispatchScheduler);
app.use('/api/internal', createInternalRoutes(internalController));

// ========== Start Server ==========
const PORT = process.env.PORT || 8080;

console.log('[EventDriven] Services wired — no polling timers');

const server = app.listen(PORT, () => {
  console.log(`Enlite Backend running on port ${PORT}`);
  console.log(`Authorization engine: ${useCerbos ? 'Cerbos' : 'Local'}`);
});

server.timeout = 300000; // 5 minutos
server.keepAliveTimeout = 310000;
server.headersTimeout = 320000;
export { app };
