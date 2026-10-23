/**
 * AdminSubstitutionRequestController — spec 069. 400 só de forma (inclui `substituteWorkerId` AUSENTE num turno = 400, P16); sem
 * ator → 401 e o caso de uso não roda; erro de domínio → status/código; inesperado → 500 + reportError SEM id de prestador.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn() } }));
jest.mock('@shared/audit/contactAccessFromRequest', () => ({ emitirTrilhaDeContato: jest.fn() }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { AuthMiddleware } from '@modules/identity';
import { AdminSubstitutionRequestController } from '../AdminSubstitutionRequestController';
import {
  SubstitutionNoShiftsInPeriodError,
  SubstitutionPeriodInPastError,
  SubstitutionServiceNotFoundError,
  SubstitutionShiftsMismatchError,
} from '../../../application/substitutionRequestErrors';
import {
  AbsenceAlreadyExistsError,
  AbsenceDateInPastError,
  AbsenceOutsideAllocationError,
  AbsenceWeekdayMismatchError,
  SubstituteIsTitularError,
} from '../../../application/ItineraryAbsenceUseCase';
import { NotSelectedForServiceError } from '../../../application/ItineraryAllocationUseCase';
import { ServiceExitReasonInvalidError, ServiceExitReasonRequiredError } from '../../../domain/serviceExitReason';
import { ItineraryOverlapError } from '../../../domain/itineraryOverlap';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '55555555-5555-4555-8555-555555555555';
const SLOT_ID = '66666666-6666-4666-8666-666666666666';
const PARAMS = { id: PATIENT_ID, sid: SERVICE_ID };

function reqRes(over: { params?: unknown; body?: unknown; query?: unknown; actor?: string | null; cells?: string[] } = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const actor = over.actor === undefined ? 'staff-1' : over.actor;
  (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(actor ? { principal: { id: actor } } : undefined);
  const req = { params: over.params ?? PARAMS, body: over.body ?? {}, query: over.query ?? {}, permissionCells: over.cells } as unknown as Request;
  return [req, { json, status } as unknown as Response];
}
const jsonOf = (res: Response): jest.Mock => (res as unknown as { json: jest.Mock }).json;

const SHIFT = { date: '2026-11-02', slotId: SLOT_ID, substituteWorkerId: WORKER_ID };
const CREATE_BODY = { type: 'DAYS', outgoingWorkerId: WORKER_ID, from: '2026-11-02', to: '2026-11-06', reasonCategory: 'OTHER', shifts: [SHIFT] };
const PREVIEW_BODY = { type: 'DAYS', outgoingWorkerId: WORKER_ID, from: '2026-11-02', to: '2026-11-06', candidateWorkerIds: [WORKER_ID] };

describe('AdminSubstitutionRequestController', () => {
  const useCases = {
    list: { execute: jest.fn() },
    outgoing: { execute: jest.fn() },
    preview: { execute: jest.fn() },
    create: { execute: jest.fn() },
  };
  const ctrl = new AdminSubstitutionRequestController(useCases.list as never, useCases.outgoing as never, useCases.preview as never, useCases.create as never);
  beforeEach(() => jest.clearAllMocks());

  describe('list', () => {
    it('params inválidos → 400; query inválida → 400; o caso de uso não roda', async () => {
      const [r1, s1] = reqRes({ params: { id: 'x', sid: SERVICE_ID } });
      await ctrl.list(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(400);
      const [r2, s2] = reqRes({ query: { when: 'ontem' } });
      await ctrl.list(r2, s2);
      expect(s2.status).toHaveBeenCalledWith(400);
      expect(useCases.list.execute).not.toHaveBeenCalled();
    });

    it('feliz: when padrão upcoming, células repassadas, 200 e a trilha recebe só quem saiu COM nome', async () => {
      useCases.list.execute.mockResolvedValue({
        requests: [
          { outgoingWorkerId: 'w-out', outgoingDisplayName: 'Nome', shifts: [{ workerId: 'w-in' }, { workerId: 'w-sem-nome' }, { workerId: null }], shiftDisplayNames: ['Entra', null, null] },
          { outgoingWorkerId: 'w-out2', outgoingDisplayName: null, shifts: [], shiftDisplayNames: [] },
        ],
      });
      const [req, res] = reqRes({ cells: ['worker_contact:read'] });
      await ctrl.list(req, res);
      expect(useCases.list.execute).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, when: 'upcoming', cells: ['worker_contact:read'] });
      expect(res.status).toHaveBeenCalledWith(200);
      expect(emitirTrilhaDeContato).toHaveBeenCalledWith(req, ['w-out', 'w-in']);
    });

    it('cells ausentes (engine OFF) → null; serviço inexistente → 404', async () => {
      useCases.list.execute.mockRejectedValueOnce(new SubstitutionServiceNotFoundError(PATIENT_ID, SERVICE_ID));
      const [req, res] = reqRes({ query: { when: 'past' } });
      await ctrl.list(req, res);
      expect(useCases.list.execute).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, when: 'past', cells: null });
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('outgoingOptions', () => {
    it('params inválidos → 400', async () => {
      const [req, res] = reqRes({ params: { id: PATIENT_ID } });
      await ctrl.outgoingOptions(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
    it('feliz: { workers }, trilha só com nome; sem célula → cells null', async () => {
      useCases.outgoing.execute.mockResolvedValue([{ workerId: 'w-1', displayName: 'A' }, { workerId: 'w-2', displayName: null }]);
      const [req, res] = reqRes();
      await ctrl.outgoingOptions(req, res);
      expect(useCases.outgoing.execute).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, cells: null });
      expect(emitirTrilhaDeContato).toHaveBeenCalledWith(req, ['w-1']);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: true, data: { workers: [{ workerId: 'w-1', displayName: 'A' }, { workerId: 'w-2', displayName: null }] } });
    });
    it('erro inesperado → 500 + reportError sem workerId', async () => {
      useCases.outgoing.execute.mockRejectedValueOnce(new Error('boom'));
      const [req, res] = reqRes();
      await ctrl.outgoingOptions(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminSubstitutionRequestController:outgoingOptions', patientId: PATIENT_ID, serviceId: SERVICE_ID });
    });
  });

  describe('preview', () => {
    it('corpo inválido → 400; params inválidos → 400', async () => {
      const [r1, s1] = reqRes({ body: { ...PREVIEW_BODY, candidateWorkerIds: ['x'] } });
      await ctrl.preview(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(400);
      const [r2, s2] = reqRes({ params: { id: 'x', sid: 'y' }, body: PREVIEW_BODY });
      await ctrl.preview(r2, s2);
      expect(s2.status).toHaveBeenCalledWith(400);
      expect(useCases.preview.execute).not.toHaveBeenCalled();
    });
    it('feliz: 200 com o resultado; ONE_DAY normaliza `to`', async () => {
      useCases.preview.execute.mockResolvedValue({ shifts: [], conflicts: [], statusAfter: null });
      const [req, res] = reqRes({ body: { type: 'ONE_DAY', outgoingWorkerId: WORKER_ID, from: '2026-11-02', candidateWorkerIds: [] } });
      await ctrl.preview(req, res);
      expect(useCases.preview.execute).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, type: 'ONE_DAY', outgoingWorkerId: WORKER_ID, from: '2026-11-02', to: '2026-11-02', candidateWorkerIds: [] });
      expect(res.status).toHaveBeenCalledWith(200);
    });
    it('período sem turno → 422 SUBSTITUTION_NO_SHIFTS_IN_PERIOD', async () => {
      useCases.preview.execute.mockRejectedValueOnce(new SubstitutionNoShiftsInPeriodError(WORKER_ID, '2026-11-03', '2026-11-03'));
      const [req, res] = reqRes({ body: PREVIEW_BODY });
      await ctrl.preview(req, res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(jsonOf(res)).toHaveBeenCalledWith({ success: false, code: 'SUBSTITUTION_NO_SHIFTS_IN_PERIOD' });
    });
  });

  describe('create', () => {
    it('corpo sem a CHAVE substituteWorkerId num turno → 400 (P16: nunca um padrão silencioso); o caso de uso não roda', async () => {
      const { substituteWorkerId: _omit, ...semSubstituto } = SHIFT;
      const [req, res] = reqRes({ body: { ...CREATE_BODY, shifts: [semSubstituto] } });
      await ctrl.create(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCases.create.execute).not.toHaveBeenCalled();
    });
    it('substituteWorkerId: null explícito é aceito ("Nadie todavía")', async () => {
      useCases.create.execute.mockResolvedValue({ requestId: 'r-1' });
      const [req, res] = reqRes({ body: { ...CREATE_BODY, shifts: [{ ...SHIFT, substituteWorkerId: null }] } });
      await ctrl.create(req, res);
      expect(res.status).toHaveBeenCalledWith(201);
    });
    it('params/corpo inválido → 400; sem ator → 401 e 0 chamada', async () => {
      const [r1, s1] = reqRes({ params: { id: 'x', sid: SERVICE_ID }, body: CREATE_BODY });
      await ctrl.create(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(400);
      const [r2, s2] = reqRes({ body: CREATE_BODY, actor: null });
      await ctrl.create(r2, s2);
      expect(s2.status).toHaveBeenCalledWith(401);
      expect(useCases.create.execute).not.toHaveBeenCalled();
    });
    it('feliz: 201, ator vindo do token (nunca do corpo)', async () => {
      useCases.create.execute.mockResolvedValue({ requestId: 'r-1' });
      const [req, res] = reqRes({ body: { ...CREATE_BODY, actorUid: 'forjado' } });
      // `.strict()` recusa a chave estranha
      await ctrl.create(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      const [req2, res2] = reqRes({ body: CREATE_BODY });
      await ctrl.create(req2, res2);
      expect(useCases.create.execute).toHaveBeenCalledWith(expect.objectContaining({ patientId: PATIENT_ID, serviceId: SERVICE_ID, actorUid: 'staff-1', to: '2026-11-06' }));
      expect(res2.status).toHaveBeenCalledWith(201);
    });

    it.each<[string, Error, number, string]>([
      ['serviço inexistente', new SubstitutionServiceNotFoundError(PATIENT_ID, SERVICE_ID), 404, 'NOT_FOUND'],
      ['motivo ausente', new ServiceExitReasonRequiredError(), 422, 'REASON_REQUIRED'],
      ['motivo inválido', new ServiceExitReasonInvalidError(), 422, 'REASON_INVALID'],
      ['sem turno no período', new SubstitutionNoShiftsInPeriodError(WORKER_ID, 'a', 'b'), 422, 'SUBSTITUTION_NO_SHIFTS_IN_PERIOD'],
      ['turnos divergentes', new SubstitutionShiftsMismatchError(6, 5), 422, 'SUBSTITUTION_SHIFTS_MISMATCH'],
      ['período passado', new SubstitutionPeriodInPastError('2026-10-01'), 422, 'ABSENCE_DATE_IN_PAST'],
      ['data passada da ausência', new AbsenceDateInPastError('a-1', '2026-10-01'), 422, 'ABSENCE_DATE_IN_PAST'],
      ['substituto fora do pool', new NotSelectedForServiceError(PATIENT_ID, SERVICE_ID, WORKER_ID), 422, 'NOT_SELECTED_FOR_SERVICE'],
      ['dia da semana', new AbsenceWeekdayMismatchError('a-1', 'd'), 422, 'ABSENCE_WEEKDAY_MISMATCH'],
      ['fora da vigência', new AbsenceOutsideAllocationError('a-1', 'd'), 422, 'ABSENCE_OUTSIDE_ALLOCATION'],
      ['substituto é o titular', new SubstituteIsTitularError('a-1', 'd'), 422, 'SUBSTITUTE_IS_TITULAR'],
      ['falta já aberta', new AbsenceAlreadyExistsError('a-1', 'd'), 409, 'ABSENCE_ALREADY_EXISTS'],
    ])('%s → %i %s', async (_nome, err, status, code) => {
      useCases.create.execute.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ body: CREATE_BODY });
      await ctrl.create(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect(jsonOf(res)).toHaveBeenCalledWith(expect.objectContaining({ success: false, code }));
    });

    it('sobreposição do substituto (23P01 decodificado) → 409 ITINERARY_OVERLAP com os dois horários', async () => {
      const err = new ItineraryOverlapError(
        { serviceId: 's-9', weekday: 3, startTime: '08:00', endTime: '12:00' },
        { serviceId: SERVICE_ID, weekday: 3, startTime: '09:00', endTime: '13:00' },
        false,
        60,
      );
      useCases.create.execute.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ body: CREATE_BODY });
      await ctrl.create(req, res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(jsonOf(res)).toHaveBeenCalledWith(expect.objectContaining({ code: 'ITINERARY_OVERLAP', minGapMinutes: 60, sameAddress: false }));
    });

    it('erro inesperado → 500 + reportError { source, patientId, serviceId } SEM workerId; Error que não é Error vira Error', async () => {
      useCases.create.execute.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce('texto');
      const [r1, s1] = reqRes({ body: CREATE_BODY });
      await ctrl.create(r1, s1);
      expect(s1.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminSubstitutionRequestController:create', patientId: PATIENT_ID, serviceId: SERVICE_ID });
      const [r2, s2] = reqRes({ body: CREATE_BODY });
      await ctrl.create(r2, s2);
      expect((reportError as jest.Mock).mock.calls[1][0]).toBeInstanceOf(Error);
    });
  });

  it('construtor sem argumentos monta os casos de uso reais', () => {
    expect(() => new AdminSubstitutionRequestController()).not.toThrow();
  });
});
