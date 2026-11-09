/**
 * UserController — H1 / D650: a identidade vem SÓ do token (`req.user.uid`).
 * O header `x-auth-uid` não é lido; o `:userId` do path é o alvo do DELETE admin.
 */
const mockExecute = jest.fn();
jest.mock('../../../application/DeleteUserUseCase', () => ({
  DeleteUserUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })),
}));
jest.mock('../../../infrastructure/UserRepository', () => ({ UserRepository: jest.fn() }));
jest.mock('../../../infrastructure/GoogleIdentityService', () => ({ GoogleIdentityService: jest.fn() }));

import type { Request, Response } from 'express';
import { UserController } from '../UserController';
import { Result } from '@shared/utils/Result';

function res(): Response & { status: jest.Mock; json: jest.Mock } {
  const r = { status: jest.fn(), json: jest.fn() } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  r.status.mockReturnValue(r);
  return r;
}
const mkReq = (o: { uid?: string; header?: string; userId?: string }): Request =>
  ({
    user: o.uid ? { uid: o.uid } : undefined,
    headers: o.header ? { 'x-auth-uid': o.header } : {},
    params: o.userId ? { userId: o.userId } : {},
  }) as unknown as Request;

describe('UserController — identidade só do token', () => {
  beforeEach(() => { mockExecute.mockReset(); mockExecute.mockResolvedValue(Result.ok()); });

  it('DELETE /me: Bearer de A + x-auth-uid de B → age só em A', async () => {
    const r = res();
    await new UserController().deleteUser(mkReq({ uid: 'uid-a', header: 'uid-b' }), r);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith({ authUid: 'uid-a' });
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('DELETE /me: só o header x-auth-uid (sem token) → 401 e nada é apagado', async () => {
    const r = res();
    await new UserController().deleteUser(mkReq({ header: 'uid-b' }), r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('DELETE /:userId: apaga o `:userId` do path, não o ator nem o header', async () => {
    const r = res();
    await new UserController().deleteUserById(mkReq({ uid: 'uid-staff', header: 'uid-b', userId: 'uid-alvo' }), r);
    expect(mockExecute).toHaveBeenCalledWith({ authUid: 'uid-alvo', userId: 'uid-alvo' });
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('DELETE /:userId: sem token (só header) → 401 e nada é apagado', async () => {
    const r = res();
    await new UserController().deleteUserById(mkReq({ header: 'uid-b', userId: 'uid-alvo' }), r);
    expect(r.status).toHaveBeenCalledWith(401);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
