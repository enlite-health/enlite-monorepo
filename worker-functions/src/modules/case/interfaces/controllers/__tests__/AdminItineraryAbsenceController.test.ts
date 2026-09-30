/**
 * AdminItineraryAbsenceController (Fase 13, DX-13.8). register → 201; setSubstitute/cancel → 200;
 * 400 só de forma; sem ator → 401, 0 chamada ao caso de uso; erro de domínio → status/código da DX;
 * erro inesperado → 500 + reportError { source, patientId, serviceId } SEM workerId. Molde
 * `AdminItineraryWriteController.test.ts`.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import { AdminItineraryAbsenceController } from '../AdminItineraryAbsenceController';
import {
  ItineraryAbsenceUseCase,
  AbsenceNotFoundError,
  AbsenceCancelledError,
  AbsenceDateInPastError,
  AbsenceAlreadyExistsError,
  AbsenceWeekdayMismatchError,
  AbsenceOutsideAllocationError,
  SubstituteIsTitularError,
} from '../../../application/ItineraryAbsenceUseCase';
import { AllocationNotFoundError, AllocationNotActiveError, NotSelectedForServiceError } from '../../../application/ItineraryAllocationUseCase';
import { ItineraryOverlapError } from '../../../domain/itineraryOverlap';
import { ServiceExitReasonRequiredError, ServiceExitReasonInvalidError } from '../../../domain/serviceExitReason';

const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const SERVICE_ID = '22222222-2222-2222-2222-222222222222';
const ALLOCATION_ID = '33333333-3333-3333-3333-333333333333';
const ABSENCE_ID = '44444444-4444-4444-4444-444444444444';
const WORKER_ID = '55555555-5555-5555-5555-555555555555';

function reqRes(params: Record<string, unknown> = {}, body: Record<string, unknown> = {}, actorId: string | null = 'staff-1'): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const req = { params, body, query: {} } as unknown as Request;
  (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(actorId ? { principal: { id: actorId } } : undefined);
  return [req, { json, status } as unknown as Response];
}

function jsonOf(res: Response): jest.Mock {
  return (res as unknown as { json: jest.Mock }).json;
}

describe('AdminItineraryAbsenceController', () => {
  const useCase = { register: jest.fn(), setSubstitute: jest.fn(), cancel: jest.fn() };
  const ctrl = new AdminItineraryAbsenceController(useCase as unknown as ItineraryAbsenceUseCase);
  beforeEach(() => jest.clearAllMocks());

  describe('register (POST .../itinerary/allocations/:allocationId/absences)', () => {
    it('params inválidos → 400, o caso de uso não roda', async () => {
      const [req, res] = reqRes({ id: 'not-a-uuid', sid: SERVICE_ID, allocationId: ALLOCATION_ID }, { date: '2026-09-28' });
      await ctrl.register(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.register).not.toHaveBeenCalled();
    });

    it.each([
      ['date fora de YYYY-MM-DD', { date: '28-09-2026' }],
      ['substituteWorkerId não-uuid', { date: '2026-09-28', substituteWorkerId: 'not-a-uuid' }],
    ])('corpo inválido (%s) → 400', async (_titulo, body) => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID }, body);
      await ctrl.register(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.register).not.toHaveBeenCalled();
    });

    it('sem ator → 401, o caso de uso NUNCA roda', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID }, { date: '2026-09-28' }, null);
      await ctrl.register(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: false, code: 'UNAUTHENTICATED' });
      expect(useCase.register).not.toHaveBeenCalled();
    });

    it('feliz → 201 { success:true, data }, chama o caso de uso com o ator', async () => {
      const result = { absenceId: ABSENCE_ID, allocationId: ALLOCATION_ID, date: '2026-09-28', substituteWorkerId: null, status: 'OPEN' as const };
      useCase.register.mockResolvedValueOnce(result);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID }, { date: '2026-09-28', reasonCategory: 'OTHER' });
      await ctrl.register(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: result });
      expect(useCase.register).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        serviceId: SERVICE_ID,
        allocationId: ALLOCATION_ID,
        date: '2026-09-28',
        substituteWorkerId: undefined,
        reasonCategory: 'OTHER',
        actorUid: 'staff-1',
      });
    });

    it('feliz com substituto → chama o caso de uso com substituteWorkerId', async () => {
      const result = { absenceId: ABSENCE_ID, allocationId: ALLOCATION_ID, date: '2026-09-28', substituteWorkerId: WORKER_ID, status: 'OPEN' as const };
      useCase.register.mockResolvedValueOnce(result);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID }, { date: '2026-09-28', substituteWorkerId: WORKER_ID, reasonCategory: 'OTHER' });
      await ctrl.register(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(useCase.register).toHaveBeenCalledWith(expect.objectContaining({ substituteWorkerId: WORKER_ID }));
    });

    it.each([
      [new AllocationNotFoundError(PATIENT_ID, SERVICE_ID, ALLOCATION_ID), 404, { success: false, code: 'NOT_FOUND' }],
      [new AllocationNotActiveError(ALLOCATION_ID), 422, { success: false, code: 'ALLOCATION_NOT_ACTIVE' }],
      [new NotSelectedForServiceError(PATIENT_ID, SERVICE_ID, WORKER_ID), 422, { success: false, code: 'NOT_SELECTED_FOR_SERVICE', error: 'não está em Selecionado do serviço' }],
      [new AbsenceDateInPastError(ALLOCATION_ID, '2026-09-01'), 422, { success: false, code: 'ABSENCE_DATE_IN_PAST' }],
      [new AbsenceAlreadyExistsError(ALLOCATION_ID, '2026-09-28'), 409, { success: false, code: 'ABSENCE_ALREADY_EXISTS' }],
      [new AbsenceWeekdayMismatchError(ALLOCATION_ID, '2026-09-28'), 422, { success: false, code: 'ABSENCE_WEEKDAY_MISMATCH' }],
      [new AbsenceOutsideAllocationError(ALLOCATION_ID, '2026-09-28'), 422, { success: false, code: 'ABSENCE_OUTSIDE_ALLOCATION' }],
      [new SubstituteIsTitularError(ALLOCATION_ID, '2026-09-28'), 422, { success: false, code: 'SUBSTITUTE_IS_TITULAR' }],
      [new ServiceExitReasonRequiredError(), 422, { success: false, code: 'REASON_REQUIRED' }],
      [new ServiceExitReasonInvalidError(), 422, { success: false, code: 'REASON_INVALID' }],
    ])('%p → status %i', async (err, status, body) => {
      useCase.register.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID }, { date: '2026-09-28' });
      await ctrl.register(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(body);
    });

    it('ItineraryOverlapError → 409 com existing/requested/sameAddress/minGapMinutes e error = overlapMessage (o MESMO corpo da Fase 11)', async () => {
      const existing = { serviceId: SERVICE_ID, weekday: 1, startTime: '08:00', endTime: '12:00' };
      const requested = { serviceId: 'other-service', weekday: 1, startTime: '11:00', endTime: '15:00' };
      const err = new ItineraryOverlapError(existing, requested, false, 60);
      useCase.register.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID }, { date: '2026-09-28' });
      await ctrl.register(req, res);
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

    it('erro inesperado → 500 + reportError { source, patientId, serviceId }, SEM workerId', async () => {
      useCase.register.mockRejectedValueOnce(new Error('boom'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, allocationId: ALLOCATION_ID }, { date: '2026-09-28' });
      await ctrl.register(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminItineraryAbsenceController:register', patientId: PATIENT_ID, serviceId: SERVICE_ID });
      const call = (reportError as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      expect(call).not.toHaveProperty('workerId');
    });
  });

  describe('setSubstitute (PATCH .../itinerary/absences/:absenceId/substitute)', () => {
    it('params inválidos (sem absenceId) → 400', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { substituteWorkerId: null });
      await ctrl.setSubstitute(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.setSubstitute).not.toHaveBeenCalled();
    });

    it('corpo SEM a chave substituteWorkerId → 400 (vazio ambíguo não é ausência)', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID }, {});
      await ctrl.setSubstitute(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.setSubstitute).not.toHaveBeenCalled();
    });

    it('substituteWorkerId não-uuid (e não null) → 400', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID }, { substituteWorkerId: 'not-a-uuid' });
      await ctrl.setSubstitute(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.setSubstitute).not.toHaveBeenCalled();
    });

    it('sem ator → 401', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID }, { substituteWorkerId: null }, null);
      await ctrl.setSubstitute(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(useCase.setSubstitute).not.toHaveBeenCalled();
    });

    it('corpo com null → chama setSubstitute(null) — tira o substituto', async () => {
      const result = { absenceId: ABSENCE_ID, allocationId: ALLOCATION_ID, date: '2026-09-28', substituteWorkerId: null, status: 'OPEN' as const };
      useCase.setSubstitute.mockResolvedValueOnce(result);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID }, { substituteWorkerId: null });
      await ctrl.setSubstitute(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: result });
      expect(useCase.setSubstitute).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, absenceId: ABSENCE_ID, substituteWorkerId: null, actorUid: 'staff-1' });
    });

    it('feliz com substituto → 200 { success:true, data }', async () => {
      const result = { absenceId: ABSENCE_ID, allocationId: ALLOCATION_ID, date: '2026-09-28', substituteWorkerId: WORKER_ID, status: 'OPEN' as const };
      useCase.setSubstitute.mockResolvedValueOnce(result);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID }, { substituteWorkerId: WORKER_ID });
      await ctrl.setSubstitute(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: result });
      expect(useCase.setSubstitute).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, absenceId: ABSENCE_ID, substituteWorkerId: WORKER_ID, actorUid: 'staff-1' });
    });

    it.each([
      [new AbsenceNotFoundError(PATIENT_ID, SERVICE_ID, ABSENCE_ID), 404, { success: false, code: 'NOT_FOUND' }],
      [new AbsenceCancelledError(ABSENCE_ID), 422, { success: false, code: 'ABSENCE_CANCELLED' }],
      [new AbsenceDateInPastError(ALLOCATION_ID, '2026-09-01'), 422, { success: false, code: 'ABSENCE_DATE_IN_PAST' }],
      [new SubstituteIsTitularError(ALLOCATION_ID, '2026-09-28'), 422, { success: false, code: 'SUBSTITUTE_IS_TITULAR' }],
    ])('%p → status %i', async (err, status, body) => {
      useCase.setSubstitute.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID }, { substituteWorkerId: null });
      await ctrl.setSubstitute(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(body);
    });

    it('erro inesperado → 500 + reportError, SEM workerId', async () => {
      useCase.setSubstitute.mockRejectedValueOnce(new Error('boom'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID }, { substituteWorkerId: null });
      await ctrl.setSubstitute(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      const call = (reportError as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      expect(call).not.toHaveProperty('workerId');
    });
  });

  describe('cancel (POST .../itinerary/absences/:absenceId/cancel)', () => {
    it('params inválidos → 400', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
      await ctrl.cancel(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.cancel).not.toHaveBeenCalled();
    });

    it('sem ator → 401', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID }, {}, null);
      await ctrl.cancel(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(useCase.cancel).not.toHaveBeenCalled();
    });

    it('feliz → 200 { success:true, data }', async () => {
      const result = { absenceId: ABSENCE_ID, allocationId: ALLOCATION_ID, date: '2026-09-28', substituteWorkerId: null, status: 'CANCELLED' as const };
      useCase.cancel.mockResolvedValueOnce(result);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID });
      await ctrl.cancel(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: result });
      expect(useCase.cancel).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, absenceId: ABSENCE_ID, actorUid: 'staff-1' });
    });

    it.each([
      [new AbsenceNotFoundError(PATIENT_ID, SERVICE_ID, ABSENCE_ID), 404, { success: false, code: 'NOT_FOUND' }],
      [new AbsenceCancelledError(ABSENCE_ID), 422, { success: false, code: 'ABSENCE_CANCELLED' }],
    ])('%p → status %i', async (err, status, body) => {
      useCase.cancel.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID });
      await ctrl.cancel(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(body);
    });

    it('erro inesperado → 500 + reportError { source, patientId, serviceId }, SEM workerId', async () => {
      useCase.cancel.mockRejectedValueOnce(new Error('boom'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID, absenceId: ABSENCE_ID });
      await ctrl.cancel(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminItineraryAbsenceController:cancel', patientId: PATIENT_ID, serviceId: SERVICE_ID });
    });
  });

  it('construtor sem caso de uso injetado constrói o real (não abre banco)', () => {
    expect(new AdminItineraryAbsenceController()).toBeInstanceOf(AdminItineraryAbsenceController);
  });
});
