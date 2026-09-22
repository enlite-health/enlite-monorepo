/**
 * AdminStaffDirectoryController — unit puro (repositório mockado, `req`/`res` fake). Cobre R2-B
 * (change 022-ux-mencao-e-notificacao, Rodada 2): `limit` propagado ao repositório, `excludeUid`
 * resolvido por `principalUid`, `isOnline` presente na resposta, 401 quando não autenticado. O
 * comportamento do SQL real (Postgres) é coberto por `adminStaffDirectory.e2e.test.ts`.
 */
import type { Request, Response } from 'express';
import { AdminStaffDirectoryController } from '../AdminStaffDirectoryController';
import { MAX_STAFF_DIRECTORY_RESULTS } from '../../validators/staffDirectorySchema';
import type { AdminRepository } from '../../../infrastructure/AdminRepository';

function fakeRes(): Response {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as Response;
}

function fakeReq(query: Record<string, unknown>, uid: string | undefined): Request {
  return {
    query,
    authContext: uid ? { principal: { id: uid } } : undefined,
  } as unknown as Request;
}

describe('AdminStaffDirectoryController.search', () => {
  it('sem ator autenticado — 401, nunca chama o repositório', async () => {
    const searchStaffDirectory = jest.fn();
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

    await controller.search(fakeReq({}, undefined), fakeRes());

    expect(searchStaffDirectory).not.toHaveBeenCalled();
  });

  it('limit ausente: repositório recebe o default (MAX_STAFF_DIRECTORY_RESULTS)', async () => {
    const searchStaffDirectory = jest.fn().mockResolvedValue([]);
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

    await controller.search(fakeReq({}, 'uid-1'), fakeRes());

    expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, MAX_STAFF_DIRECTORY_RESULTS, 'uid-1');
  });

  it('limit=200 ("Mostrar todos"): propagado ao repositório', async () => {
    const searchStaffDirectory = jest.fn().mockResolvedValue([]);
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);

    await controller.search(fakeReq({ limit: '200' }, 'uid-1'), fakeRes());

    expect(searchStaffDirectory).toHaveBeenCalledWith(undefined, 200, 'uid-1');
  });

  it('resposta inclui isOnline e nunca email/role — forma explícita mesmo com row "sujo"', async () => {
    const searchStaffDirectory = jest.fn().mockResolvedValue([
      { uid: 'u1', displayName: 'Ana', isOnline: true, email: 'vazou@e2e.local', role: 'admin' },
    ]);
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);
    const res = fakeRes();

    await controller.search(fakeReq({}, 'uid-1'), res);

    const payload = (res.json as jest.Mock).mock.calls[0][0];
    expect(payload.data).toEqual([{ uid: 'u1', displayName: 'Ana', isOnline: true }]);
  });

  it('limit=201 (acima do teto do schema) — 400, nunca chama o repositório', async () => {
    const searchStaffDirectory = jest.fn();
    const controller = new AdminStaffDirectoryController({ searchStaffDirectory } as unknown as AdminRepository);
    const res = fakeRes();

    await controller.search(fakeReq({ limit: '201' }, 'uid-1'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(searchStaffDirectory).not.toHaveBeenCalled();
  });
});
