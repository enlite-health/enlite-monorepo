/**
 * AdminItineraryWriteController (Fase 11, DX-11.10). GET allocationOptions → 200, sem ator;
 * createSlot/allocate/assemble → 201; updateSlot/endSlot/endAllocation → 200; 400 só de forma;
 * sem ator nas 6 escritas → 401, 0 chamada ao caso de uso; erro de domínio → status/código da DX;
 * erro inesperado → 500 + reportError { source, patientId, serviceId? } SEM workerId.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/audit/contactAccessFromRequest', () => ({ emitirTrilhaDeContato: jest.fn() }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { AuthMiddleware } from '@modules/identity';
import { AdminItineraryWriteController } from '../AdminItineraryWriteController';
import { GetServiceTeamUseCase, ServiceTeamNotFoundError, type GetServiceTeamResult } from '../../../application/GetServiceTeamUseCase';
import {
  ItinerarySlotWriteUseCase,
  ItineraryServiceNotFoundError,
  ServiceWithoutAddressError,
  SlotAlreadyExistsError,
  SlotNotFoundError,
  SlotInactiveError,
  SlotHasActiveAllocationError,
} from '../../../application/ItinerarySlotWriteUseCase';
import {
  ItineraryAllocationUseCase,
  NotSelectedForServiceError,
  AlreadyAllocatedInSlotError,
  AllocationNotFoundError,
  AllocationNotActiveError,
} from '../../../application/ItineraryAllocationUseCase';
import {
  AssembleItineraryUseCase,
  ItineraryPatientNotFoundError,
  NoServiceWithVacancyError,
  ServiceWithoutSlotError,
} from '../../../application/AssembleItineraryUseCase';
import { ItineraryOverlapError } from '../../../domain/itineraryOverlap';

const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const SERVICE_ID = '22222222-2222-2222-2222-222222222222';
const SLOT_ID = '33333333-3333-3333-3333-333333333333';
const ALLOCATION_ID = '44444444-4444-4444-4444-444444444444';
const WORKER_ID = '55555555-5555-5555-5555-555555555555';
const SLOT_BODY = { weekday: 1, startTime: '08:00', endTime: '12:00' };

function reqRes(params: Record<string, unknown> = {}, body: Record<string, unknown> = {}, actorId: string | null = 'staff-1'): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const req = { params, body, query: {} } as unknown as Request;
  (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(actorId ? { principal: { id: actorId } } : undefined);
  return [req, { json, status } as unknown as Response];
}

function team(overrides: Partial<GetServiceTeamResult> = {}): GetServiceTeamResult {
  return {
    serviceId: SERVICE_ID,
    vacancyId: 'vac-1',
    asOf: '2026-09-28',
    selected: [{ workerId: WORKER_ID, displayName: 'Maria Perez', vacancyId: 'vac-1' }],
    inService: [{ workerId: 'w-in-service', displayName: 'Someone', vacancyId: 'vac-1' }],
    rejected: [{ workerId: 'w-redigido', displayName: null, vacancyId: 'vac-1', reasonCategory: 'OTHER' }],
    ...overrides,
  };
}

function jsonOf(res: Response): jest.Mock {
  return (res as unknown as { json: jest.Mock }).json;
}

describe('AdminItineraryWriteController', () => {
  const teamUseCase = { execute: jest.fn() };
  const slotUseCase = { create: jest.fn(), update: jest.fn(), end: jest.fn() };
  const allocationUseCase = { allocate: jest.fn(), end: jest.fn() };
  const assemblyUseCase = { execute: jest.fn() };
  const ctrl = new AdminItineraryWriteController(
    teamUseCase as unknown as GetServiceTeamUseCase,
    slotUseCase as unknown as ItinerarySlotWriteUseCase,
    allocationUseCase as unknown as ItineraryAllocationUseCase,
    assemblyUseCase as unknown as AssembleItineraryUseCase,
  );
  beforeEach(() => jest.clearAllMocks());

  it('allocationOptions: params inválidos → 400, o caso de uso não roda', async () => {
    const [req, res] = reqRes({ id: 'not-a-uuid', sid: SERVICE_ID });
    await ctrl.allocationOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(teamUseCase.execute).not.toHaveBeenCalled();
  });

  it('allocationOptions: feliz → 200, data só com selected; trilha só com displayName não nulo de selected', async () => {
    teamUseCase.execute.mockResolvedValueOnce(team());
    const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
    await ctrl.allocationOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: { serviceId: SERVICE_ID, vacancyId: 'vac-1', options: team().selected } });
    expect(teamUseCase.execute).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, cells: null });
    expect(emitirTrilhaDeContato).toHaveBeenCalledWith(req, [WORKER_ID]);
  });

  it('allocationOptions: ServiceTeamNotFoundError → 404 NOT_FOUND (reuso do quadro C — fora da lista literal da DX, mesma família)', async () => {
    teamUseCase.execute.mockRejectedValueOnce(new ServiceTeamNotFoundError(PATIENT_ID, SERVICE_ID));
    const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
    await ctrl.allocationOptions(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(jsonOf(res)).toHaveBeenCalledWith({ success: false, code: 'NOT_FOUND' });
  });

  describe('createSlot (POST .../itinerary/slots)', () => {
    it('params inválidos → 400', async () => {
      const [req, res] = reqRes({ id: 'x', sid: SERVICE_ID }, SLOT_BODY);
      await ctrl.createSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(slotUseCase.create).not.toHaveBeenCalled();
    });

    it.each([
      ['dia 7', { ...SLOT_BODY, weekday: 7 }],
      ['hora sem 2 dígitos', { ...SLOT_BODY, startTime: '8:00' }],
      ['fim = início', { ...SLOT_BODY, endTime: SLOT_BODY.startTime }],
    ])('corpo inválido (%s) → 400', async (_titulo, body) => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, body);
      await ctrl.createSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(slotUseCase.create).not.toHaveBeenCalled();
    });

    it('sem ator → 401, o caso de uso NUNCA roda', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, SLOT_BODY, null);
      await ctrl.createSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: false, code: 'UNAUTHENTICATED' });
      expect(slotUseCase.create).not.toHaveBeenCalled();
    });

    it('feliz → 201 { success:true, data }, chama o caso de uso com o ator', async () => {
      const slotRow = { id: SLOT_ID, ...SLOT_BODY, active: true };
      slotUseCase.create.mockResolvedValueOnce(slotRow);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, SLOT_BODY);
      await ctrl.createSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: slotRow });
      expect(slotUseCase.create).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, ...SLOT_BODY, actorUid: 'staff-1' });
    });

    it.each([
      [new SlotAlreadyExistsError(SERVICE_ID, SLOT_BODY), 409, { success: false, code: 'SLOT_ALREADY_EXISTS' }],
      [new ServiceWithoutAddressError(SERVICE_ID), 422, { success: false, code: 'SERVICE_WITHOUT_ADDRESS' }],
      [new ItineraryServiceNotFoundError(PATIENT_ID, SERVICE_ID), 404, { success: false, code: 'NOT_FOUND' }],
    ])('%p → status %i', async (err, status, body) => {
      slotUseCase.create.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, SLOT_BODY);
      await ctrl.createSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(body);
    });

    it('erro inesperado → 500 + reportError, SEM workerId', async () => {
      slotUseCase.create.mockRejectedValueOnce(new Error('boom'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, SLOT_BODY);
      await ctrl.createSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][1]).not.toHaveProperty('workerId');
    });
  });

  describe('updateSlot (PATCH .../itinerary/slots/:slotId)', () => {
    it('params inválidos (sem slotId) → 400', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, SLOT_BODY);
      await ctrl.updateSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(slotUseCase.update).not.toHaveBeenCalled();
    });

    it('corpo inválido → 400', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, { ...SLOT_BODY, weekday: 9 });
      await ctrl.updateSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(slotUseCase.update).not.toHaveBeenCalled();
    });

    it('sem ator → 401', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, SLOT_BODY, null);
      await ctrl.updateSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(slotUseCase.update).not.toHaveBeenCalled();
    });

    it('feliz → 200 { success:true, data }', async () => {
      const slotRow = { id: SLOT_ID, weekday: 2, startTime: '09:00', endTime: '13:00', active: true };
      slotUseCase.update.mockResolvedValueOnce(slotRow);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, { weekday: 2, startTime: '09:00', endTime: '13:00' });
      await ctrl.updateSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: slotRow });
      expect(slotUseCase.update).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, slotId: SLOT_ID, weekday: 2, startTime: '09:00', endTime: '13:00', actorUid: 'staff-1' });
    });

    it.each([
      [new SlotNotFoundError(SERVICE_ID, SLOT_ID), 404, { success: false, code: 'NOT_FOUND' }],
      [new SlotInactiveError(SERVICE_ID, SLOT_ID), 422, { success: false, code: 'SLOT_INACTIVE' }],
      [new SlotHasActiveAllocationError(SERVICE_ID, SLOT_ID), 422, { success: false, code: 'SLOT_HAS_ACTIVE_ALLOCATION' }],
    ])('%p → status %i (SlotNotFoundError: classe própria de ItinerarySlotWriteUseCase, fora da lista literal da DX — mesma família)', async (err, status, body) => {
      slotUseCase.update.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, SLOT_BODY);
      await ctrl.updateSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(body);
    });
  });

  describe('endSlot (POST .../itinerary/slots/:slotId/end)', () => {
    it('params inválidos → 400', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
      await ctrl.endSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(slotUseCase.end).not.toHaveBeenCalled();
    });
    it('sem ator → 401', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, {}, null);
      await ctrl.endSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(slotUseCase.end).not.toHaveBeenCalled();
    });

    it('feliz → 200 { success:true, data:{slotId} }', async () => {
      slotUseCase.end.mockResolvedValueOnce(undefined);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID });
      await ctrl.endSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: { slotId: SLOT_ID } });
      expect(slotUseCase.end).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, slotId: SLOT_ID, actorUid: 'staff-1' });
    });

    it('SlotNotFoundError → 404 NOT_FOUND', async () => {
      slotUseCase.end.mockRejectedValueOnce(new SlotNotFoundError(SERVICE_ID, SLOT_ID));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID });
      await ctrl.endSlot(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: false, code: 'NOT_FOUND' });
    });
  });

  describe('allocate (POST .../itinerary/slots/:slotId/allocations)', () => {
    it.each([
      ['params inválidos', {}, { workerId: WORKER_ID }],
      ['workerId não-uuid', { slotId: SLOT_ID }, { workerId: 'not-a-uuid' }],
    ])('%s → 400', async (_titulo, extraParams, body) => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, ...extraParams }, body);
      await ctrl.allocate(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(allocationUseCase.allocate).not.toHaveBeenCalled();
    });

    it('sem ator → 401', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, { workerId: WORKER_ID }, null);
      await ctrl.allocate(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(allocationUseCase.allocate).not.toHaveBeenCalled();
    });

    it('feliz → 201 { success:true, data }', async () => {
      const result = { allocationId: ALLOCATION_ID, slotId: SLOT_ID, workerId: WORKER_ID, applicationId: 'app-1', validFrom: '2026-09-28', status: 'ACTIVE' as const };
      allocationUseCase.allocate.mockResolvedValueOnce(result);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, { workerId: WORKER_ID });
      await ctrl.allocate(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: result });
      expect(allocationUseCase.allocate).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, slotId: SLOT_ID, workerId: WORKER_ID, actorUid: 'staff-1' });
    });

    it.each([
      [new SlotNotFoundError(SERVICE_ID, SLOT_ID), 404, { success: false, code: 'NOT_FOUND' }],
      [new NotSelectedForServiceError(PATIENT_ID, SERVICE_ID, WORKER_ID), 422, { success: false, code: 'NOT_SELECTED_FOR_SERVICE', error: 'não está em Selecionado do serviço' }],
      [new AlreadyAllocatedInSlotError(SLOT_ID, WORKER_ID), 422, { success: false, code: 'ALREADY_ALLOCATED_IN_SLOT' }],
    ])('%p → status %i', async (err, status, body) => {
      allocationUseCase.allocate.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, { workerId: WORKER_ID });
      await ctrl.allocate(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(body);
    });

    it('ItineraryOverlapError → 409 com existing/requested/sameAddress/minGapMinutes e error = overlapMessage', async () => {
      const existing = { serviceId: SERVICE_ID, weekday: 1, startTime: '08:00', endTime: '12:00' };
      const requested = { serviceId: 'other-service', weekday: 1, startTime: '11:00', endTime: '15:00' };
      const err = new ItineraryOverlapError(existing, requested, false, 60);
      allocationUseCase.allocate.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, { workerId: WORKER_ID });
      await ctrl.allocate(req, res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(jsonOf(res)).toHaveBeenCalledWith({
        success: false,
        code: 'ITINERARY_OVERLAP',
        error: expect.stringContaining('folga mínima de 60 min'),
        existing,
        requested,
        sameAddress: false,
        minGapMinutes: 60,
      });
    });

    it('erro inesperado → 500 + reportError, SEM workerId', async () => {
      allocationUseCase.allocate.mockRejectedValueOnce(new Error('boom'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, slotId: SLOT_ID }, { workerId: WORKER_ID });
      await ctrl.allocate(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect((reportError as jest.Mock).mock.calls[0][1]).not.toHaveProperty('workerId');
    });
  });

  describe('endAllocation (POST .../itinerary/allocations/:allocationId/end)', () => {
    it('params inválidos → 400', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
      await ctrl.endAllocation(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(allocationUseCase.end).not.toHaveBeenCalled();
    });
    it('sem ator → 401', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID }, {}, null);
      await ctrl.endAllocation(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(allocationUseCase.end).not.toHaveBeenCalled();
    });

    it('feliz → 200 { success:true, data }', async () => {
      const result = { allocationId: ALLOCATION_ID, status: 'ENDED' as const, validTo: '2026-09-28' };
      allocationUseCase.end.mockResolvedValueOnce(result);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID });
      await ctrl.endAllocation(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: result });
      expect(allocationUseCase.end).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, allocationId: ALLOCATION_ID, actorUid: 'staff-1' });
    });

    it.each([
      [new AllocationNotFoundError(PATIENT_ID, SERVICE_ID, ALLOCATION_ID), 404, { success: false, code: 'NOT_FOUND' }],
      [new AllocationNotActiveError(ALLOCATION_ID), 422, { success: false, code: 'ALLOCATION_NOT_ACTIVE' }],
    ])('%p → status %i', async (err, status, body) => {
      allocationUseCase.end.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID });
      await ctrl.endAllocation(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(body);
    });
  });

  describe('assemble (POST /patients/:id/itinerary/assemble)', () => {
    it('params inválidos → 400', async () => {
      const [req, res] = reqRes({ id: 'not-a-uuid' });
      await ctrl.assemble(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(assemblyUseCase.execute).not.toHaveBeenCalled();
    });
    it('sem ator → 401, o caso de uso NUNCA roda', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID }, {}, null);
      await ctrl.assemble(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(assemblyUseCase.execute).not.toHaveBeenCalled();
    });

    it('feliz → 201 { success:true, data }', async () => {
      const result = { patientId: PATIENT_ID, assembledAt: '2026-09-28' };
      assemblyUseCase.execute.mockResolvedValueOnce(result);
      const [req, res] = reqRes({ id: PATIENT_ID });
      await ctrl.assemble(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: result });
      expect(assemblyUseCase.execute).toHaveBeenCalledWith({ patientId: PATIENT_ID, actorUid: 'staff-1' });
    });

    it.each([
      [new ItineraryPatientNotFoundError(PATIENT_ID), 404, { success: false, code: 'NOT_FOUND' }],
      [new NoServiceWithVacancyError(PATIENT_ID), 422, { success: false, code: 'NO_SERVICE_WITH_VACANCY' }],
      [new ServiceWithoutSlotError([{ serviceId: SERVICE_ID, serviceCode: 'AT' }]), 422, { success: false, code: 'SERVICE_WITHOUT_SLOT', services: [{ serviceId: SERVICE_ID, serviceCode: 'AT' }] }],
    ])('%p → status %i', async (err, status, body) => {
      assemblyUseCase.execute.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID });
      await ctrl.assemble(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(body);
    });

    it('erro inesperado → 500 + reportError { source, patientId }, SEM serviceId com valor e SEM workerId', async () => {
      assemblyUseCase.execute.mockRejectedValueOnce(new Error('boom'));
      const [req, res] = reqRes({ id: PATIENT_ID });
      await ctrl.assemble(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminItineraryWriteController:assemble', patientId: PATIENT_ID });
      const call = (reportError as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      expect(call).not.toHaveProperty('workerId');
      expect(call.serviceId).toBeUndefined();
    });
  });

  it('construtor sem casos de uso injetados constrói o real (não abre banco)', () => {
    expect(new AdminItineraryWriteController()).toBeInstanceOf(AdminItineraryWriteController);
  });
});
