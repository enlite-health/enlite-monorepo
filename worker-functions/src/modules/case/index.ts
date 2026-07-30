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
