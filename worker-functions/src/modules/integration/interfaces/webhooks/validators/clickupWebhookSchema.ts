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
});

export type ClickUpWebhookBody = z.infer<typeof ClickUpWebhookBodySchema>;
