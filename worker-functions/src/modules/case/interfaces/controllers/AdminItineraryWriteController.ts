import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { GetServiceTeamUseCase, ServiceTeamNotFoundError, type GetServiceTeamResult } from '../../application/GetServiceTeamUseCase';
import {
  ItinerarySlotWriteUseCase,
  ItineraryServiceNotFoundError,
  ServiceWithoutAddressError,
  SlotAlreadyExistsError,
  SlotNotFoundError,
  SlotInactiveError,
  SlotHasActiveAllocationError,
} from '../../application/ItinerarySlotWriteUseCase';
import {
  ItineraryAllocationUseCase,
  NotSelectedForServiceError,
  AlreadyAllocatedInSlotError,
  AllocationNotFoundError,
  AllocationNotActiveError,
} from '../../application/ItineraryAllocationUseCase';
import {
  AssembleItineraryUseCase,
  ItineraryPatientNotFoundError,
  NoServiceWithVacancyError,
  ServiceWithoutSlotError,
} from '../../application/AssembleItineraryUseCase';
import { ItineraryOverlapError, overlapMessage } from '../../domain/itineraryOverlap';
import {
  itineraryPatientParamsSchema,
  itineraryServiceParamsSchema,
  itinerarySlotParamsSchema,
  itineraryAllocationParamsSchema,
  itinerarySlotBodySchema,
  itineraryAllocationBodySchema,
} from '../validators/itineraryWriteSchemas';

/**
 * AdminItineraryWriteController — os 7 escritores do itinerário (Fase 11, DX-11.9/DX-11.10):
 *
 *   GET   /patients/:id/contracted-services/:sid/allocation-options
 *   POST  /patients/:id/contracted-services/:sid/itinerary/slots
 *   PATCH /patients/:id/contracted-services/:sid/itinerary/slots/:slotId
 *   POST  /patients/:id/contracted-services/:sid/itinerary/slots/:slotId/end
 *   POST  /patients/:id/contracted-services/:sid/itinerary/slots/:slotId/allocations
 *   POST  /patients/:id/contracted-services/:sid/itinerary/allocations/:allocationId/end
 *   POST  /patients/:id/itinerary/assemble
 *
 * Sem lógica de negócio: os 4 casos de uso (`GetServiceTeamUseCase`/`ItinerarySlotWriteUseCase`/
 * `ItineraryAllocationUseCase`/`AssembleItineraryUseCase`) decidem tudo — o controller só valida
 * forma (zod), despacha e mapeia erro de domínio → HTTP (molde `AdminServiceTeamController.ts:32-139`,
 * construtor não abre banco). Ator por `AuthMiddleware.getAuthContext(req)?.principal.id`; ausente
 * = 401 `UNAUTHENTICATED`, sem `?? 'unknown'` (molde `:82-86`) — nas 6 escritas; a leitura
 * (`allocationOptions`) não grava nada e não exige ator, mesmo molde do `GET` do quadro C/itinerário.
 * `reportError` nunca leva `workerId`.
 */
export class AdminItineraryWriteController {
  constructor(
    private readonly teamUseCase: GetServiceTeamUseCase = new GetServiceTeamUseCase(),
    private readonly slotUseCase: ItinerarySlotWriteUseCase = new ItinerarySlotWriteUseCase(),
    private readonly allocationUseCase: ItineraryAllocationUseCase = new ItineraryAllocationUseCase(),
    private readonly assemblyUseCase: AssembleItineraryUseCase = new AssembleItineraryUseCase(),
  ) {}

  /** GET .../contracted-services/:sid/allocation-options */
  async allocationOptions(req: Request, res: Response): Promise<void> {
    const params = itineraryServiceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const { id: patientId, sid: serviceId } = params.data;
    try {
      const team = await this.teamUseCase.execute({ patientId, serviceId, cells: req.permissionCells ?? null });
      emitirTrilhaDeContato(req, this.optionsWorkerIds(team));
      res.status(200).json({ success: true, data: { serviceId: team.serviceId, vacancyId: team.vacancyId, options: team.selected } });
    } catch (err: unknown) {
      this.handleError(err, res, 'allocationOptions', patientId, serviceId);
    }
  }

  /** POST .../contracted-services/:sid/itinerary/slots */
  async createSlot(req: Request, res: Response): Promise<void> {
    const params = itineraryServiceParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = itinerarySlotBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId, sid: serviceId } = params.data;
    try {
      const slot = await this.slotUseCase.create({ patientId, serviceId, ...body.data, actorUid });
      res.status(201).json({ success: true, data: slot });
    } catch (err: unknown) {
      this.handleError(err, res, 'createSlot', patientId, serviceId);
    }
  }

  /** PATCH .../contracted-services/:sid/itinerary/slots/:slotId */
  async updateSlot(req: Request, res: Response): Promise<void> {
    const params = itinerarySlotParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = itinerarySlotBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId, sid: serviceId, slotId } = params.data;
    try {
      const slot = await this.slotUseCase.update({ patientId, serviceId, slotId, ...body.data, actorUid });
      res.status(200).json({ success: true, data: slot });
    } catch (err: unknown) {
      this.handleError(err, res, 'updateSlot', patientId, serviceId);
    }
  }

  /** POST .../contracted-services/:sid/itinerary/slots/:slotId/end */
  async endSlot(req: Request, res: Response): Promise<void> {
    const params = itinerarySlotParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId, sid: serviceId, slotId } = params.data;
    try {
      await this.slotUseCase.end({ patientId, serviceId, slotId, actorUid });
      res.status(200).json({ success: true, data: { slotId } });
    } catch (err: unknown) {
      this.handleError(err, res, 'endSlot', patientId, serviceId);
    }
  }

  /** POST .../contracted-services/:sid/itinerary/slots/:slotId/allocations */
  async allocate(req: Request, res: Response): Promise<void> {
    const params = itinerarySlotParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const body = itineraryAllocationBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ success: false, error: 'Invalid body' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId, sid: serviceId, slotId } = params.data;
    try {
      const allocation = await this.allocationUseCase.allocate({
        patientId,
        serviceId,
        slotId,
        workerId: body.data.workerId,
        actorUid,
      });
      res.status(201).json({ success: true, data: allocation });
    } catch (err: unknown) {
      this.handleError(err, res, 'allocate', patientId, serviceId);
    }
  }

  /** POST .../contracted-services/:sid/itinerary/allocations/:allocationId/end */
  async endAllocation(req: Request, res: Response): Promise<void> {
    const params = itineraryAllocationParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId, sid: serviceId, allocationId } = params.data;
    try {
      const result = await this.allocationUseCase.end({ patientId, serviceId, allocationId, actorUid });
      res.status(200).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'endAllocation', patientId, serviceId);
    }
  }

  /** POST /patients/:id/itinerary/assemble */
  async assemble(req: Request, res: Response): Promise<void> {
    const params = itineraryPatientParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ success: false, error: 'Invalid params' });
      return;
    }
    const actorUid = this.requireActor(req, res);
    if (actorUid === null) return;
    const { id: patientId } = params.data;
    try {
      const result = await this.assemblyUseCase.execute({ patientId, actorUid });
      res.status(201).json({ success: true, data: result });
    } catch (err: unknown) {
      this.handleError(err, res, 'assemble', patientId);
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

  /** Só os `workerId` de `selected` (a única lista devolvida por `allocationOptions`) cujo `displayName` saiu NÃO-nulo. */
  private optionsWorkerIds(team: GetServiceTeamResult): Array<string | null | undefined> {
    return team.selected.filter((member) => member.displayName !== null).map((member) => member.workerId);
  }

  private handleError(err: unknown, res: Response, method: string, patientId: string, serviceId?: string): void {
    // Os 4 "não encontrado" da DX-11.10, mais `SlotNotFoundError` (update/end/allocate de slot
    // inexistente — fonte única em `ItinerarySlotWriteUseCase`, também usada pelo
    // `ItineraryAllocationUseCase`) e `ServiceTeamNotFoundError` (`allocationOptions`, reuso do
    // `GetServiceTeamUseCase` da Fase 10) — mesma família 404, DESVIO documentado no retorno do passo.
    if (
      err instanceof ItineraryServiceNotFoundError ||
      err instanceof SlotNotFoundError ||
      err instanceof AllocationNotFoundError ||
      err instanceof ItineraryPatientNotFoundError ||
      err instanceof ServiceTeamNotFoundError
    ) {
      res.status(404).json({ success: false, code: 'NOT_FOUND' });
      return;
    }
    if (err instanceof ServiceWithoutAddressError) {
      res.status(422).json({ success: false, code: 'SERVICE_WITHOUT_ADDRESS' });
      return;
    }
    if (err instanceof SlotInactiveError) {
      res.status(422).json({ success: false, code: 'SLOT_INACTIVE' });
      return;
    }
    if (err instanceof SlotHasActiveAllocationError) {
      res.status(422).json({ success: false, code: 'SLOT_HAS_ACTIVE_ALLOCATION' });
      return;
    }
    if (err instanceof SlotAlreadyExistsError) {
      res.status(409).json({ success: false, code: 'SLOT_ALREADY_EXISTS' });
      return;
    }
    if (err instanceof NotSelectedForServiceError) {
      res.status(422).json({ success: false, code: 'NOT_SELECTED_FOR_SERVICE', error: 'não está em Selecionado do serviço' });
      return;
    }
    if (err instanceof AlreadyAllocatedInSlotError) {
      res.status(422).json({ success: false, code: 'ALREADY_ALLOCATED_IN_SLOT' });
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
    if (err instanceof AllocationNotActiveError) {
      res.status(422).json({ success: false, code: 'ALLOCATION_NOT_ACTIVE' });
      return;
    }
    if (err instanceof NoServiceWithVacancyError) {
      res.status(422).json({ success: false, code: 'NO_SERVICE_WITH_VACANCY' });
      return;
    }
    if (err instanceof ServiceWithoutSlotError) {
      res.status(422).json({ success: false, code: 'SERVICE_WITHOUT_SLOT', services: err.services });
      return;
    }
    const e = err instanceof Error ? err : new Error(String(err));
    reportError(e, { source: `AdminItineraryWriteController:${method}`, patientId, serviceId });
    res.status(500).json({ success: false, error: 'Failed to process itinerary request' });
  }
}
