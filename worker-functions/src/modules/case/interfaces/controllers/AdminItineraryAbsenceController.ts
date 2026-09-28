import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { ItineraryAbsenceUseCase, AbsenceNotFoundError, AbsenceCancelledError, AbsenceDateInPastError, AbsenceAlreadyExistsError, AbsenceWeekdayMismatchError, AbsenceOutsideAllocationError, SubstituteIsTitularError } from '../../application/ItineraryAbsenceUseCase';
import { AllocationNotFoundError, AllocationNotActiveError, NotSelectedForServiceError } from '../../application/ItineraryAllocationUseCase';
import { ItineraryOverlapError, overlapMessage } from '../../domain/itineraryOverlap';
import { itineraryAllocationParamsSchema, itineraryAbsenceParamsSchema, itineraryAbsenceBodySchema, itinerarySubstituteBodySchema } from '../validators/itineraryWriteSchemas';

/**
 * AdminItineraryAbsenceController — os 3 escritores da ausência pontual (Fase 13, DX-13.8): registrar,
 * pôr/tirar o substituto, cancelar. Molde `AdminItineraryWriteController.ts:57-120`: sem lógica de
 * negócio — o `ItineraryAbsenceUseCase` (P17) decide tudo, o controller só valida forma (zod),
 * despacha e mapeia erro de domínio → HTTP. Construtor não abre banco.
 *
 * Ator por `AuthMiddleware.getAuthContext(req)?.principal.id`; ausente = 401 `UNAUTHENTICATED`, sem
 * `?? 'unknown'` (mesmo molde da irmã) — nas 3 rotas (nenhuma leitura pura aqui, ao contrário de
 * `allocationOptions`). `reportError` nunca leva `workerId`; nenhuma chamada de log informativo ou
 * de alerta neste arquivo.
 *
 * Params de `register` REUSA `itineraryAllocationParamsSchema` (Fase 11 — a rota é
 * `.../allocations/:allocationId/absences`, o mesmo formato de `:allocationId` das irmãs);
 * `setSubstitute`/`cancel` usam o novo `itineraryAbsenceParamsSchema` (`:absenceId`).
 */
export class AdminItineraryAbsenceController {
  constructor(private readonly useCase: ItineraryAbsenceUseCase = new ItineraryAbsenceUseCase()) {}

  /** POST .../contracted-services/:sid/itinerary/allocations/:allocationId/absences */
  async register(req: Request, res: Response): Promise<void> {
    const params = itineraryAllocationParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = itineraryAbsenceBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId, sid: serviceId, allocationId } = params.data;
    try {
      const result = await this.useCase.register({
        patientId,
        serviceId,
        allocationId,
        date: body.data.date,
        substituteWorkerId: body.data.substituteWorkerId,
        actorUid,
      });
      res.status(201).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'register', patientId, serviceId);
    }
  }

  /** PATCH .../contracted-services/:sid/itinerary/absences/:absenceId/substitute */
  async setSubstitute(req: Request, res: Response): Promise<void> {
    const params = itineraryAbsenceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = itinerarySubstituteBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId, sid: serviceId, absenceId } = params.data;
    try {
      const result = await this.useCase.setSubstitute({
        patientId,
        serviceId,
        absenceId,
        substituteWorkerId: body.data.substituteWorkerId,
        actorUid,
      });
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'setSubstitute', patientId, serviceId);
    }
  }

  /** POST .../contracted-services/:sid/itinerary/absences/:absenceId/cancel */
  async cancel(req: Request, res: Response): Promise<void> {
    const params = itineraryAbsenceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId, sid: serviceId, absenceId } = params.data;
    try {
      const result = await this.useCase.cancel({ patientId, serviceId, absenceId, actorUid });
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'cancel', patientId, serviceId);
    }
  }

  /** Só o ator autenticado — 401 `UNAUTHENTICATED` sem `?? 'unknown'` (nunca autor fantasma). */
  private requireActor(req: Request, res: Response): string | null {
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) {
      res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
      return null;
    }
    return actorUid;
  }

  private handleError(err: unknown, res: Response, method: string, patientId: string, serviceId: string): void {
    if (err instanceof AllocationNotFoundError || err instanceof AbsenceNotFoundError) {
      res.status(404).json({ success: false, code: 'NOT_FOUND' });
      return;
    }
    if (err instanceof AllocationNotActiveError) {
      res.status(422).json({ success: false, code: 'ALLOCATION_NOT_ACTIVE' });
      return;
    }
    if (err instanceof NotSelectedForServiceError) {
      res.status(422).json({ success: false, code: 'NOT_SELECTED_FOR_SERVICE', error: 'não está em Selecionado do serviço' });
      return;
    }
    if (err instanceof AbsenceCancelledError) {
      res.status(422).json({ success: false, code: 'ABSENCE_CANCELLED' });
      return;
    }
    if (err instanceof AbsenceDateInPastError) {
      res.status(422).json({ success: false, code: 'ABSENCE_DATE_IN_PAST' });
      return;
    }
    if (err instanceof AbsenceAlreadyExistsError) {
      res.status(409).json({ success: false, code: 'ABSENCE_ALREADY_EXISTS' });
      return;
    }
    if (err instanceof AbsenceWeekdayMismatchError) {
      res.status(422).json({ success: false, code: 'ABSENCE_WEEKDAY_MISMATCH' });
      return;
    }
    if (err instanceof AbsenceOutsideAllocationError) {
      res.status(422).json({ success: false, code: 'ABSENCE_OUTSIDE_ALLOCATION' });
      return;
    }
    if (err instanceof SubstituteIsTitularError) {
      res.status(422).json({ success: false, code: 'SUBSTITUTE_IS_TITULAR' });
      return;
    }
    if (err instanceof ItineraryOverlapError) {
      res.status(409).json({
        success: false,
        code: 'ITINERARY_OVERLAP',
        error: overlapMessage(err),
        existing: err.existing,
        requested: err.requested,
        sameAddress: err.sameAddress,
        minGapMinutes: err.minGapMinutes,
      });
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminItineraryAbsenceController:${method}`, patientId, serviceId });
    res.status(500).json({ success: false, error: 'Failed to process itinerary absence request' });
  }
}
