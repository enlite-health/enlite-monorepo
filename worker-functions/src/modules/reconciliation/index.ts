/**
 * reconciliation module — barrel export (spec 003: "Paciente — a plataforma é
 * a fonte da verdade"). External code MUST import only from this file.
 */
// Domain
export * from './domain/enums';
export type { CanonicalPatient, CanonicalAddress, CanonicalValue, Unreadable } from './domain/CanonicalPatient';
export { toCanonical, containsForbiddenKeys, isUnreadable, UNREADABLE, FORBIDDEN_CANONICAL_KEYS } from './domain/CanonicalPatient';
export type { PatientSourceReader, SourceReadResult, SourceRecord } from './domain/PatientSourceReader';
export { IdentityMatcher, normalizeName, normalizeDocument } from './domain/IdentityMatcher';
export type { IdentityProbe, IdentityCandidate, MatchOutcome, AmbiguityReason } from './domain/IdentityMatcher';
export { AnaCarePatientApiUnavailable, AnaCarePatientApiUnavailableError } from './domain/AnaCarePatientApi';
export type { AnaCarePatientApi, AnaCarePatientRecord, AnaCarePatientPage } from './domain/AnaCarePatientApi';
// Infrastructure
export { SourceRunRepository } from './infrastructure/SourceRunRepository';
export type { SourceRun } from './infrastructure/SourceRunRepository';
export { SnapshotRepository, hashCanonical, ForbiddenCanonicalError } from './infrastructure/SnapshotRepository';
export { IdentityLinkRepository } from './infrastructure/IdentityLinkRepository';
export type { IdentityLink, InventoryCounts } from './infrastructure/IdentityLinkRepository';
export { FieldMapRepository } from './infrastructure/FieldMapRepository';
export { AnaCareApiSourceReader } from './infrastructure/AnaCareApiSourceReader';
export { fieldsToCanonical, toIsoDate } from './infrastructure/fieldsToCanonical';
// Application
export { SnapshotSourceUseCase, completenessOf } from './application/SnapshotSourceUseCase';
export { SnapshotSourceWithLockUseCase } from './application/SnapshotSourceWithLockUseCase';
export { ClassifySourcesUseCase } from './application/ClassifySourcesUseCase';
// Interfaces
export { PatientReconciliationController } from './interfaces/controllers/PatientReconciliationController';
export { createPatientReconciliationRoutes } from './interfaces/routes/patientReconciliationRoutes';
export { createPatientReconciliationController } from './interfaces/createPatientReconciliationController';
