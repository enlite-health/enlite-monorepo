/** Composition root do informe da guarda do prestador (spec 092): o ÚNICO lugar que liga o adapter Pg aos use cases e ao controller. Lazy: o pool abre na 1ª consulta. */
import { PgDailyReportRepository } from '../../infrastructure/PgDailyReportRepository';
import { HttpPresenceReader } from '../../infrastructure/HttpPresenceReader';
import { GetScaleCatalogUseCase } from '../../application/dailyReport/GetScaleCatalogUseCase';
import { GetReportTemplatesUseCase } from '../../application/dailyReport/GetReportTemplatesUseCase';
import { SubmitDailyReportUseCase } from '../../application/dailyReport/SubmitDailyReportUseCase';
import { WorkerDailyReportMeController } from './WorkerDailyReportMeController';

export function buildWorkerDailyReportController(): WorkerDailyReportMeController {
  const port = new PgDailyReportRepository();
  return new WorkerDailyReportMeController(new GetScaleCatalogUseCase(port), new GetReportTemplatesUseCase(port), new SubmitDailyReportUseCase(port, new HttpPresenceReader()));
}
