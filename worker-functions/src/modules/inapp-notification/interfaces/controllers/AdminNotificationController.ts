/**
 * AdminNotificationController — as 4 rotas de `contracts/openapi-notifications.md` (Spec 022,
 * Bloco 4, T406). Molde: `AdminConversationController.ts` (mesmo `actorUid` via
 * `AuthMiddleware.getAuthContext`, controller fino delegando às use cases).
 */
import { Request, Response } from 'express';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { Pool } from 'pg';
import { reportError } from '@shared/logging';
import { GetNotificationsUseCase, type NotificationDto } from '../../application/GetNotificationsUseCase';
import { GetUnreadCountUseCase } from '../../application/GetUnreadCountUseCase';
import { MarkNotificationReadUseCase, NotificationNotOwnedError } from '../../application/MarkNotificationReadUseCase';
import { MarkAllNotificationsReadUseCase } from '../../application/MarkAllNotificationsReadUseCase';
import { listNotificationsQuerySchema, notificationIdParamsSchema } from '../validators/notificationSchemas';
import { MissingActorError, actorUid } from '@modules/conversation/interfaces/controllers/ConversationActor';

function toNotificationDto(row: NotificationDto) {
  return {
    id: row.id,
    typeCode: row.typeCode,
    actorUid: row.actorUid,
    actorDisplayName: row.actorDisplayName,
    patientId: row.patientId,
    patientDisplayName: row.patientDisplayName,
    conversationId: row.conversationId,
    messageId: row.messageId,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt ? row.readAt.toISOString() : null,
  };
}

export class AdminNotificationController {
  constructor(
    private readonly getNotificationsUseCase: GetNotificationsUseCase = new GetNotificationsUseCase(),
    private readonly getUnreadCountUseCase: GetUnreadCountUseCase = new GetUnreadCountUseCase(),
    private readonly markNotificationReadUseCase: MarkNotificationReadUseCase = new MarkNotificationReadUseCase(),
    private readonly markAllNotificationsReadUseCase: MarkAllNotificationsReadUseCase = new MarkAllNotificationsReadUseCase(),
    private readonly db: Pool = DatabaseConnection.getInstance().getPool(),
  ) {}

  /** GET /api/admin/notifications — célula `own_notifications:read`. */
  async list(req: Request, res: Response): Promise<void> {
    const query = listNotificationsQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ success: false, error: 'Invalid query' }); return; }
    try {
      const uid = actorUid(req);
      const notifications = await this.getNotificationsUseCase.execute({
        recipientUid: uid,
        unreadOnly: query.data.unread === '1',
        limit: query.data.limit,
      });
      res.status(200).json({ success: true, data: notifications.map(toNotificationDto) });
    } catch (err: unknown) {
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'list');
    }
  }

  /** GET /api/admin/notifications/unread-count — célula `own_notifications:read`. */
  async unreadCount(req: Request, res: Response): Promise<void> {
    try {
      const uid = actorUid(req);
      const count = await this.getUnreadCountUseCase.execute(uid);
      res.status(200).json({ success: true, data: { count } });
    } catch (err: unknown) {
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'unreadCount');
    }
  }

  /** POST /api/admin/notifications/:id/read — célula `own_notifications:update`. */
  async markRead(req: Request, res: Response): Promise<void> {
    const params = notificationIdParamsSchema.safeParse(req.params);
    if (!params.success) { res.status(400).json({ success: false, error: 'Invalid params' }); return; }
    try {
      const uid = actorUid(req);
      await this.markNotificationReadUseCase.execute(this.db, { notificationId: params.data.id, requesterUid: uid });
      res.status(200).json({ success: true });
    } catch (err: unknown) {
      // Isolamento entre destinatários (D-24): notificação alheia ou inexistente → 404, NUNCA
      // 403 — decisão do orquestrador (o contrato escrito pedia 403; registrado na evidência).
      if (err instanceof NotificationNotOwnedError) { res.status(404).json({ success: false, error: err.message, code: err.code }); return; }
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'markRead');
    }
  }

  /** POST /api/admin/notifications/read-all — célula `own_notifications:update`. */
  async markAllRead(req: Request, res: Response): Promise<void> {
    try {
      const uid = actorUid(req);
      const updated = await this.markAllNotificationsReadUseCase.execute(this.db, uid);
      res.status(200).json({ success: true, data: { updated } });
    } catch (err: unknown) {
      if (err instanceof MissingActorError) { res.status(401).json({ success: false, error: err.message, code: err.code }); return; }
      this.handleUnexpected(err, res, 'markAllRead');
    }
  }

  private handleUnexpected(err: unknown, res: Response, source: string): void {
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminNotificationController:${source}` });
    res.status(500).json({ success: false, error: 'Internal error' });
  }
}
