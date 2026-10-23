import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { AuthMiddleware } from '@modules/identity';
import { CreateSubstitutionRequestUseCase } from '../../application/CreateSubstitutionRequestUseCase';
import { PreviewSubstitutionRequestUseCase } from '../../application/PreviewSubstitutionRequestUseCase';
import { ListSubstitutionRequestsUseCase } from '../../application/ListSubstitutionRequestsUseCase';
import { ListOutgoingCandidatesUseCase } from '../../application/ListOutgoingCandidatesUseCase';
import {
  SubstitutionNoShiftsInPeriodError,
  SubstitutionPeriodInPastError,
  SubstitutionServiceNotFoundError,
  SubstitutionShiftsMismatchError,
} from '../../application/substitutionRequestErrors';
import {
  AbsenceAlreadyExistsError,
  AbsenceDateInPastError,
  AbsenceOutsideAllocationError,
  AbsenceWeekdayMismatchError,
  SubstituteIsTitularError,
} from '../../application/ItineraryAbsenceUseCase';
import { NotSelectedForServiceError } from '../../application/ItineraryAllocationUseCase';
import { ServiceExitReasonInvalidError, ServiceExitReasonRequiredError } from '../../domain/serviceExitReason';
import { ItineraryOverlapError, overlapMessage } from '../../domain/itineraryOverlap';
import {
  substitutionCreateBodySchema,
  substitutionListQuerySchema,
  substitutionPreviewBodySchema,
  substitutionServiceParamsSchema,
} from '../validators/substitutionRequestSchemas';

/**
 * AdminSubstitutionRequestController — o pedido de substituição (spec 069): listar (Próximas/Pasadas), pessoas que podem "não
 * vir", pré-visão e criação (parte DIAS). Sem lógica de negócio: valida forma (zod), despacha e mapeia erro de domínio → HTTP.
 * Ator por `AuthMiddleware.getAuthContext(req)?.principal.id`; ausente = 401, sem `?? 'unknown'`. `reportError` nunca leva id de
 * prestador. Nome de prestador (lista/candidatos) sai pela célula `worker_contact:read` e entra na trilha de contato.
 */
export class AdminSubstitutionRequestController {
  constructor(
    private readonly listUseCase: ListSubstitutionRequestsUseCase = new ListSubstitutionRequestsUseCase(),
    private readonly outgoingUseCase: ListOutgoingCandidatesUseCase = new ListOutgoingCandidatesUseCase(),
    private readonly previewUseCase: PreviewSubstitutionRequestUseCase = new PreviewSubstitutionRequestUseCase(),
    private readonly createUseCase: CreateSubstitutionRequestUseCase = new CreateSubstitutionRequestUseCase(),
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

  private handleError(err: unknown, res: Response, method: string, patientId: string, serviceId: string): void {
    const unprocessable = (code: string): void => void res.status(422).json({ success: false, code });
    if (err instanceof SubstitutionServiceNotFoundError) return void res.status(404).json({ success: false, code: 'NOT_FOUND' });
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
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminSubstitutionRequestController:${method}`, patientId, serviceId });
    res.status(500).json({ success: false, error: 'Failed to process substitution request' });
  }
}
