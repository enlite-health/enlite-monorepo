/**
 * AdminController.deleteAdminUser — o contrato HTTP do anti-lockout indireto (410):
 * `last_manager` do use case vira 409 com o MESMO código que o painel devolve.
 * Só este handler: o resto do controller tem as próprias suítes de rota.
 */

const mockExecute = jest.fn();
jest.mock('../../../application/DeleteAdminUserUseCase', () => ({
  DeleteAdminUserUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })),
  LAST_MANAGER: 'last_manager',
}));
jest.mock('../../../application/DeleteUserByEmailUseCase', () => ({ DeleteUserByEmailUseCase: jest.fn() }));
jest.mock('../../../application/CreateAdminUserUseCase', () => ({ CreateAdminUserUseCase: jest.fn() }));
jest.mock('../../../application/ListAdminUsersUseCase', () => ({ ListAdminUsersUseCase: jest.fn() }));
jest.mock('../../../application/ResetAdminPasswordUseCase', () => ({ ResetAdminPasswordUseCase: jest.fn() }));
jest.mock('../../../application/GetAdminProfileUseCase', () => ({ GetAdminProfileUseCase: jest.fn() }));
jest.mock('../../../application/UpdateAdminRoleUseCase', () => ({ UpdateAdminRoleUseCase: jest.fn() }));
jest.mock('../../../infrastructure/AdminRepository', () => ({ AdminRepository: jest.fn() }));
jest.mock('../../../infrastructure/UserRepository', () => ({ UserRepository: jest.fn() }));
jest.mock('../../../infrastructure/GoogleIdentityService', () => ({ GoogleIdentityService: jest.fn() }));

import type { Request, Response } from 'express';
import { AdminController } from '../AdminController';
import { Result } from '@shared/utils/Result';
import { LAST_MANAGER } from '../../../application/DeleteAdminUserUseCase';

function res(): Response & { status: jest.Mock; json: jest.Mock } {
  const r = { status: jest.fn(), json: jest.fn() } as unknown as Response & { status: jest.Mock; json: jest.Mock };
  r.status.mockReturnValue(r);
  return r;
}
const req = { params: { id: 'uid-1' } } as unknown as Request;

describe('AdminController.deleteAdminUser', () => {
  beforeEach(() => mockExecute.mockReset());

  it('último gestor → 409 `last_manager`', async () => {
    mockExecute.mockResolvedValue(Result.fail(LAST_MANAGER));
    const r = res();
    await new AdminController().deleteAdminUser(req, r);
    expect(r.status).toHaveBeenCalledWith(409);
    expect(r.json).toHaveBeenCalledWith({ success: false, code: 'last_manager', error: 'A operação deixaria a empresa sem nenhum gestor de acessos.' });
  });

  it('outra falha do use case → 400 com a mensagem', async () => {
    mockExecute.mockResolvedValue(Result.fail('User not found'));
    const r = res();
    await new AdminController().deleteAdminUser(req, r);
    expect(r.status).toHaveBeenCalledWith(400);
    expect(r.json).toHaveBeenCalledWith({ success: false, error: 'User not found' });
  });

  it('sucesso → 200', async () => {
    mockExecute.mockResolvedValue(Result.ok());
    const r = res();
    await new AdminController().deleteAdminUser(req, r);
    expect(r.status).toHaveBeenCalledWith(200);
  });

  it('exceção → 500 sem vazar detalhe', async () => {
    mockExecute.mockRejectedValue(new Error('boom'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const r = res();
    await new AdminController().deleteAdminUser(req, r);
    expect(r.status).toHaveBeenCalledWith(500);
    consoleError.mockRestore();
  });
});
