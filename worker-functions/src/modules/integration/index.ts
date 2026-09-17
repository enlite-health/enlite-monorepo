/**
 * integration module — barrel export.
 * External code MUST import only from this file.
 */

// Domain
export type { WebhookPartner, PartnerContext } from './domain/WebhookPartner';
export type { ITalentumApiClient, TalentumQuestion, TalentumFaq, TalentumProject, TalentumQuestionWithId, TalentumDashboardProfile, TalentumDashboardResponse, CreatePrescreeningInput, CreatePrescreeningResult, ListPrescreeningsOpts } from './domain/ITalentumApiClient';
export type { WorkerMirrorRecord, WorkerMirrorAddress } from './domain/WorkerMirrorRecord';
export type { WorkerMirrorProvider, WorkerMirrorUpsertResult } from './domain/WorkerMirrorProvider';
export type { IAnaCareApiClient, AnaCareNursePayload, AnaCareNurse, AnaCareNurseType, AnaCareHiringType, AnaCarePagedResponse, AnaCareNurseBulkItem, AnaCareNurseBulkPayload } from './domain/IAnaCareApiClient';

// Ports
export type { IWebhookPartnerRepository } from './ports/IWebhookPartnerRepository';

// Infrastructure
export { WebhookPartnerRepository } from './infrastructure/WebhookPartnerRepository';
export { TalentumApiClient } from './infrastructure/TalentumApiClient';
export { TalentumDescriptionService } from './infrastructure/TalentumDescriptionService';
export type { GenerateDescriptionInput, GeneratedDescription } from './infrastructure/TalentumDescriptionService';
export { GeminiVacancyParserService } from './infrastructure/GeminiVacancyParserService';
export type { ParsedVacancyResult, WorkerType } from './infrastructure/GeminiVacancyParserService';
export { GeminiApiError } from './infrastructure/gemini-fetch';
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
// Location extraction — reused by the Fase 1 patient-address backfill script
// (case module) so backfilled rows and newly-synced ClickUp rows never diverge.
export {
  extractStateFromLocationStrict,
  extractCityFromLocationStrict,
  extractNeighborhoodFromLocation,
} from './infrastructure/clickup/helpers/locationHelpers';

// Infrastructure — AnaCare
export { AnaCareClient } from './infrastructure/anacare/AnaCareClient';
export { AnaCareMirrorProvider, AnaCareLinkBlockedError } from './infrastructure/anacare/AnaCareMirrorProvider';
export type { AnaCareMirrorProviderDeps, AnaCareLinkBlockedReason } from './infrastructure/anacare/AnaCareMirrorProvider';
export { AnaCareTypeResolver } from './infrastructure/anacare/anaCareTypeResolver';
export type { ResolvedTypes } from './infrastructure/anacare/anaCareTypeResolver';
export { mapWorkerToAnaCarePayload, mapSexToAnaCareGenero, formatDateYMD } from './infrastructure/anacare/anaCareMapper';
export { AnaCareSessionClient, ANACARE_ENLITE_AGENCY_ID } from './infrastructure/anacare/AnaCareSessionClient';
export type { AnaCareSessionClientOptions } from './infrastructure/anacare/AnaCareSessionClient';
export { AnaCareShiftsSourceReal } from './infrastructure/anacare/AnaCareShiftsSourceReal';
export { AnaCareEnliteDirectory, AnaCareEnliteDirectoryError } from './infrastructure/anacare/AnaCareEnliteDirectory';
export type { EnliteDirectoryEntry, EnliteDirectory } from './infrastructure/anacare/AnaCareEnliteDirectory';

// Application — use cases
export { PublishVacancyToTalentumUseCase, PublishError } from './application/PublishVacancyToTalentumUseCase';
export type { AuditActor } from './application/PublishVacancyToTalentumUseCase';
export { SyncTalentumVacanciesUseCase } from './application/SyncTalentumVacanciesUseCase';
export type { SyncReport } from './application/SyncTalentumVacanciesUseCase';
export { UpdateTalentumDescriptionUseCase, UpdateDescriptionError } from './application/UpdateTalentumDescriptionUseCase';
export { SyncTalentumWorkersUseCase } from './application/SyncTalentumWorkersUseCase';
export type { WorkerSyncReport } from './application/SyncTalentumWorkersUseCase';
export { CreateJobPostingFromTalentumUseCase } from './application/CreateJobPostingFromTalentumUseCase';
export type { CreateJobPostingFromTalentumInput, CreateJobPostingFromTalentumResult } from './application/CreateJobPostingFromTalentumUseCase';
export { BackfillWorkerMirrorUseCase } from './application/BackfillWorkerMirrorUseCase';
export type { BackfillOptions, BackfillSummary } from './application/BackfillWorkerMirrorUseCase';
export { MirrorWorkerService, isAnaCareIdClaimed } from './application/MirrorWorkerService';
export type { MirrorResult } from './application/MirrorWorkerService';
export { createAnaCareMirrorHandler } from './application/AnaCareMirrorEventHandler';
export type { AnaCareMirrorHandlerDeps } from './application/AnaCareMirrorEventHandler';

// Interfaces / Webhooks
export { TalentumWebhookController } from './interfaces/webhooks/controllers/TalentumWebhookController';
export { PartnerAuthMiddleware } from './interfaces/webhooks/middleware/PartnerAuthMiddleware';
export { createWebhookRoutes } from './interfaces/webhooks/routes/webhookRoutes';
export { createAdminIntegrationsRoutes } from './interfaces/routes/adminIntegrationsRoutes';
export { AnaCareBackfillController } from './interfaces/controllers/AnaCareBackfillController';
export { TalentumPrescreeningPayloadSchema } from './interfaces/webhooks/validators/talentumPrescreeningSchema';
export type { TalentumPrescreeningPayloadInput, TalentumPrescreeningPayloadParsed, TalentumPrescreeningCreatedParsed, TalentumPrescreeningResponseParsed } from './interfaces/webhooks/validators/talentumPrescreeningSchema';
