/**
 * audit module — barrel export.
 * External code MUST import only from this file.
 * Direct imports from audit/domain/* or audit/infrastructure/* are forbidden
 * (enforced by lint rule in .eslintrc.js).
 */

// Domain types
export type { Publication, CreatePublicationDTO } from './domain/Publication';

// Infrastructure — repositories (named exports)
export { DocExpiryRepository } from './infrastructure/AuditRepositories';
export { PublicationRepository } from './infrastructure/PublicationRepository';
