// ── Domain ───────────────────────────────────────────────────────
export * from './domain/Encuadre';
export * from './domain/TalentumPrescreening';
export * from './domain/WorkerJobApplication';
export * from './domain/WorkerOccupation';
export * from './domain/WorkerLocation';
export * from './domain/FunnelTableRow';

// ── Infrastructure ───────────────────────────────────────────────
export { FunnelTableRepository } from './infrastructure/FunnelTableRepository';
export { EncuadreRepository } from './infrastructure/EncuadreRepository';
export { EncuadreQueryRepository } from './infrastructure/EncuadreQueryRepository';
export * from './infrastructure/EncuadreMappers';
export { TalentumPrescreeningRepository } from './infrastructure/TalentumPrescreeningRepository';
export { WorkerApplicationRepository } from './infrastructure/WorkerApplicationRepository';
export { WorkerLocationRepository } from './infrastructure/WorkerLocationRepository';
export { JobPostingARRepository } from './infrastructure/JobPostingARRepository';
export { MatchmakingService } from './infrastructure/MatchmakingService';
export { GoogleCalendarService, googleCalendarService } from './infrastructure/GoogleCalendarService';

// ── Application ──────────────────────────────────────────────────
export { GetFunnelTableUseCase } from './application/GetFunnelTableUseCase';
export { UpdateEncuadreResultUseCase } from './application/UpdateEncuadreResultUseCase';
export { ScheduleInterviewsUseCase } from './application/ScheduleInterviewsUseCase';
export { ProcessTalentumPrescreening } from './application/ProcessTalentumPrescreening';
export type { IJobPostingLookup } from './application/ProcessTalentumPrescreening';

// ── Interface — Controllers ──────────────────────────────────────
export { EncuadreController } from './interfaces/controllers/EncuadreController';
export * from './interfaces/controllers/EncuadreControllerHelpers';
export { EncuadreFunnelController } from './interfaces/controllers/EncuadreFunnelController';
export { EncuadreFunnelTableController } from './interfaces/controllers/EncuadreFunnelTableController';
export { EncuadreDashboardController } from './interfaces/controllers/EncuadreDashboardController';
export { VacanciesController } from './interfaces/controllers/VacanciesController';
export { VacancyMatchController } from './interfaces/controllers/VacancyMatchController';
export { VacancyMeetLinksController } from './interfaces/controllers/VacancyMeetLinksController';
export { VacancyTalentumController } from './interfaces/controllers/VacancyTalentumController';
export { TalentumWebhookController } from './interfaces/controllers/TalentumWebhookController';
export { AnalyticsController } from './interfaces/controllers/AnalyticsController';
export { AnalyticsDashboardController } from './interfaces/controllers/AnalyticsDashboardController';
export { InterviewSlotsController } from './interfaces/controllers/InterviewSlotsController';
export { PublicVacancyController } from './interfaces/controllers/PublicVacancyController';
export { RecruitmentAnalyticsController } from './interfaces/controllers/RecruitmentAnalyticsController';
export { RecruitmentController } from './interfaces/controllers/RecruitmentController';
export { VacancyCrudController } from './interfaces/controllers/VacancyCrudController';
export { VacancyAddressReviewController } from './interfaces/controllers/VacancyAddressReviewController';
export { VacancySocialLinksController } from './interfaces/controllers/VacancySocialLinksController';
export { WorkerApplicationsController } from './interfaces/controllers/WorkerApplicationsController';

export { PublicJobsController } from './interfaces/controllers/PublicJobsController';
export { ListActivePublicJobsUseCase } from './application/ListActivePublicJobsUseCase';
export { EnsureVacancyShortLinkUseCase } from './application/EnsureVacancyShortLinkUseCase';
export { ShortIoClient } from './infrastructure/shortlinks/ShortIoClient';
export { ShortLinkService } from './infrastructure/shortlinks/ShortLinkService';
export { mapPublicJobRow } from './infrastructure/PublicJobMapper';
export type { PublicJobDto, PublicJobRow } from './domain/PublicJobDto';

// ── Interface — Routes ───────────────────────────────────────────
export { createAdminVacanciesRoutes } from './interfaces/routes/adminVacanciesRoutes';
export { createWorkerEncuadreRoutes } from './interfaces/routes/workerEncuadreRoutes';
export { default as talentumRoutes } from './interfaces/routes/talentumRoutes';
export { createAnalyticsRoutes } from './interfaces/routes/analyticsRoutes';
export { createRecruitmentRoutes } from './interfaces/routes/recruitmentRoutes';
export { createWorkerApplicationsRoutes } from './interfaces/routes/workerApplicationsRoutes';
