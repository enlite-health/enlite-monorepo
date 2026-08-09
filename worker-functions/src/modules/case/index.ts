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
export type { PatientStatus } from './domain/enums/PatientStatus';
export { PATIENT_STATUSES, isPatientStatus } from './domain/enums/PatientStatus';

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
export { GetPatientByIdUseCase } from './application/GetPatientByIdUseCase';
export type { GetPatientByIdOutput } from './application/GetPatientByIdUseCase';
export { CreatePatientUseCase, PatientContactValidationError } from './application/CreatePatientUseCase';
export type { CreatePatientInput } from './application/CreatePatientUseCase';
export {
  ActivatePatientUseCase,
  PatientNotFoundError,
  NoActiveAddressError,
} from './application/ActivatePatientUseCase';
export type { ActivatePatientResult } from './application/ActivatePatientUseCase';

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
export { AdminPatientChatIdsController } from './interfaces/controllers/AdminPatientChatIdsController';
export { AdminPatientChatRolesController } from './interfaces/controllers/AdminPatientChatRolesController';
export { patientChatIdsSchema, patientChatMapQuerySchema } from './interfaces/validators/patientChatIdsSchema';
export {
  createPatientChatRoleSchema,
  updatePatientChatRoleSchema,
  patientChatRoleParamsSchema,
  listPatientChatRolesQuerySchema,
} from './interfaces/validators/patientChatRolesSchema';
export { createAdminPatientsRoutes } from './interfaces/routes/adminPatientsRoutes';
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
