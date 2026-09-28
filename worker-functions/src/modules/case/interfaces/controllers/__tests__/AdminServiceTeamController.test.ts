/**
 * AdminServiceTeamController — quadro C (Servicio Contratado), Fase 10, DX-10.7.
 *   GET  → 200 { success: true, data }; 404 NOT_FOUND; 500 + reportError.
 *   POST reject/revert → 200 no feliz; 422 (motivo/estado) e 409 (corrida) por erro de domínio;
 *   400 só de forma (params/`workerId`); nunca 400 por `reasonCategory` ausente/`null`.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/audit/contactAccessFromRequest', () => ({ emitirTrilhaDeContato: jest.fn() }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { emitirTrilhaDeContato } from '@shared/audit/contactAccessFromRequest';
import { AdminServiceTeamController } from '../AdminServiceTeamController';
import { GetServiceTeamUseCase, ServiceTeamNotFoundError, type GetServiceTeamResult } from '../../../application/GetServiceTeamUseCase';
import {
  ServiceTeamMarkUseCase,
  ServiceTeamWorkerAllocatedError,
  ServiceTeamNotSelectedError,
  ServiceTeamNotRejectedError,
  ServiceTeamAlreadyRejectedError,
} from '../../../application/ServiceTeamMarkUseCase';
import { ServiceTeamReasonRequiredError, ServiceTeamReasonInvalidError } from '../../../domain/serviceTeamReason';

const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const SERVICE_ID = '22222222-2222-2222-2222-222222222222';
const WORKER_ID = '33333333-3333-3333-3333-333333333333';

/**
 * `user` default `{ uid: 'staff-1' }` — a maioria dos testes de reject/revert quer exercitar OUTRA
 * coisa (motivo, mapeamento de erro, forma) e não a autenticação; passar `null` pede o cenário SEM
 * ator (achado #9: sem `req.user?.uid`, a ação responde 401, nunca grava `'unknown'`).
 */
function reqRes(
  params: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
  user: { uid: string } | null = { uid: 'staff-1' },
): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  const req = { params, body, query: {} } as unknown as Request;
  if (user) (req as unknown as { user: { uid: string } }).user = user;
  return [req, { json, status } as unknown as Response];
}

function team(overrides: Partial<GetServiceTeamResult> = {}): GetServiceTeamResult {
  return {
    serviceId: SERVICE_ID,
    vacancyId: 'vac-1',
    selected: [{ workerId: WORKER_ID, displayName: 'Maria Perez', vacancyId: 'vac-1' }],
    inService: [],
    rejected: [{ workerId: 'w-redigido', displayName: null, vacancyId: 'vac-1', reasonCategory: 'OTHER' }],
    ...overrides,
  };
}

describe('AdminServiceTeamController', () => {
  const getUseCase = { execute: jest.fn() };
  const markUseCase = { reject: jest.fn(), revert: jest.fn() };
  const ctrl = new AdminServiceTeamController(
    getUseCase as unknown as GetServiceTeamUseCase,
    markUseCase as unknown as ServiceTeamMarkUseCase,
  );
  beforeEach(() => jest.clearAllMocks());

  describe('GET (params inválidos, feliz, 404, 500)', () => {
    it('params inválidos → 400, o caso de uso não roda', async () => {
      const [req, res] = reqRes({ id: 'not-a-uuid', sid: SERVICE_ID });
      await ctrl.get(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(getUseCase.execute).not.toHaveBeenCalled();
    });

    it('feliz → 200 { success: true, data }, e a trilha sai só com o workerId de displayName não nulo', async () => {
      getUseCase.execute.mockResolvedValueOnce(team());
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
      await ctrl.get(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: true, data: team() });
      expect(getUseCase.execute).toHaveBeenCalledWith({ patientId: PATIENT_ID, serviceId: SERVICE_ID, cells: null });
      expect(emitirTrilhaDeContato).toHaveBeenCalledWith(req, [WORKER_ID]);
    });

    it('ServiceTeamNotFoundError → 404 NOT_FOUND', async () => {
      getUseCase.execute.mockRejectedValueOnce(new ServiceTeamNotFoundError(PATIENT_ID, SERVICE_ID));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
      await ctrl.get(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: false, code: 'NOT_FOUND' });
    });

    it('erro inesperado → 500 + reportError com { source, patientId, serviceId }, SEM workerId', async () => {
      getUseCase.execute.mockRejectedValueOnce(new Error('boom'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
      await ctrl.get(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminServiceTeamController:get', patientId: PATIENT_ID, serviceId: SERVICE_ID });
      const call = (reportError as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      expect(call).not.toHaveProperty('workerId');
    });

    it('erro não-Error (string) → 500, sem explodir', async () => {
      getUseCase.execute.mockRejectedValueOnce('boom');
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID });
      await ctrl.get(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('POST reject/revert — forma (400) nunca por reasonCategory', () => {
    it('params inválidos → 400, o caso de uso não roda', async () => {
      const [req, res] = reqRes({ id: 'x', sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: 'OTHER' });
      await ctrl.reject(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(markUseCase.reject).not.toHaveBeenCalled();
    });

    it('workerId não-uuid → 400, o caso de uso não roda', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: 'not-a-uuid', reasonCategory: 'OTHER' });
      await ctrl.reject(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(markUseCase.reject).not.toHaveBeenCalled();
    });

    it('reasonCategory AUSENTE (sem a chave) → passa da borda (400 não dispara); o 422 vem do caso de uso', async () => {
      markUseCase.reject.mockRejectedValueOnce(new ServiceTeamReasonRequiredError('REJECT'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID });
      await ctrl.reject(req, res);
      expect(markUseCase.reject).toHaveBeenCalledWith(
        expect.objectContaining({ patientId: PATIENT_ID, serviceId: SERVICE_ID, workerId: WORKER_ID, reasonCategory: undefined }),
      );
      expect(res.status).toHaveBeenCalledWith(422);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: false, code: 'SERVICE_TEAM_REASON_REQUIRED' });
    });

    it('reasonCategory: null → passa da borda (400 não dispara); o 422 vem do caso de uso', async () => {
      markUseCase.reject.mockRejectedValueOnce(new ServiceTeamReasonRequiredError('REJECT'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: null });
      await ctrl.reject(req, res);
      expect(markUseCase.reject).toHaveBeenCalledWith(expect.objectContaining({ reasonCategory: null }));
      expect(res.status).toHaveBeenCalledWith(422);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: false, code: 'SERVICE_TEAM_REASON_REQUIRED' });
    });

    it('feliz reject → 200 { success: true, data }, actorUid do req.user, e a trilha filtra o redigido', async () => {
      markUseCase.reject.mockResolvedValueOnce(team());
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: 'OTHER' });
      (req as unknown as { user?: { uid: string } }).user = { uid: 'staff-1' };
      await ctrl.reject(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: true, data: team() });
      expect(markUseCase.reject).toHaveBeenCalledWith({
        patientId: PATIENT_ID,
        serviceId: SERVICE_ID,
        workerId: WORKER_ID,
        reasonCategory: 'OTHER',
        actorUid: 'staff-1',
        cells: null,
      });
      expect(emitirTrilhaDeContato).toHaveBeenCalledWith(req, [WORKER_ID]);
    });

    it('feliz revert → 200 { success: true, data }, actorUid do req.user', async () => {
      markUseCase.revert.mockResolvedValueOnce(team());
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: 'REAVALIACAO' });
      await ctrl.revert(req, res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(markUseCase.revert).toHaveBeenCalledWith(expect.objectContaining({ actorUid: 'staff-1' }));
    });

    it('achado #9: sem req.user?.uid → 401 UNAUTHENTICATED, o caso de uso NUNCA roda (nunca grava actorUid "unknown" na auditoria)', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: 'OTHER' }, null);
      await ctrl.reject(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: false, code: 'UNAUTHENTICATED' });
      expect(markUseCase.reject).not.toHaveBeenCalled();
    });

    it('achado #9: o mesmo vale para revert — sem req.user?.uid → 401, 0 chamada ao caso de uso', async () => {
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: 'REAVALIACAO' }, null);
      await ctrl.revert(req, res);
      expect(res.status).toHaveBeenCalledWith(401);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: false, code: 'UNAUTHENTICATED' });
      expect(markUseCase.revert).not.toHaveBeenCalled();
    });
  });

  describe('mapeamento de erro de domínio → status/código (DX-10.7)', () => {
    it.each([
      [new ServiceTeamReasonRequiredError('REJECT'), 422, { success: false, code: 'SERVICE_TEAM_REASON_REQUIRED' }],
      [new ServiceTeamReasonInvalidError('REJECT'), 422, { success: false, code: 'SERVICE_TEAM_REASON_INVALID' }],
      [
        new ServiceTeamWorkerAllocatedError(PATIENT_ID, SERVICE_ID, WORKER_ID),
        422,
        { success: false, code: 'SERVICE_TEAM_WORKER_ALLOCATED', error: 'remova do itinerário primeiro' },
      ],
      [new ServiceTeamNotSelectedError(PATIENT_ID, SERVICE_ID, WORKER_ID), 422, { success: false, code: 'SERVICE_TEAM_NOT_SELECTED' }],
      [new ServiceTeamNotRejectedError(PATIENT_ID, SERVICE_ID, WORKER_ID), 422, { success: false, code: 'SERVICE_TEAM_NOT_REJECTED' }],
      [new ServiceTeamAlreadyRejectedError(PATIENT_ID, SERVICE_ID, WORKER_ID), 409, { success: false, code: 'SERVICE_TEAM_ALREADY_REJECTED' }],
      [new ServiceTeamNotFoundError(PATIENT_ID, SERVICE_ID), 404, { success: false, code: 'NOT_FOUND' }],
    ])('%p → status %i com %p', async (err, status, body) => {
      markUseCase.reject.mockRejectedValueOnce(err);
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: 'OTHER' });
      await ctrl.reject(req, res);
      expect(res.status).toHaveBeenCalledWith(status);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith(body);
    });

    it('o mesmo mapeamento vale para revert (WorkerAllocated não se aplica, mas NotFound/AlreadyRejected sim)', async () => {
      markUseCase.revert.mockRejectedValueOnce(new ServiceTeamAlreadyRejectedError(PATIENT_ID, SERVICE_ID, WORKER_ID));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: 'REAVALIACAO' });
      await ctrl.revert(req, res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: false, code: 'SERVICE_TEAM_ALREADY_REJECTED' });
    });

    it('erro inesperado no reject → 500 + reportError com { source, patientId, serviceId }, SEM workerId', async () => {
      markUseCase.reject.mockRejectedValueOnce(new Error('db down'));
      const [req, res] = reqRes({ id: PATIENT_ID, sid: SERVICE_ID }, { workerId: WORKER_ID, reasonCategory: 'OTHER' });
      await ctrl.reject(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminServiceTeamController:reject', patientId: PATIENT_ID, serviceId: SERVICE_ID });
      const call = (reportError as jest.Mock).mock.calls[0][1] as Record<string, unknown>;
      expect(call).not.toHaveProperty('workerId');
    });
  });

  it('construtor sem casos de uso injetados constrói o real (não abre banco)', () => {
    expect(new AdminServiceTeamController()).toBeInstanceOf(AdminServiceTeamController);
  });
});
