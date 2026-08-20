/**
 * notification module — barrel export.
 *
 * External code MUST import only from this file (or via @modules/notification/*
 * when consuming specific internal subpaths).
 *
 * Boundary rule enforced by ESLint no-restricted-imports.
 */

// ─── Domain ──────────────────────────────────────────────────────────────────
export type { MessageTemplate, TemplateButton, UpsertMessageTemplateDTO } from './domain/MessageTemplate';
export type {
  InterviewSlot,
  InterviewSlotStatus,
  CreateInterviewSlotsDTO,
  BookSlotDTO,
  BookSlotResult,
  SlotInput,
} from './domain/InterviewSlot';
export type { InterviewResponse } from './domain/InterviewStateMachine';
export { canTransition } from './domain/InterviewStateMachine';
export type {
  IMessagingService,
  SendWhatsAppOptions,
  MessageSentResult,
} from './domain/IMessagingService';

// ─── Infrastructure ───────────────────────────────────────────────────────────
export { MessageTemplateRepository } from './infrastructure/MessageTemplateRepository';
export { InterviewSlotRepository } from './infrastructure/InterviewSlotRepository';
export { TwilioMessagingService } from './infrastructure/TwilioMessagingService';
export { PeriskopeMessagingService } from './infrastructure/PeriskopeMessagingService';
export { PeriskopeChatReadService } from './infrastructure/PeriskopeChatReadService';
export type { PeriskopeGroupChat, GroupChatsResult } from './infrastructure/PeriskopeChatReadService';
export { createPeriskopeHttpClient, PERISKOPE_BASE_URL } from './infrastructure/periskopeHttpClient';
export { ChatwootClient } from './infrastructure/ChatwootClient';
export type { ChatwootClientConfig, MirrorOutgoingOptions } from './infrastructure/ChatwootClient';
export { OutboxProcessor } from './infrastructure/OutboxProcessor';
export { BulkDispatchScheduler } from './infrastructure/BulkDispatchScheduler';
export { ReminderScheduler } from './infrastructure/ReminderScheduler';
export { LegacyEncuadreReminderService } from './infrastructure/LegacyEncuadreReminderService';
export { TokenService } from './infrastructure/TokenService';
export { InterviewSchedulingService } from './infrastructure/InterviewSchedulingService';

// ─── Application ──────────────────────────────────────────────────────────────
export {
  BulkDispatchIncompleteWorkersUseCase,
} from './application/BulkDispatchIncompleteWorkersUseCase';
export type {
  BulkDispatchResult,
  BulkDispatchDetail,
  BulkDispatchOptions,
} from './application/BulkDispatchIncompleteWorkersUseCase';
export { BookSlotFromWhatsAppUseCase } from './application/BookSlotFromWhatsAppUseCase';
export { HandleReminderResponseUseCase } from './application/HandleReminderResponseUseCase';
export { MarkNoShowUseCase } from './application/MarkNoShowUseCase';
export type { NoShowResult } from './application/MarkNoShowUseCase';

// ─── Interfaces ────────────────────────────────────────────────────────────────
export { MessagingController } from './interfaces/controllers/MessagingController';
export { InternalController } from './interfaces/controllers/InternalController';
export { TwilioWebhookController } from './interfaces/controllers/TwilioWebhookController';
export { InboundWhatsAppController } from './interfaces/controllers/InboundWhatsAppController';
export { PeriskopeWebhookController } from './interfaces/controllers/PeriskopeWebhookController';
export {
  createMessagingRoutes,
} from './interfaces/routes/messagingRoutes';
export { createInternalRoutes } from './interfaces/routes/internalRoutes';
export { internalAuthMiddleware } from './interfaces/middleware/InternalAuthMiddleware';
