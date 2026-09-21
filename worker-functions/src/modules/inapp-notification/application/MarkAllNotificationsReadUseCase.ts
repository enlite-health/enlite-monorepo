/** MarkAllNotificationsReadUseCase — `POST /api/admin/notifications/read-all` (Spec 022, Bloco 4, T406). */
import type { Pool, PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { NotificationRepository } from '../infrastructure/NotificationRepository';

export class MarkAllNotificationsReadUseCase {
  constructor(private readonly repository: NotificationRepository = new NotificationRepository()) {}

  async execute(pool: Pool, recipientUid: string): Promise<number> {
    return withActorContext(pool, async (client: PoolClient) => this.repository.markAllRead(recipientUid, client));
  }
}
