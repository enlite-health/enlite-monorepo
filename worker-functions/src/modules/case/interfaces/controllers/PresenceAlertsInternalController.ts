import { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { CoordinationAlertUseCase, type CoordinationAlertResult } from '../../application/CoordinationAlertUseCase';
import { HttpAttendancePresenceAlertReader } from '../../infrastructure/HttpAttendancePresenceAlertReader';
import { ItineraryShiftDirectory } from '../../infrastructure/ItineraryShiftDirectory';
import { PresenceAlertRecipients } from '../../infrastructure/PresenceAlertRecipients';
import { PgCoordinationAlertStore } from '../../infrastructure/PgCoordinationAlertStore';
import { InAppCoordinationAlertChannel } from '../../infrastructure/InAppCoordinationAlertChannel';
import { EmailCoordinationAlertChannel } from '../../infrastructure/EmailCoordinationAlertChannel';

/** Composição real (adapters de produção). Só aqui os adapters encontram o caso de uso. */
export function buildCoordinationAlertUseCase(pool: Pool = DatabaseConnection.getInstance().getPool()): CoordinationAlertUseCase {
  return new CoordinationAlertUseCase(
    new HttpAttendancePresenceAlertReader(),
    new ItineraryShiftDirectory(pool),
    new PresenceAlertRecipients(pool),
    new PgCoordinationAlertStore(pool),
    new InAppCoordinationAlertChannel(),
    new EmailCoordinationAlertChannel(),
  );
}

/** O corpo da resposta: SÓ contagens (sem id de turno, uid, e-mail ou nome). */
export function summarizePresenceAlerts(r: CoordinationAlertResult): Record<string, number> {
  return { ...r };
}

/**
 * POST /api/internal/presence/alerts (emenda 077 §5) — Cloud Scheduler a cada 15 min, atrás de `internalAuthMiddleware` (`X-Internal-Secret`)
 * no `app.use`. Sem corpo e sem query: o instante é capturado UMA vez aqui. Idempotente (UNIQUE por turno). Erro isolado de um alerta é contado
 * em `failures` (o Scheduler/alarme olha `failures > 0`); attendance fora do ar ou qualquer erro fora disso é 500 (o Scheduler re-tenta).
 */
export class PresenceAlertsInternalController {
  private alertsMemo?: Pick<CoordinationAlertUseCase, 'execute'>;

  /** Sem `alerts` a composição real é montada na 1ª chamada (nunca no import do `index.ts`: não toca pool nem credencial no boot). */
  constructor(
    alerts?: Pick<CoordinationAlertUseCase, 'execute'>,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.alertsMemo = alerts;
  }

  async handle(_req: Request, res: Response): Promise<void> {
    try {
      const body = summarizePresenceAlerts(await (this.alertsMemo ??= buildCoordinationAlertUseCase()).execute({ now: this.clock() }));
      logger.info({ msg: '[presence/alerts] done', ...body });
      res.status(200).json(body);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      reportError(error, { source: 'PresenceAlertsInternalController:handle' });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
