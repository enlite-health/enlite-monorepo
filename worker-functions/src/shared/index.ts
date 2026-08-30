/**
 * Shared infrastructure — cross-cutting concerns used by all modules.
 * External modules MUST import from this barrel, not directly from subdirs.
 */

// Database
export { DatabaseConnection } from './database/DatabaseConnection';

// Security
export { KMSEncryptionService } from './security/KMSEncryptionService';

// Events (infra)
export { DomainEventProcessor } from './events/DomainEventProcessor';
export type { DomainEventHandler, DomainEventMeta } from './events/DomainEventProcessor';
export { CloudTasksClient } from './events/CloudTasksClient';
export type { ScheduleTaskOptions } from './events/CloudTasksClient';
export { PubSubClient } from './events/PubSubClient';
export type { PubSubMessage } from './events/PubSubClient';
export { createQualifiedInterviewHandler } from './events/handlers/QualifiedInterviewHandler';

// Utils
export * from './utils/pagination';
export * from './utils/Result';
export * from './utils/dateFormatters';
export * from './utils/phoneNormalization';

// Logging (structured pino + correlationMiddleware + ErrorReporter)
export { logger, correlationMiddleware, reportError, loggingAls } from './logging';
export type { LogContext } from './logging';
