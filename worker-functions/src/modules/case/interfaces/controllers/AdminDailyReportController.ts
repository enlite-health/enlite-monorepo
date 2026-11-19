/**
 * AdminDailyReportController — `GET /api/admin/patients/:patientId/daily-reports?from&to` (spec 092, CA-4).
 * Sem lógica de negócio: valida a forma (zod), chama o use case com as células da request e devolve. A redação é do use case
 * (`daily_report_narrative:read`); o corpo de erro nunca carrega informe nem resposta. O erro inesperado passa por `toSafeError`.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { reportError, toSafeError } from '@shared/logging';
import type { GetPatientDailyReportsUseCase } from '../../application/dailyReport/GetPatientDailyReportsUseCase';
import { issuePaths } from '../validators/dailyReportSchemas';

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const listQuerySchema = z
  .object({ patientId: z.string().uuid(), from: dateParam.optional(), to: dateParam.optional() })
  .strict()
  .refine((q) => q.from === undefined || q.to === undefined || q.from <= q.to, { path: ['from'] });

export class AdminDailyReportController {
  constructor(private readonly list_: GetPatientDailyReportsUseCase) {}

  async list(req: Request, res: Response): Promise<void> {
    const parsed = listQuerySchema.safeParse({ patientId: req.params.patientId, ...req.query });
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'invalid_query', code: 'invalid_query', details: issuePaths(parsed.error) });
      return;
    }
    try {
      const out = await this.list_.execute({
        patientId: parsed.data.patientId, from: parsed.data.from ?? null, to: parsed.data.to ?? null, cells: req.permissionCells ?? null,
      });
      if (out === null) {
        res.status(404).json({ success: false, error: 'Patient not found' });
        return;
      }
      res.status(200).json(out);
    } catch (err) {
      reportError(toSafeError(err), { source: 'AdminDailyReportController:list' });
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
