import { z } from 'zod';

/** `GET /api/admin/notifications?unread=1&limit=20` (`contracts/openapi-notifications.md`). */
export const listNotificationsQuerySchema = z.object({
  unread: z.literal('1').optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

export const notificationIdParamsSchema = z.object({ id: z.string().uuid() });
