/**
 * WorkerDailyReportMeController — as 3 rotas do informe da guarda para o PRESTADOR (spec 092, design §Contrato HTTP).
 *   GET /api/workers/me/daily-report-scales    · GET /api/workers/me/daily-report-templates?from&to    · PUT /api/workers/me/daily-reports/:id
 * Identidade SÓ de `req.user.uid` (posto por `requireAuth()`). Sem lógica de negócio: valida a forma (zod), chama o use case, mapeia o erro.
 *
 * PRIVACIDADE: `narrative` e respostas são texto/dado clínico. Esta classe NUNCA os loga nem os devolve em erro. O log leva `reportId`,
 * contagem de respostas e o resultado; o erro inesperado passa por `toSafeError` (o `detail` do `pg` repete a linha — inclusive a narrativa).
 */
import type { Request, Response } from 'express';
import { logger, reportError, toSafeError } from '@shared/logging';
import { operationDateInZone } from '@shared/locale/operationDate';
import { AccountInactiveError } from '../../application/GetWorkerItineraryUseCase';
import type { GetScaleCatalogUseCase } from '../../application/dailyReport/GetScaleCatalogUseCase';
import { InvalidTemplateWindowError, type GetReportTemplatesUseCase } from '../../application/dailyReport/GetReportTemplatesUseCase';
import type { SubmitDailyReportUseCase } from '../../application/dailyReport/SubmitDailyReportUseCase';
import { DailyReportConflictError, DailyReportError, type ReportAnswer } from '../../domain/DailyReport';
import { issuePaths, reportIdParamSchema, submitDailyReportSchema, templatesQuerySchema, type SubmitDailyReportBody } from '../validators/dailyReportSchemas';

/** Mesma zona do "hoje" do itinerário do prestador (UTC−3, Buenos Aires). */
const TODAY_ZONE = 'America/Argentina/Buenos_Aires';

function answersOf(body: SubmitDailyReportBody): ReportAnswer[] {
  return body.answers.map((a) => ({
    itemKind: a.objectiveId !== undefined ? 'objective' : 'activity',
    itemId: (a.objectiveId ?? a.activityId) as string,
    scaleCode: a.scaleCode,
    answer: a.optionCode !== undefined
      ? { kind: 'choice', optionCode: a.optionCode, reasonCode: a.reasonCode ?? null }
      : { kind: 'count', value: a.countValue as number },
  }));
}

export class WorkerDailyReportMeController {
  constructor(
    private readonly catalog: GetScaleCatalogUseCase,
    private readonly templates: GetReportTemplatesUseCase,
    private readonly submit: SubmitDailyReportUseCase,
  ) {}

  async getScales(req: Request, res: Response): Promise<void> {
    if (!req.user?.uid) return void res.status(401).json({ success: false, error: 'Unauthorized' });
    try {
      const view = await this.catalog.execute();
      const etag = `"${view.version}"`;
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) return void res.status(304).end();
      res.status(200).json({ version: view.version, scales: view.scales });
    } catch (err) {
      this.fail(res, err, 'getScales');
    }
  }

  async getTemplates(req: Request, res: Response): Promise<void> {
    const uid = req.user?.uid;
    if (!uid) return void res.status(401).json({ success: false, error: 'Unauthorized' });
    const q = templatesQuerySchema.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ success: false, error: 'invalid_query', code: 'invalid_query', details: issuePaths(q.error) });
    try {
      const out = await this.templates.execute({ uid, from: q.data.from, to: q.data.to, today: operationDateInZone(TODAY_ZONE, new Date()) });
      res.status(200).json(out);
    } catch (err) {
      this.fail(res, err, 'getTemplates');
    }
  }

  async put(req: Request, res: Response): Promise<void> {
    const uid = req.user?.uid;
    if (!uid) return void res.status(401).json({ success: false, error: 'Unauthorized' });
    const id = reportIdParamSchema.safeParse(req.params.reportId);
    const body = submitDailyReportSchema.safeParse(req.body);
    if (!id.success || !body.success) {
      const details = [...(id.success ? [] : ['id']), ...(body.success ? [] : issuePaths(body.error))];
      return void res.status(400).json({ success: false, error: 'invalid_body', code: 'invalid_body', details });
    }
    const now = new Date();
    try {
      const outcome = await this.submit.execute({
        uid, reportId: id.data, occurrenceId: body.data.occurrenceId, ptiVersionId: body.data.ptiVersionId, narrative: body.data.narrative,
        narrativeSource: body.data.narrativeSource, deviceSubmittedAt: new Date(body.data.deviceSubmittedAt), appVersion: body.data.appVersion,
        answers: answersOf(body.data), now, today: operationDateInZone(TODAY_ZONE, now),
      });
      logger.info({ msg: 'daily_report_received', reportId: id.data, answers: body.data.answers.length, outcome });
      res.status(outcome === 'created' ? 201 : 200).json({ id: id.data });
    } catch (err) {
      this.fail(res, err, 'put', id.data);
    }
  }

  /** Mapeia o erro nomeado; o inesperado vira 500 SEM corpo de erro útil e SEM o `detail` do driver. */
  private fail(res: Response, err: unknown, op: string, reportId?: string): void {
    if (err instanceof AccountInactiveError) return void res.status(403).json({ code: 'ACCOUNT_INACTIVE' });
    if (err instanceof InvalidTemplateWindowError) return void res.status(400).json({ success: false, error: 'invalid_window', code: 'invalid_window' });
    if (err instanceof DailyReportConflictError) return void res.status(409).json({ success: false, error: err.code, code: err.code });
    if (err instanceof DailyReportError) return void res.status(422).json({ success: false, error: err.code, code: err.code });
    reportError(toSafeError(err), { source: `WorkerDailyReportMeController:${op}`, ...(reportId ? { reportId } : {}) });
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
