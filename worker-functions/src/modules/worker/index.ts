/**
 * @modules/worker — barrel export
 *
 * Exposes the public API of the worker module.
 * External code must import ONLY from this barrel, never from internal paths.
 */

// ── Domain (types only) ─────────────────────────────────────────────────────
export type { WorkerTag, WorkerTagAssignment, WorkerTagSummary, CreateWorkerTagDTO, UpdateWorkerTagDTO } from './domain/WorkerTag';
export type { Profession } from './domain/enums/Profession';
export { PROFESSIONS, isProfession } from './domain/enums/Profession';
export type { Worker, WorkerStatus, CreateWorkerDTO, SavePersonalInfoDTO, UpdateWorkerStepDTO, SaveQuizResponseDTO, SaveServiceAreaDTO, SaveAvailabilityDTO } from './domain/Worker';
export type { WorkerDocuments, CreateWorkerDocumentsDTO, UpdateWorkerDocumentsDTO, ReviewWorkerDocumentsDTO, DocumentsStatus, DocumentValidations, DocumentType, ValidateDocumentDTO, WorkerAdditionalDocument, CreateAdditionalDocumentDTO } from './domain/WorkerDocuments';
export type { WorkerAvailability, CreateAvailabilityDTO } from './domain/WorkerAvailability';
export type { WorkerServiceArea, CreateServiceAreaDTO } from './domain/WorkerServiceArea';
export type { WorkerQuizResponse, CreateQuizResponseDTO } from './domain/WorkerQuizResponse';
export type { WorkerDocExpiry, UpdateDocExpiryDTO } from './domain/WorkerDocExpiry';

// ── Ports (interfaces) ───────────────────────────────────────────────────────
export type { IWorkerTagRepository } from './ports/IWorkerTagRepository';
export type { IWorkerRepository } from './ports/IWorkerRepository';
export type { IAvailabilityRepository } from './ports/IAvailabilityRepository';
export type { IServiceAreaRepository } from './ports/IServiceAreaRepository';
export type { IQuizResponseRepository } from './ports/IQuizResponseRepository';

// ── Infrastructure ───────────────────────────────────────────────────────────
export { WorkerRepository } from './infrastructure/WorkerRepository';
export { WorkerDocumentsRepository } from './infrastructure/WorkerDocumentsRepository';
export type { IWorkerDocumentsRepository } from './infrastructure/WorkerDocumentsRepository';
export { WorkerAdditionalDocumentsRepository } from './infrastructure/WorkerAdditionalDocumentsRepository';
export { AvailabilityRepository } from './infrastructure/AvailabilityRepository';
export { ServiceAreaRepository } from './infrastructure/ServiceAreaRepository';
export { QuizResponseRepository } from './infrastructure/QuizResponseRepository';
export { GCSStorageService } from './infrastructure/GCSStorageService';
export { WorkerTagRepository } from './infrastructure/WorkerTagRepository';

// ── Application ──────────────────────────────────────────────────────────────
export { GetWorkerProgressUseCase } from './application/GetWorkerProgressUseCase';
export { InitWorkerUseCase } from './application/InitWorkerUseCase';
export { SaveStepUseCase } from './application/SaveStepUseCase';
export { SavePersonalInfoUseCase } from './application/SavePersonalInfoUseCase';
export { SaveQuizResponsesUseCase } from './application/SaveQuizResponsesUseCase';
export { SaveServiceAreaUseCase } from './application/SaveServiceAreaUseCase';
export { SaveAvailabilityUseCase } from './application/SaveAvailabilityUseCase';
export { GetWorkerAvailabilityUseCase } from './application/GetWorkerAvailabilityUseCase';
export { GetWorkerByPhoneUseCase } from './application/GetWorkerByPhoneUseCase';
export { LookupWorkerByEmailUseCase } from './application/LookupWorkerByEmailUseCase';
export { UploadWorkerDocumentsUseCase } from './application/UploadWorkerDocumentsUseCase';
export { ReviewWorkerDocumentsUseCase } from './application/ReviewWorkerDocumentsUseCase';
export { ValidateWorkerDocumentUseCase } from './application/ValidateWorkerDocumentUseCase';
export { ExportWorkersUseCase } from './application/ExportWorkersUseCase';
export { ListTagCatalogUseCase } from './application/ListTagCatalogUseCase';
export { CreateTagUseCase } from './application/CreateTagUseCase';
export { UpdateTagUseCase } from './application/UpdateTagUseCase';
export { DeleteTagUseCase } from './application/DeleteTagUseCase';
export { AssignTagToWorkerUseCase } from './application/AssignTagToWorkerUseCase';
export { RemoveTagFromWorkerUseCase } from './application/RemoveTagFromWorkerUseCase';

// ── Interfaces ───────────────────────────────────────────────────────────────
export { WorkerControllerV2 } from './interfaces/controllers/WorkerControllerV2';
export { AdminWorkersController } from './interfaces/controllers/AdminWorkersController';
export { AdminWorkerTestFlagController } from './interfaces/controllers/AdminWorkerTestFlagController';
export { AdminWorkerProfileController } from './interfaces/controllers/AdminWorkerProfileController';
export { AdminWorkerServiceAreaController } from './interfaces/controllers/AdminWorkerServiceAreaController';
export { AdminWorkersMapController } from './interfaces/controllers/AdminWorkersMapController';
export { createAdminWorkerRoutes } from './interfaces/routes/adminWorkerRoutes';
export type { AdminWorkerRouteControllers } from './interfaces/routes/adminWorkerRoutes';
export { JobsController } from './interfaces/controllers/JobsController';
export { WorkerDocumentsMeController } from './interfaces/controllers/WorkerDocumentsMeController';
export { AdminWorkerDocumentsController } from './interfaces/controllers/AdminWorkerDocumentsController';
export { WorkerAdditionalDocsMeController } from './interfaces/controllers/WorkerAdditionalDocsMeController';
export { AdminAdditionalDocsController } from './interfaces/controllers/AdminAdditionalDocsController';
export { createWorkerDocumentsRoutes } from './interfaces/routes/workerDocumentsRoutes';
export { createAdminWorkerDocumentsRoutes } from './interfaces/routes/adminWorkerDocumentsRoutes';
export { AdminTagCatalogController } from './interfaces/controllers/AdminTagCatalogController';

// ── Helpers (used by admin panel) ────────────────────────────────────────────
export { mapPlatformLabel, matchesSearch, normalizeSearch } from './interfaces/controllers/AdminWorkersControllerHelpers';
export type { WorkerListItem } from './interfaces/controllers/AdminWorkersControllerHelpers';
