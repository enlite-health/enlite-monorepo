/**
 * integration module — barrel export.
 * External code MUST import only from this file.
 */

// Domain
export type { WebhookPartner, PartnerContext } from './domain/WebhookPartner';
export type { ITalentumApiClient, TalentumQuestion, TalentumFaq, TalentumProject, TalentumQuestionWithId, TalentumDashboardProfile, TalentumDashboardResponse, CreatePrescreeningInput, CreatePrescreeningResult, ListPrescreeningsOpts } from './domain/ITalentumApiClient';

// Ports
export type { IWebhookPartnerRepository } from './ports/IWebhookPartnerRepository';

// Infrastructure
export { WebhookPartnerRepository } from './infrastructure/WebhookPartnerRepository';
export { TalentumApiClient } from './infrastructure/TalentumApiClient';
export { TalentumDescriptionService } from './infrastructure/TalentumDescriptionService';
export type { GenerateDescriptionInput, GeneratedDescription } from './infrastructure/TalentumDescriptionService';
export { GeminiVacancyParserService } from './infrastructure/GeminiVacancyParserService';
export type { ParsedVacancyResult, WorkerType } from './infrastructure/GeminiVacancyParserService';
export {
  parseFromTalentumDescriptionHelper,
  detectMissingFields,
  retryMissingFields,
} from './infrastructure/GeminiVacancyParserHelpers';
export { GoogleApiKeyValidator } from './infrastructure/GoogleApiKeyValidator';
export { GoogleDocsPromptProvider } from './infrastructure/GoogleDocsPromptProvider';
export { ClickUpFieldResolver } from './infrastructure/clickup/ClickUpFieldResolver';
export type { ClickUpFieldResolverOptions } from './infrastructure/clickup/ClickUpFieldResolver';
export type { ClickUpTask, ClickUpTaskCustomField } from './infrastructure/clickup/ClickUpTask';
export { ClickUpPatientMapper } from './infrastructure/clickup/ClickUpPatientMapper';
export { ClickUpEncuadreMapper, parseCaseNumbersFromName } from './infrastructure/clickup/ClickUpEncuadreMapper';
export type { EncuadreMapperEntry, EncuadreWorkerData, EncuadreData } from './infrastructure/clickup/ClickUpEncuadreMapper';

// Application — use cases
export { PublishVacancyToTalentumUseCase, PublishError } from './application/PublishVacancyToTalentumUseCase';
export { SyncTalentumVacanciesUseCase } from './application/SyncTalentumVacanciesUseCase';
export type { SyncReport } from './application/SyncTalentumVacanciesUseCase';
export { SyncTalentumWorkersUseCase } from './application/SyncTalentumWorkersUseCase';
export type { WorkerSyncReport } from './application/SyncTalentumWorkersUseCase';
export { CreateJobPostingFromTalentumUseCase } from './application/CreateJobPostingFromTalentumUseCase';
export type { CreateJobPostingFromTalentumInput, CreateJobPostingFromTalentumResult } from './application/CreateJobPostingFromTalentumUseCase';

// Interfaces / Webhooks
export { TalentumWebhookController } from './interfaces/webhooks/controllers/TalentumWebhookController';
export { PartnerAuthMiddleware } from './interfaces/webhooks/middleware/PartnerAuthMiddleware';
export { createWebhookRoutes } from './interfaces/webhooks/routes/webhookRoutes';
export { TalentumPrescreeningPayloadSchema } from './interfaces/webhooks/validators/talentumPrescreeningSchema';
export type { TalentumPrescreeningPayloadInput, TalentumPrescreeningPayloadParsed, TalentumPrescreeningCreatedParsed, TalentumPrescreeningResponseParsed } from './interfaces/webhooks/validators/talentumPrescreeningSchema';
