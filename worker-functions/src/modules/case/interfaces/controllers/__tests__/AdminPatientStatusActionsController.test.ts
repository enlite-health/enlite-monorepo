/**
 * F3 — o controller das ações dos estados humanos (GET/POST /patients/:id/status-actions) e a função única erro → HTTP
 * (`respondPatientStatusError`, a mesma do PUT). 400 de corpo (inclusive `destino` imposto), 403 da nota clínica, 404, 422 por código
 * (todos), 403 de célula, 500; as células do ator chegam como vieram (`null` ≠ `[]`).
 */
jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn().mockReturnThis() },
}));
jest.mock('../../composition/patientStatusActionComposition', () => ({
  buildPatientStatusActionUseCase: jest.fn(),
  buildListPatientStatusActionsUseCase: jest.fn(),
}));

import { Request, Response } from 'express';
import { AdminPatientStatusActionsController } from '../AdminPatientStatusActionsController';
import {
  PatientStatusTransitionError,
  PatientStatusPermissionError,
  OnHoldReasonRequiredError,
  PatientStatusNotReadyError,
  PatientStatusLockedByAllocationError,
  SuspensionExitReasonRequiredError,
} from '../../../application/PatientStatusWriter';
import { PatientStatusActionNotAvailableError } from '../../../application/PatientStatusActionUseCase';

const ID = '33333333-3333-4333-8333-333333333333';

function reqRes(body: unknown, extra: Record<string, unknown> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ params: { id: ID }, body, query: {}, ...extra } as unknown as Request, { json, status } as unknown as Response];
}
const statusOf = (res: Response): number => (res as unknown as { status: jest.Mock }).status.mock.calls[0][0];
const bodyOf = (res: Response) => ((res as unknown as { status: jest.Mock }).status.mock.results[0].value.json as jest.Mock).mock.calls[0][0];

function montar(over: { apply?: jest.Mock; list?: jest.Mock } = {}) {
  const apply = over.apply ?? jest.fn().mockResolvedValue({ id: ID, acao: 'retomar', from: 'ON_HOLD', status: 'SEARCHING' });
  const list = over.list ?? jest.fn().mockResolvedValue({ current: 'ON_HOLD', actions: [] });
  const ctrl = new AdminPatientStatusActionsController({ execute: apply } as never, { execute: list } as never);
  return { ctrl, apply, list };
}

describe('AdminPatientStatusActionsController.perform', () => {
  beforeEach(() => jest.clearAllMocks());

  it('200: devolve só id/ação/de/para; o caso de uso recebe a ação, a célula como veio e NUNCA um destino', async () => {
    const { ctrl, apply } = montar();
    const [req, res] = reqRes({ action: 'retomar' }, { permissionCells: ['patient:update'] });
    await ctrl.perform(req, res);
    expect(statusOf(res)).toBe(200);
    expect(bodyOf(res)).toEqual({ success: true, data: { id: ID, action: 'retomar', from: 'ON_HOLD', status: 'SEARCHING' } });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ patientId: ID, acao: 'retomar', cells: ['patient:update'], onHoldNote: undefined }));
    expect(Object.keys(apply.mock.calls[0][0])).not.toContain('destino');
    await ctrl.perform(...reqRes({ action: 'retomar' }, { permissionCells: [] }));
    await ctrl.perform(...reqRes({ action: 'retomar' }));
    expect(apply.mock.calls.map((c) => c[0].cells)).toEqual([['patient:update'], [], null]);
  });

  it.each([
    ['ação desconhecida', { action: 'apagar' }],
    ['sem ação', {}],
    ['`destino` imposto no corpo (D9: o cliente não escolhe)', { action: 'reativar', destino: 'ACTIVE' }],
    ['`status` no corpo', { action: 'retomar', status: 'ACTIVE' }],
    ['`changeSource` no corpo', { action: 'retomar', changeSource: 'kanban' }],
    ['motivo fora do catálogo', { action: 'pausar', onHoldReason: 'QUALQUER' }],
  ])('400 e nada é gravado: %s', async (_nome, corpo) => {
    const { ctrl, apply } = montar();
    const [req, res] = reqRes(corpo);
    await ctrl.perform(req, res);
    expect(statusOf(res)).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it('onHoldNote no corpo sem ler texto clínico → 403 antes de qualquer escrita; com a célula passa e a nota vai ao caso de uso', async () => {
    const { ctrl, apply } = montar();
    const [req, res] = reqRes({ action: 'pausar', onHoldReason: 'SCHOOL', onHoldNote: 'x' }, { permissionCells: ['patient:update'] });
    await ctrl.perform(req, res);
    expect(statusOf(res)).toBe(403);
    expect(apply).not.toHaveBeenCalled();
    await ctrl.perform(...reqRes({ action: 'pausar', onHoldReason: 'SCHOOL', onHoldNote: 'x' }, { permissionCells: ['patient:update', 'patient_clinical:read'] }));
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ onHoldNote: 'x' }));
  });

  it.each([
    [new PatientStatusPermissionError('REPLACEMENT', 'ON_HOLD', 'patient_status:move_to_on_hold'), 403, 'PATIENT_STATUS_MOVE_NOT_PERMITTED'],
    [new PatientStatusTransitionError('ACTIVE', 'ALTA'), 422, 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED'],
    [new OnHoldReasonRequiredError(), 422, 'ON_HOLD_REASON_REQUIRED'],
    [new SuspensionExitReasonRequiredError(), 422, 'SUSPENSION_EXIT_REASON_REQUIRED'],
    [new PatientStatusLockedByAllocationError(2), 422, 'PATIENT_STATUS_LOCKED_BY_ALLOCATION'],
    [new PatientStatusActionNotAvailableError('retomar', 'ACTIVE'), 422, 'PATIENT_STATUS_ACTION_NOT_AVAILABLE'],
    [new PatientStatusNotReadyError('ACTIVE', ['ADDRESS']), 422, 'PATIENT_STATUS_NOT_READY'],
  ])('erro de domínio %# → %s %s (a MESMA tradução do PUT)', async (err, http, code) => {
    const { ctrl } = montar({ apply: jest.fn().mockRejectedValue(err) });
    const [req, res] = reqRes({ action: 'retomar' });
    await ctrl.perform(req, res);
    expect(statusOf(res)).toBe(http);
    expect(bodyOf(res)).toMatchObject({ success: false, code });
  });

  it('a trava de alocação devolve só a CONTAGEM; "not found" → 404; erro desconhecido → 500', async () => {
    const lock = montar({ apply: jest.fn().mockRejectedValue(new PatientStatusLockedByAllocationError(3)) });
    const [r1, s1] = reqRes({ action: 'dar_alta' });
    await lock.ctrl.perform(r1, s1);
    expect(bodyOf(s1).details).toEqual({ allocations: 3 });
    const nf = montar({ apply: jest.fn().mockRejectedValue(new Error('Patient not found: x')) });
    const [r2, s2] = reqRes({ action: 'dar_alta' });
    await nf.ctrl.perform(r2, s2);
    expect(statusOf(s2)).toBe(404);
    const boom = montar({ apply: jest.fn().mockRejectedValue(new Error('boom')) });
    const [r3, s3] = reqRes({ action: 'dar_alta' });
    await boom.ctrl.perform(r3, s3);
    expect(statusOf(s3)).toBe(500);
  });

  it('params inválidos → 400', async () => {
    const { ctrl, apply } = montar();
    const [req, res] = reqRes({ action: 'retomar' });
    (req as unknown as { params: unknown }).params = { id: 'nao-uuid' };
    await ctrl.perform(req, res);
    expect(statusOf(res)).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('AdminPatientStatusActionsController.list', () => {
  beforeEach(() => jest.clearAllMocks());

  it('200 com a lista; as células viajam como vieram; blockedBy com DIAGNOSIS vira CLINICAL_DATA para quem não lê texto clínico', async () => {
    const data = { current: 'ADMISSION', actions: [{ acao: 'retomar', destino: 'ACTIVE', via: 'fluxo', exige: [], blockedBy: ['DIAGNOSIS'] }] };
    const { ctrl, list } = montar({ list: jest.fn().mockResolvedValue(data) });
    const [req, res] = reqRes(undefined, { permissionCells: ['patient:update'] });
    await ctrl.list(req, res);
    expect(statusOf(res)).toBe(200);
    expect(bodyOf(res).data.actions[0].blockedBy).toEqual(['CLINICAL_DATA']);
    expect(list).toHaveBeenCalledWith({ patientId: ID, cells: ['patient:update'] });
  });

  it('404 e 500', async () => {
    const nf = montar({ list: jest.fn().mockRejectedValue(new Error('Patient not found: x')) });
    const [r1, s1] = reqRes(undefined);
    await nf.ctrl.list(r1, s1);
    expect(statusOf(s1)).toBe(404);
    const boom = montar({ list: jest.fn().mockRejectedValue(new Error('boom')) });
    const [r2, s2] = reqRes(undefined);
    await boom.ctrl.list(r2, s2);
    expect(statusOf(s2)).toBe(500);
  });
});
