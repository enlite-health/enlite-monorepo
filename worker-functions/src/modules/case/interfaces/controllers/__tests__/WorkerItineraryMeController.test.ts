jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AccountInactiveError, GetWorkerItineraryUseCase } from '../../../application/GetWorkerItineraryUseCase';
import { WorkerItineraryMeController } from '../WorkerItineraryMeController';

const ENVELOPE = { worker_id: 'w', items: [], tombstones: [], cursor: 'c', full: true };

function mk(user: unknown, headers: Record<string, string> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ user, headers } as unknown as Request, { json, status } as unknown as Response];
}
const statusOf = (res: Response) => (res.status as unknown as jest.Mock).mock.calls[0][0];
const bodyOf = (res: Response) => ((res.status as unknown as jest.Mock).mock.results[0].value.json as jest.Mock).mock.calls[0][0];

describe('WorkerItineraryMeController.getMine', () => {
  const execute = jest.fn();
  const ctrl = new WorkerItineraryMeController({ execute } as unknown as GetWorkerItineraryUseCase);
  beforeEach(() => jest.clearAllMocks());

  it('200 com o envelope e today em AAAA-MM-DD', async () => {
    execute.mockResolvedValueOnce(ENVELOPE);
    const [req, res] = mk({ uid: 'uid-token' });
    await ctrl.getMine(req, res);
    expect(statusOf(res)).toBe(200);
    expect(bodyOf(res)).toEqual(ENVELOPE);
    expect(execute.mock.calls[0][0].today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('403 ACCOUNT_INACTIVE quando o use case lança AccountInactiveError', async () => {
    execute.mockRejectedValueOnce(new AccountInactiveError());
    const [req, res] = mk({ uid: 'uid-token' });
    await ctrl.getMine(req, res);
    expect(statusOf(res)).toBe(403);
    expect(bodyOf(res)).toEqual({ code: 'ACCOUNT_INACTIVE' });
  });

  it('header x-auth-uid: OUTRO é ignorado — o use case recebe req.user.uid', async () => {
    execute.mockResolvedValueOnce(ENVELOPE);
    const [req, res] = mk({ uid: 'uid-token' }, { 'x-auth-uid': 'OUTRO' });
    await ctrl.getMine(req, res);
    expect(execute.mock.calls[0][0].uid).toBe('uid-token');
  });

  it('500 sem detalhe em erro inesperado', async () => {
    execute.mockRejectedValueOnce(new Error('segredo interno'));
    const [req, res] = mk({ uid: 'uid-token' });
    await ctrl.getMine(req, res);
    expect(statusOf(res)).toBe(500);
    expect(JSON.stringify(bodyOf(res))).not.toContain('segredo');
    expect(reportError).toHaveBeenCalled();
  });

  it('sem req.user (defesa; o 401 real é do requireAuth) -> 401 e não chama o use case', async () => {
    const [req, res] = mk(undefined, { 'x-auth-uid': 'OUTRO' });
    await ctrl.getMine(req, res);
    expect(statusOf(res)).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });
});
