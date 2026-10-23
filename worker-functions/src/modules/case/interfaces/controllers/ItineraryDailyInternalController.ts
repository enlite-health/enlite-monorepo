import { Request, Response } from 'express';
import { logger, reportError } from '@shared/logging';
import { COUNTRY_TIMEZONE_MAP } from '@shared/locale/CountryTimezone';
import { ItineraryDailyRoutineUseCase, type ItineraryDailyResult } from '../../application/ItineraryDailyRoutineUseCase';

/** O corpo da resposta: SÓ contagens e datas de operação (sem id de paciente, sem uid, sem e-mail). */
export function summarizeItineraryDaily(result: ItineraryDailyResult): Record<string, unknown> {
  const per = Object.values(result.countries);
  const sum = (pick: (c: (typeof per)[number]) => number): number => per.reduce((total, c) => total + pick(c), 0);
  const { alert } = result;
  return {
    operationDate: alert.operationDate,
    patientsChecked: sum((c) => c.patientsChecked),
    statusMoved: sum((c) => c.moved),
    statusUnchanged: sum((c) => c.unchanged),
    statusNotReady: sum((c) => c.notReady),
    alertRecipients: alert.alertRecipients,
    notified: alert.notified,
    alreadySent: alert.alreadySent,
    emailsSent: alert.emailsSent,
    emailsSkipped: alert.emailsSkipped,
    emailsFailed: alert.emailsFailed,
    skippedNoCountry: alert.skippedNoCountry,
    failures: sum((c) => c.failures) + alert.failures,
  };
}

/**
 * POST /api/internal/itinerary/daily (spec 069 F4) — chamado pelo Cloud Scheduler (06:00 America/Argentina/Buenos_Aires), atrás de
 * `internalAuthMiddleware` (header `X-Internal-Secret`) no `app.use`. Sem corpo e sem query: o instante é capturado UMA vez aqui
 * (`new Date()`), os países vêm do mapa de fusos. Idempotente. Erro dentro de um paciente/destinatário não derruba a resposta
 * (o caso de uso isola e conta em `failures`, que também fica em `itinerary_daily_run`); erro fora disso é 500 (o Scheduler re-tenta).
 */
export class ItineraryDailyInternalController {
  constructor(
    private readonly routine: Pick<ItineraryDailyRoutineUseCase, 'execute'> = new ItineraryDailyRoutineUseCase(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async handle(_req: Request, res: Response): Promise<void> {
    try {
      const result = await this.routine.execute({ now: this.clock(), countries: Object.keys(COUNTRY_TIMEZONE_MAP) });
      const body = summarizeItineraryDaily(result);
      logger.info({ msg: '[itinerary/daily] done', ...body });
      res.status(200).json(body);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      reportError(error, { source: 'ItineraryDailyInternalController:handle' });
      res.status(500).json({ error: 'Internal server error' });
    }
  }
}
