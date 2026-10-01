/** GetUnreadCountUseCase — `GET /api/admin/notifications/unread-count` (Spec 022, Bloco 4, T406). Poll do sino a cada 45s (D-10). */
import { NotificationRepository } from '../infrastructure/NotificationRepository';

export class GetUnreadCountUseCase {
  constructor(private readonly repository: NotificationRepository = new NotificationRepository()) {}

  async execute(recipientUid: string): Promise<number> {
    return this.repository.countUnread(recipientUid);
  }
}
