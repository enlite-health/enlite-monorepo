/**
 * src/modules/anacare-hours/interfaces/controllers/AnaCareHoursController.ts
 *
 * HTTP dos 5 endpoints do contrato fixo (spec F1, base `/api/admin/anacare-hours`).
 *
 *   GET  /months/:month                      → AnaCareMonthSnapshot | 400 | read
 *   GET  /months/:month/patients/:patientId   → AnaCarePatient | 404 | read
 *   POST /shifts/:shiftId/validate            → 204 | 404 | 409 | validate
 *   POST /shifts/validate-batch               → 200 (por item) | 400 | validate
 *   POST /shifts/:shiftId/contest             → 204 | 400 | 404 | 409 | validate
 *
 * Fail-closed: SEM `ANACARE_HOURS_SOURCE=fake`, todo endpoint responde 503
 * `ANACARE_SOURCE_NOT_CONFIGURED` — produção nunca serve dado falso por omissão (spec F1).
 * Nenhum `reportError` carrega `req.body`/nome/ID de paciente-prestador (regra dura CLAUDE.md).
 */

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { cellsOfRequest, cellKey } from '@modules/identity/permissions';
import { createAnaCareShiftsSource } from '../../infrastructure/FakeAnaCareShiftsSource';
import { AnaCareHoursService } from '../../application/AnaCareHoursService';
import { AnaCareHoursServiceError } from '../../domain/AnaCareShift';
import {
  monthParamsSchema,
  monthPatientParamsSchema,
  monthQuerySchema,
  shiftParamsSchema,
  validateBatchBodySchema,
  contestShiftBodySchema,
} from '../validators/anacareHoursSchemas';

const CLINICAL_READ_CELL = cellKey('patient_clinical', 'read');

const ERROR_STATUS: Record<string, number> = {
  RETRATO_DESATUALIZADO: 409,
  JA_VALIDADO: 409,
  NOTA_OBRIGATORIA: 400,
  TURNO_NAO_ENCONTRADO: 404,
};

export class AnaCareHoursController {
  constructor(private readonly serviceFactory: () => AnaCareHoursService | null = () => AnaCareHoursController.defaultServiceFactory()) {}

  private static defaultServiceFactory(): AnaCareHoursService | null {
    const source = createAnaCareShiftsSource();
    return source ? new AnaCareHoursService(source) : null;
  }

  private actorUid(req: Request): string {
    return AuthMiddleware.getAuthContext(req)?.principal.id ?? 'unknown';
  }

  private canReadNote(req: Request): boolean {
    return (cellsOfRequest(req) ?? []).includes(CLINICAL_READ_CELL);
  }

  private requireService(res: Response): AnaCareHoursService | null {
    const service = this.serviceFactory();
    if (!service) {
      res.status(503).json({ success: false, error: 'Ana Care source not configured', code: 'ANACARE_SOURCE_NOT_CONFIGURED' });
      return null;
    }
    return service;
  }

  private handleError(res: Response, err: unknown, source: string): void {
    if (err instanceof AnaCareHoursServiceError) {
      const status = ERROR_STATUS[err.code] ?? 400;
      res.status(status).json({ success: false, error: err.code, code: err.code });
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source });
    res.status(500).json({ success: false, error: 'Internal error' });
  }

  async getMonthSnapshot(req: Request, res: Response): Promise<void> {
    const params = monthParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid month' });
      return;
    }
    const query = monthQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ success: false, error: 'Invalid query' });
      return;
    }
    const service = this.requireService(res);
    if (!service) return;
    try {
      const snapshot = await service.getMonthSnapshot(params.data.month, this.canReadNote(req), query.data);
      res.status(200).json({ success: true, data: snapshot });
    } catch (err) {
      this.handleError(res, err, 'AnaCareHoursController:getMonthSnapshot');
    }
  }

  async getPatientMonth(req: Request, res: Response): Promise<void> {
    const params = monthPatientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const service = this.requireService(res);
    if (!service) return;
    try {
      const patient = await service.getPatientMonth(params.data.month, params.data.patientId, this.canReadNote(req));
      if (!patient) {
        res.status(404).json({ success: false, error: 'Patient not found in month' });
        return;
      }
      res.status(200).json({ success: true, data: patient });
    } catch (err) {
      this.handleError(res, err, 'AnaCareHoursController:getPatientMonth');
    }
  }

  async validateShift(req: Request, res: Response): Promise<void> {
    const params = shiftParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const service = this.requireService(res);
    if (!service) return;
    try {
      await service.validateShift(params.data.shiftId, this.actorUid(req));
      res.status(204).send();
    } catch (err) {
      this.handleError(res, err, 'AnaCareHoursController:validateShift');
    }
  }

  async validateBatch(req: Request, res: Response): Promise<void> {
    const body = validateBatchBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    const service = this.requireService(res);
    if (!service) return;
    try {
      const results = await service.validateBatch(body.data.shiftIds, this.actorUid(req));
      res.status(200).json({ success: true, data: { results } });
    } catch (err) {
      this.handleError(res, err, 'AnaCareHoursController:validateBatch');
    }
  }

  async contestShift(req: Request, res: Response): Promise<void> {
    const params = shiftParamsSchema.safeParse(req.params);
    const body = contestShiftBodySchema.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ success: false, error: 'Invalid body or params' });
      return;
    }
    const service = this.requireService(res);
    if (!service) return;
    try {
      await service.contestShift(params.data.shiftId, body.data.reason, body.data.note);
      res.status(204).send();
    } catch (err) {
      this.handleError(res, err, 'AnaCareHoursController:contestShift');
    }
  }
}
