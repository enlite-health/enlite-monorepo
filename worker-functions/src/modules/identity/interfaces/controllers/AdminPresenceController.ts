/**
 * AdminPresenceController — POST /api/admin/me/presence (heartbeat, change
 * 022-ux-mencao-e-notificacao, Rodada 2/R2-B). Molde: `AdminNotificationController.ts`
 * (`principalUid`/401 explícito, controller fino delegando à use case).
 *
 * 204 sempre que o ator está autenticado — o throttle (regravou ou não) é TRANSPARENTE ao
 * cliente: o painel manda heartbeat a cada ~60s sem saber, nem precisar saber, se o servidor de
 * fato regravou `last_seen_at` desta chamada.
 */
import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { UpdatePresenceUseCase } from '../../application/UpdatePresenceUseCase';
import { principalUid } from '../middleware/PermissionMiddleware';

export class AdminPresenceController {
  constructor(private readonly updatePresenceUseCase: UpdatePresenceUseCase = new UpdatePresenceUseCase()) {}

  /** POST /api/admin/me/presence — célula `own_presence:update`. */
  async heartbeat(req: Request, res: Response): Promise<void> {
    const uid = principalUid(req);
    if (!uid) {
      res.status(401).json({ success: false, error: 'Not authenticated', code: 'MISSING_ACTOR' });
      return;
    }

    try {
      await this.updatePresenceUseCase.execute(uid);
      res.status(204).send();
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'AdminPresenceController:heartbeat' });
      res.status(500).json({ success: false, error: 'Failed to update presence' });
    }
  }
}
