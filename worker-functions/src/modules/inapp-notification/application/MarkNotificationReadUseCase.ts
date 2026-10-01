/**
 * MarkNotificationReadUseCase — `POST /api/admin/notifications/:id/read` (Spec 022, Bloco 4, T406).
 *
 * Isolamento entre destinatários (D-24): notificação alheia (ou inexistente) lança
 * `NotificationNotOwnedError`, que o controller traduz em **404** — decisão do orquestrador
 * (registrada na evidência): o contrato escrito em `contracts/openapi-notifications.md` dizia
 * 403, mas 403 confirmaria PARA o requester que aquele id EXISTE (só não é dele); 404 não
 * distingue "não existe" de "existe, mas não é seu" — mesmo padrão anti-enumeração já usado em
 * `PostMessageUseCase`/`AdminConversationController` (`MessageNotFoundError`).
 */
import type { PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import type { Pool } from 'pg';
import { NotificationRepository } from '../infrastructure/NotificationRepository';

export class NotificationNotOwnedError extends Error {
  readonly code = 'NOTIFICATION_NOT_FOUND';
  readonly status = 404;

  constructor(readonly notificationId: string) {
    super(`notification ${notificationId} not found for this requester`);
    this.name = 'NotificationNotOwnedError';
  }
}

export interface MarkNotificationReadParams {
  notificationId: string;
  requesterUid: string;
}

export class MarkNotificationReadUseCase {
  constructor(private readonly repository: NotificationRepository = new NotificationRepository()) {}

  async execute(pool: Pool, params: MarkNotificationReadParams): Promise<void> {
    return withActorContext(pool, async (client: PoolClient) => {
      const recipientUid = await this.repository.findRecipientUid(params.notificationId, client);
      if (!recipientUid || recipientUid !== params.requesterUid) {
        throw new NotificationNotOwnedError(params.notificationId);
      }
      await this.repository.markRead(params.notificationId, client);
    });
  }
}
