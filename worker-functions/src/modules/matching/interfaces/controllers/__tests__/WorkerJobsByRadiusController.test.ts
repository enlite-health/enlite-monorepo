jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { ListJobsByRadiusForWorkerUseCase } from '../../../application/ListJobsByRadiusForWorkerUseCase';
import { WorkerJobsByRadiusController } from '../WorkerJobsByRadiusController';

function mk(user: unknown, query: Record<string, unknown>, headers: Record<string, string> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ user, query, headers } as unknown as Request, { json, status } as unknown as Response];
}
const statusOf = (res: Response) => (res.status as unknown as jest.Mock).mock.calls[0][0];
const bodyOf = (res: Response) => ((res.status as unknown as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];

describe('WorkerJobsByRadiusController.listMine', () => {
  const execute = jest.fn();
  const ctrl = new WorkerJobsByRadiusController({ execute } as unknown as ListJobsByRadiusForWorkerUseCase);
  beforeEach(() => jest.clearAllMocks());

  it('T-F2a-36 200 com { items } e o raio numérico repassado ao use case', async () => {
    execute.mockResolvedValueOnce({ ok: true, items: [{ id: 'j1' }] });
    const [req, res] = mk({ uid: 'uid-token' }, { radius_km: '15' });
    await ctrl.listMine(req, res);
    expect(statusOf(res)).toBe(200);
    expect(bodyOf(res)).toEqual({ items: [{ id: 'j1' }] });
    expect(execute).toHaveBeenCalledWith('uid-token', 15);
  });

  it('T-F2a-36 header x-auth-uid: OUTRO é ignorado — o use case recebe req.user.uid', async () => {
    execute.mockResolvedValueOnce({ ok: true, items: [] });
    const [req, res] = mk({ uid: 'uid-token' }, { radius_km: '10' }, { 'x-auth-uid': 'OUTRO' });
    await ctrl.listMine(req, res);
    expect(execute.mock.calls[0][0]).toBe('uid-token');
  });

  it.each([['abc'], ['7.5'], [undefined], [['5', '10']]])('T-F2a-36 radius_km=%p não numérico inteiro → NaN ao use case', async (r) => {
    execute.mockResolvedValueOnce({ ok: false, code: 'INVALID_RADIUS' });
    const [req, res] = mk({ uid: 'uid-token' }, { radius_km: r });
    await ctrl.listMine(req, res);
    expect(Number.isNaN(execute.mock.calls[0][1])).toBe(true);
    expect(statusOf(res)).toBe(400);
    expect(bodyOf(res)).toEqual({ code: 'INVALID_RADIUS' });
  });

  it.each([['NO_SERVICE_AREA', 409], ['ACCOUNT_INACTIVE', 403]])('T-F2a-36 %s → %d só com { code }', async (code, st) => {
    execute.mockResolvedValueOnce({ ok: false, code });
    const [req, res] = mk({ uid: 'uid-token' }, { radius_km: '10' });
    await ctrl.listMine(req, res);
    expect(statusOf(res)).toBe(st);
    expect(bodyOf(res)).toEqual({ code });
  });

  it('T-F2a-36 500 sem detalhe em erro inesperado', async () => {
    execute.mockRejectedValueOnce(new Error('segredo interno'));
    const [req, res] = mk({ uid: 'uid-token' }, { radius_km: '10' });
    await ctrl.listMine(req, res);
    expect(statusOf(res)).toBe(500);
    expect(JSON.stringify(bodyOf(res))).not.toContain('segredo');
    expect(reportError).toHaveBeenCalled();
  });

  it('T-F2a-36 sem req.user (defesa; o 401 real é do requireAuth) → 401 e não chama o use case', async () => {
    const [req, res] = mk(undefined, { radius_km: '10' }, { 'x-auth-uid': 'OUTRO' });
    await ctrl.listMine(req, res);
    expect(statusOf(res)).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});
