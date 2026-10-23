import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { AuthMiddleware } from '@modules/identity';
import { CreateSubstitutionRequestUseCase } from '../../application/CreateSubstitutionRequestUseCase';
import { PreviewSubstitutionRequestUseCase } from '../../application/PreviewSubstitutionRequestUseCase';
import { ListSubstitutionRequestsUseCase } from '../../application/ListSubstitutionRequestsUseCase';
import { ListOutgoingCandidatesUseCase } from '../../application/ListOutgoingCandidatesUseCase';
import { UndoSubstitutionRequestUseCase } from '../../application/UndoSubstitutionRequestUseCase';
import { AssignSubstitutionCoverUseCase } from '../../application/AssignSubstitutionCoverUseCase';
import { AllocationRestoreConflictError } from '../../application/restoreTitular';
import {
  SubstitutionNoShiftsInPeriodError,
  SubstitutionPeriodInPastError,
  SubstitutionServiceNotFoundError,
  SubstitutionShiftsMismatchError,
  SubstitutionRequestNotFoundError,
  SubstitutionRequestAlreadyUndoneError,
  SubstitutionRequestNotUndoableError,
  SubstitutionNothingToCoverError,
  WorkerHasPendingEntryError,
  WorkerHasScheduledExitError,
} from '../../application/substitutionRequestErrors';
import {
  AbsenceAlreadyCoveredError,
  AbsenceCancelledError,
  AbsenceAlreadyExistsError,
  AbsenceDateInPastError,
  AbsenceOutsideAllocationError,
  AbsenceWeekdayMismatchError,
  SubstituteIsTitularError,
} from '../../application/ItineraryAbsenceUseCase';
import {
  AllocationNotActiveError,
  AlreadyAllocatedInSlotError,
  NotSelectedForServiceError,
} from '../../application/ItineraryAllocationUseCase';
import {
  DestinationNotAvailableForScheduledError,
  DestinationRequiredError,
  ServiceExitReasonInvalidError,
  ServiceExitReasonRequiredError,
} from '../../domain/serviceExitReason';
import { ServiceTeamWorkerAllocatedError } from '../../application/ServiceTeamMarkUseCase';
import { ItineraryOverlapError, overlapMessage } from '../../domain/itineraryOverlap';
import { insuranceErrorBody } from './insuranceErrorResponse';
import {
  substitutionCoverBodySchema,
  substitutionCreateBodySchema,
  substitutionListQuerySchema,
  substitutionPreviewBodySchema,
  substitutionRequestParamsSchema,
  substitutionServiceParamsSchema,
} from '../validators/substitutionRequestSchemas';

/**
 * AdminSubstitutionRequestController — o pedido de substituição (spec 069): listar (Próximas/Pasadas), pessoas que podem "não
 * vir", pré-visão, criação (DIAS e "No vuelve más"), desfazer e "Elegir quién entra". Sem lógica de negócio: valida forma (zod), despacha e mapeia erro de domínio → HTTP.
 * Ator por `AuthMiddleware.getAuthContext(req)?.principal.id`; ausente = 401, sem `?? 'unknown'`. `reportError` nunca leva id de
 * prestador. Nome de prestador (lista/candidatos) sai pela célula `worker_contact:read` e entra na trilha de contato.
 */
export class AdminSubstitutionRequestController {
  constructor(
    private readonly listUseCase: ListSubstitutionRequestsUseCase = new ListSubstitutionRequestsUseCase(),
    private readonly outgoingUseCase: ListOutgoingCandidatesUseCase = new ListOutgoingCandidatesUseCase(),
    private readonly previewUseCase: PreviewSubstitutionRequestUseCase = new PreviewSubstitutionRequestUseCase(),
    private readonly createUseCase: CreateSubstitutionRequestUseCase = new CreateSubstitutionRequestUseCase(),
    private readonly undoUseCase: UndoSubstitutionRequestUseCase = new UndoSubstitutionRequestUseCase(),
    private readonly coverUseCase: AssignSubstitutionCoverUseCase = new AssignSubstitutionCoverUseCase(),
  ) {}

  /** GET .../contracted-services/:sid/substitution-requests?when=upcoming|past */
  async list(req: Request, res: Response): Promise<void> {
    const params = substitutionServiceParamsSchema.safeParse(req.params);
    const query = substitutionListQuerySchema.safeParse(req.query);
    if (!params.success || !query.success) {
      res.status(400).json({ success: false, error: params.success ? 'Invalid query' : 'Invalid params' });
      return;
    }
    const { id: patientId, sid: serviceId } = params.data;
    try {
      const data = await this.listUseCase.execute({ patientId, serviceId, when: query.data.when, cells: req.permissionCells ?? null });
      const named = data.requests.flatMap((r) => [
        ...(r.outgoingDisplayName !== null ? [r.outgoingWorkerId] : []),
        ...r.shifts.flatMap((s, i) => (s.workerId !== null && r.shiftDisplayNames[i] !== null ? [s.workerId] : [])),
      ]);
      emitirTrilhaDeContato(req, [...new Set(named)]);
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      this.handleError(err, res, 'list', patientId, serviceId);
    }
  }

  /** GET .../contracted-services/:sid/substitution-requests/outgoing-options */
  async outgoingOptions(req: Request, res: Response): Promise<void> {
    const params = substitutionServiceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const { id: patientId, sid: serviceId } = params.data;
    try {
      const data = await this.outgoingUseCase.execute({ patientId, serviceId, cells: req.permissionCells ?? null });
      emitirTrilhaDeContato(req, data.filter((w) => w.displayName !== null).map((w) => w.workerId));
      res.status(200).json({ success: true, data: { workers: data } });
    } catch (err: unknown) {
      this.handleError(err, res, 'outgoingOptions', patientId, serviceId);
    }
  }

  /** POST .../contracted-services/:sid/substitution-requests/preview — LEITURA (nunca escreve). */
  async preview(req: Request, res: Response): Promise<void> {
    const params = substitutionServiceParamsSchema.safeParse(req.params);
    const body = substitutionPreviewBodySchema.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ success: false, error: params.success ? 'Invalid body' : 'Invalid params' });
      return;
    }
    const { id: patientId, sid: serviceId } = params.data;
    try {
      const data = await this.previewUseCase.execute({ patientId, serviceId, ...body.data });
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      this.handleError(err, res, 'preview', patientId, serviceId);
    }
  }

  /** POST .../contracted-services/:sid/substitution-requests */
  async create(req: Request, res: Response): Promise<void> {
    const params = substitutionServiceParamsSchema.safeParse(req.params);
    const body = substitutionCreateBodySchema.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ success: false, error: params.success ? 'Invalid body' : 'Invalid params' });
      return;
    }
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) {
      res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
      return;
    }
    const { id: patientId, sid: serviceId } = params.data;
    try {
      const data = await this.createUseCase.execute({ patientId, serviceId, ...body.data, actorUid });
      res.status(201).json({ success: true, data });
    } catch (err: unknown) {
      this.handleError(err, res, 'create', patientId, serviceId);
    }
  }

  /** POST .../substitution-requests/:rid/undo */
  async undo(req: Request, res: Response): Promise<void> {
    const params = substitutionRequestParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) {
      res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
      return;
    }
    const { id: patientId, sid: serviceId, rid: requestId } = params.data;
    try {
      const data = await this.undoUseCase.execute({ patientId, serviceId, requestId, actorUid });
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      this.handleError(err, res, 'undo', patientId, serviceId);
    }
  }

  /** POST .../substitution-requests/:rid/cover — "Elegir quién entra". */
  async cover(req: Request, res: Response): Promise<void> {
    const params = substitutionRequestParamsSchema.safeParse(req.params);
    const body = substitutionCoverBodySchema.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ success: false, error: params.success ? 'Invalid body' : 'Invalid params' });
      return;
    }
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) {
      res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
      return;
    }
    const { id: patientId, sid: serviceId, rid: requestId } = params.data;
    try {
      const data = await this.coverUseCase.execute({ patientId, serviceId, requestId, substituteWorkerId: body.data.substituteWorkerId, actorUid });
      res.status(200).json({ success: true, data });
    } catch (err: unknown) {
      this.handleError(err, res, 'cover', patientId, serviceId);
    }
  }

  private handleError(err: unknown, res: Response, method: string, patientId: string, serviceId: string): void {
    const unprocessable = (code: string): void => void res.status(422).json({ success: false, code });
    if (err instanceof SubstitutionServiceNotFoundError || err instanceof SubstitutionRequestNotFoundError) return void res.status(404).json({ success: false, code: 'NOT_FOUND' });
    if (err instanceof DestinationRequiredError) return unprocessable('DESTINATION_REQUIRED');
    if (err instanceof DestinationNotAvailableForScheduledError) return unprocessable('DESTINATION_NOT_AVAILABLE_FOR_SCHEDULED');
    if (err instanceof AlreadyAllocatedInSlotError) return unprocessable('ALREADY_ALLOCATED_IN_SLOT');
    if (err instanceof AllocationNotActiveError) return unprocessable('ALLOCATION_NOT_ACTIVE');
    if (err instanceof ServiceTeamWorkerAllocatedError) return unprocessable('SERVICE_TEAM_WORKER_ALLOCATED');
    if (err instanceof WorkerHasPendingEntryError) return void res.status(409).json({ success: false, code: 'WORKER_HAS_PENDING_ENTRY' });
    if (err instanceof WorkerHasScheduledExitError) return void res.status(409).json({ success: false, code: 'WORKER_HAS_SCHEDULED_EXIT', exitDate: err.exitDate });
    if (err instanceof AbsenceCancelledError) return void res.status(409).json({ success: false, code: 'ABSENCE_CANCELLED' });
    if (err instanceof AbsenceAlreadyCoveredError) return void res.status(409).json({ success: false, code: 'ALREADY_COVERED' });
    if (err instanceof SubstitutionRequestAlreadyUndoneError) return void res.status(409).json({ success: false, code: 'REQUEST_ALREADY_UNDONE' });
    if (err instanceof SubstitutionRequestNotUndoableError) return void res.status(409).json({ success: false, code: 'REQUEST_NOT_UNDOABLE' });
    if (err instanceof SubstitutionNothingToCoverError) return void res.status(409).json({ success: false, code: 'NOTHING_TO_COVER' });
    if (err instanceof AllocationRestoreConflictError) return void res.status(409).json({ success: false, code: 'ALLOCATION_RESTORE_CONFLICT' });
    if (err instanceof ServiceExitReasonRequiredError) return unprocessable('REASON_REQUIRED');
    if (err instanceof ServiceExitReasonInvalidError) return unprocessable('REASON_INVALID');
    if (err instanceof SubstitutionNoShiftsInPeriodError) return unprocessable('SUBSTITUTION_NO_SHIFTS_IN_PERIOD');
    if (err instanceof SubstitutionShiftsMismatchError) return unprocessable('SUBSTITUTION_SHIFTS_MISMATCH');
    if (err instanceof SubstitutionPeriodInPastError || err instanceof AbsenceDateInPastError) return unprocessable('ABSENCE_DATE_IN_PAST');
    if (err instanceof NotSelectedForServiceError) {
      res.status(422).json({ success: false, code: 'NOT_SELECTED_FOR_SERVICE', error: 'não está em Selecionado do serviço' });
      return;
    }
    if (err instanceof AbsenceWeekdayMismatchError) return unprocessable('ABSENCE_WEEKDAY_MISMATCH');
    if (err instanceof AbsenceOutsideAllocationError) return unprocessable('ABSENCE_OUTSIDE_ALLOCATION');
    if (err instanceof SubstituteIsTitularError) return unprocessable('SUBSTITUTE_IS_TITULAR');
    if (err instanceof AbsenceAlreadyExistsError) return void res.status(409).json({ success: false, code: 'ABSENCE_ALREADY_EXISTS' });
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
    // Erro CONHECIDO de banco (P0001 da Trava A `ITINERARY_SLOT_CAPACITY_EXCEEDED` etc., 23514, 23P01) sai pelo mapa único; o inesperado segue para 500.
    const mapped = insuranceErrorBody(err);
    if (mapped) return void res.status(mapped.status).json(mapped.body);
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminSubstitutionRequestController:${method}`, patientId, serviceId });
    res.status(500).json({ success: false, error: 'Failed to process substitution request' });
  }
}
