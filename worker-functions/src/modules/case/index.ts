/**
 * case module — barrel export.
 * External code MUST import only from this file.
 * Direct imports from case/domain/* or case/infrastructure/* are forbidden
 * (enforced by lint rule in .eslintrc.js).
 */

// Domain enums
export type { DependencyLevel } from './domain/enums/DependencyLevel';
export { DEPENDENCY_LEVELS, isDependencyLevel } from './domain/enums/DependencyLevel';
export type { Sex } from './domain/enums/Sex';
export { SEXES, isSex } from './domain/enums/Sex';
export type { DocumentType } from './domain/enums/DocumentType';
export { DOCUMENT_TYPES, isDocumentType } from './domain/enums/DocumentType';
export type { Relationship } from './domain/enums/Relationship';
export { RELATIONSHIPS, isRelationship } from './domain/enums/Relationship';
export type { ClinicalSpecialty } from './domain/enums/ClinicalSpecialty';
export { CLINICAL_SPECIALTIES, isClinicalSpecialty } from './domain/enums/ClinicalSpecialty';
export type { AcquisitionChannel } from './domain/enums/AcquisitionChannel';
export { ACQUISITION_CHANNELS, isAcquisitionChannel } from './domain/enums/AcquisitionChannel';
export type { AttentionReason } from './domain/enums/AttentionReason';
export { ATTENTION_REASONS, isAttentionReason } from './domain/enums/AttentionReason';
export type { PatientStatus, ClinicalPatientStatus, AdmissionFunnelStatus } from './domain/enums/PatientStatus';
export {
  PATIENT_STATUSES, CLINICAL_PATIENT_STATUSES, ADMISSION_FUNNEL_STATUSES,
  isPatientStatus, isClinicalPatientStatus, isAdmissionFunnelStatus,
} from './domain/enums/PatientStatus';
// Spec 012 (bloco B): motivo de espera e funil de admissão em coluna própria.
export type { OnHoldReason } from './domain/enums/OnHoldReason';
export { ON_HOLD_REASONS, isOnHoldReason } from './domain/enums/OnHoldReason';
export type { AdmissionStatus } from './domain/enums/AdmissionStatus';
export { ADMISSION_STATUSES, isAdmissionStatus } from './domain/enums/AdmissionStatus';

// Domain types
export type { PatientIdentity } from './domain/PatientIdentity';
export type { PatientChatIdMap, PatientChatIdWriteMap } from './domain/PatientChatId';
export {
  GROUP_CHAT_ID_PATTERN,
  CHAT_ID_MAX_LENGTH,
  isGroupChatId,
  legacyChatIdAliases,
} from './domain/PatientChatId';
export type { PatientChatRoleSpec, PatientChatRoleCatalog } from './domain/PatientChatRole';
export {
  PATIENT_CHAT_ROLE_PATTERN,
  PATIENT_CHAT_ROLE_MAX_LENGTH,
  isPatientChatRoleCode,
  isExclusiveChatRole,
  toRoleCatalog,
  chatRoleLabel,
} from './domain/PatientChatRole';
export type { PatientClinical } from './domain/PatientClinical';
export type {
  PatientResponsible,
  PatientResponsibleInput,
  ContactChannelValidationInput,
} from './domain/PatientResponsible';
export { validateContactChannel } from './domain/PatientResponsible';

// Application
export { PatientService } from './application/PatientService';
export type {
  PatientServiceUpsertInput,
  UpsertFromClickUpOptions,
  MissingContactStrategy,
} from './application/PatientService';
// A transição de estado mora em `PatientStatusWriter` desde a quebra do PatientService pelo
// teto de 400 linhas. O barril continua sendo a porta única do módulo.
export {
  PatientStatusTransitionError,
  OnHoldReasonRequiredError,
} from './application/PatientStatusWriter';
export type { MoveStatusOptions } from './application/PatientStatusWriter';
export {
  PatientChatIdsService,
  PatientChatIdsNotFoundError,
  ChatIdAlreadyLinkedError,
  UnknownChatRoleError,
} from './application/PatientChatIdsService';
export {
  PatientChatRolesService,
  ChatRoleNotFoundError,
  ChatRoleAlreadyExistsError,
  ChatRoleInUseError,
  ChatRoleExclusivityConflictError,
} from './application/PatientChatRolesService';
export {
  FindPatientChatCandidatesUseCase,
  DEFAULT_CANDIDATE_LIMIT,
} from './application/FindPatientChatCandidatesUseCase';
export type { FindPatientChatCandidatesOutput } from './application/FindPatientChatCandidatesUseCase';
export {
  rankChatCandidates,
  scoreGroupName,
  toMatchTerms,
  normalizeForMatch,
  roleAffinity,
  orderCandidatesForRole,
} from './application/rankChatCandidates';
export type { ChatCandidate, RoleMatchSpec } from './application/rankChatCandidates';
export {
  GetPatientChatMapUseCase,
  DEFAULT_CHAT_MAP_LIMIT,
  MAX_CHAT_MAP_LIMIT,
} from './application/GetPatientChatMapUseCase';
export type {
  GetPatientChatMapInput,
  GetPatientChatMapResult,
} from './application/GetPatientChatMapUseCase';
export {
  ListChatGroupsUseCase,
  DEFAULT_GROUP_PAGE_SIZE,
  MAX_GROUP_PAGE_SIZE,
} from './application/ListChatGroupsUseCase';
export type {
  ChatGroupListItem,
  ListChatGroupsInput,
  ListChatGroupsOutput,
} from './application/ListChatGroupsUseCase';
export { GetPatientByIdUseCase } from './application/GetPatientByIdUseCase';
export type { GetPatientByIdOutput } from './application/GetPatientByIdUseCase';
export { CreatePatientUseCase, PatientContactValidationError } from './application/CreatePatientUseCase';
export type { CreatePatientInput } from './application/CreatePatientUseCase';
export {
  ActivateRecruitmentUseCase,
  PatientNotFoundForRecruitmentError,
  ServiceNotFoundForRecruitmentError,
  ServiceAlreadyRecruitingError,
  RecruitmentNotReadyError,
} from './application/ActivateRecruitmentUseCase';
export type { ActivateRecruitmentResult } from './application/ActivateRecruitmentUseCase';
export {
  computePatientCompleteness,
  computeRecruitmentReadiness,
  isMinor,
  isPlaceholderCoverageValue,
  PATIENT_COMPLETENESS_CODES,
  RECRUITMENT_BLOCKING_CODES,
} from './domain/PatientCompleteness';
export type {
  PatientCompletenessCode,
  PatientCompletenessInput,
  PatientCompletenessResult,
} from './domain/PatientCompleteness';

// Infrastructure (exposed for explicit consumers like backfill scripts)
export { PatientIdentityRepository } from './infrastructure/PatientIdentityRepository';
export { PatientClinicalRepository } from './infrastructure/PatientClinicalRepository';
export { PatientResponsibleRepository } from './infrastructure/PatientResponsibleRepository';
export { PatientQueryRepository } from './infrastructure/PatientQueryRepository';
export { PatientChatIdsRepository } from './infrastructure/PatientChatIdsRepository';
export type {
  PatientChatIdsRow,
  ChatIdConflict,
  PatientChatMapRow,
  ChatMapFilter,
} from './infrastructure/PatientChatIdsRepository';
export { PatientChatRolesRepository } from './infrastructure/PatientChatRolesRepository';
export type {
  CreateChatRoleInput,
  UpdateChatRoleInput,
  SharedGroupConflict,
} from './infrastructure/PatientChatRolesRepository';
// Task 3.3 (`campos-admissao`): a Cobertura Verificada MÚLTIPLA. Migration 305.
export {
  PatientInsuranceVerifiedRepository,
  InsuranceProviderUnknownError,
  classifyInsuranceLabels,
} from './infrastructure/PatientInsuranceVerifiedRepository';
// Spec 012, US-B3: o catálogo de coberturas (migration 311).
export { InsuranceProviderRepository, InsuranceProviderExistsError,
  InsuranceProviderSortOrderTakenError } from './infrastructure/InsuranceProviderRepository';
export type { InsuranceProviderRow, CreateInsuranceProviderInput } from './infrastructure/InsuranceProviderRepository';
export type {
  PatientInsuranceVerifiedWriteInput,
  PatientInsuranceVerifiedResult,
  PatientInsuranceVerifiedRow,
  PatientInsuranceVerifiedOutcome,
} from './infrastructure/PatientInsuranceVerifiedRepository';
// Task 4.2 (`campos-admissao`): o Tipo de Dispositivo MÚLTIPLO. Migrations 307 e 290.
export { PatientDeviceTypeRepository, DeviceTypeUnknownError } from './infrastructure/PatientDeviceTypeRepository';
export type {
  PatientDeviceTypeWriteInput,
  PatientDeviceTypeResult,
  PatientDeviceTypeOutcome,
} from './infrastructure/PatientDeviceTypeRepository';

// Task 2.2 (`campos-admissao`): o rótulo CRU da origem, ao lado do derivado. Migration 304.
export {
  PatientSourceLabelRepository,
  PatientSourceLabelCeilingError,
  PATIENT_SOURCE_LABEL_CEILING,
  sourceLabelsRead,
  sourceLabelsUnreadable,
} from './infrastructure/PatientSourceLabelRepository';
export type {
  PatientSourceLabelWriteInput,
  PatientSourceLabelWriteResult,
  PatientSourceLabelRejection,
  PatientSourceLabelRejectionReason,
  PatientSourceLabelRow,
  PatientSourceLabelRejectionRow,
  PatientSourceLabelsRead,
  PatientSourceLabelWriteOutcome,
} from './infrastructure/PatientSourceLabelRepository';
export type { PatientIdentityUpsertInput } from './infrastructure/PatientIdentityRepository';
export type { PatientClinicalUpsertInput } from './infrastructure/PatientClinicalRepository';
export type {
  PatientListRow,
  PatientStatsRow,
  PatientDetailRow,
  PatientResponsibleDetail,
  PatientAddressDetail,
  PatientProfessionalDetail,
} from './infrastructure/PatientQueryRepository';

// Interfaces
export { AdminPatientsController } from './interfaces/controllers/AdminPatientsController';
export { AdminPatientAddressesController } from './interfaces/controllers/AdminPatientAddressesController';
export { AdminInsuranceProvidersController } from './interfaces/controllers/AdminInsuranceProvidersController';
export { AdminPatientsMapController } from './interfaces/controllers/AdminPatientsMapController';
export { AdminPatientContractedServicesController } from './interfaces/controllers/AdminPatientContractedServicesController';
export { AdminTherapeuticProjectsController } from './interfaces/controllers/AdminTherapeuticProjectsController';
export { createAdminTherapeuticProjectsRoutes } from './interfaces/routes/adminTherapeuticProjectsRoutes';
export { AdminPatientChatIdsController } from './interfaces/controllers/AdminPatientChatIdsController';
export { AdminPatientChatRolesController } from './interfaces/controllers/AdminPatientChatRolesController';
export { patientChatIdsSchema, patientChatMapQuerySchema, chatGroupsQuerySchema } from './interfaces/validators/patientChatIdsSchema';
export {
  createPatientChatRoleSchema,
  updatePatientChatRoleSchema,
  patientChatRoleParamsSchema,
  listPatientChatRolesQuerySchema,
} from './interfaces/validators/patientChatRolesSchema';
export { createAdminPatientsRoutes, ADMIN_PATIENTS_FAMILY } from './interfaces/routes/adminPatientsRoutes';
export { PublicLeadsController } from './interfaces/controllers/PublicLeadsController';

// Application — public intake (Task 1)
export { CreateLeadUseCase } from './application/CreateLeadUseCase';
export type { CreateLeadResult } from './application/CreateLeadUseCase';
export {
  publicLeadSchema,
  LEAD_SERVICE_SLUGS,
  LEAD_SERVICE_VALUES,
  LEAD_SERVICE_TO_PROFESSION,
} from './interfaces/validators/publicLeadSchema';
export type { PublicLeadBody, LeadServiceSlug } from './interfaces/validators/publicLeadSchema';
