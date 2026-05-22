import { z } from 'zod';

export const ClickUpEventSchema = z.enum([
  'taskCreated',
  'taskUpdated',
  'taskStatusUpdated',
  'taskMoved',
  'taskDeleted',
]);

export const ClickUpWebhookBodySchema = z.object({
  event:         z.string(),
  webhook_id:    z.string(),
  task_id:       z.string(),
  list_id:       z.string().optional(),
  history_items: z.array(z.unknown()).optional(),
  /** Test-only: when present, skips the real ClickUp API fetchTask call.
   *  Only honoured when NODE_ENV=test. Ignored in production. */
  _injectedTask: z.unknown().optional(),
});

export type ClickUpWebhookBody = z.infer<typeof ClickUpWebhookBodySchema>;
