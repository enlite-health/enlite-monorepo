/**
 * DeleteAdminUserUseCase — o caminho (b) do anti-lockout indireto (296).
 *
 * A ordem do use case é Firebase → banco. Por isso a pré-checagem vem ANTES de
 * tudo: se só o trigger do banco recusasse, a conta já estaria apagada no
 * Identity Platform e a pessoa ficaria sem login E ainda contada como gestora.
 */

const mockIsLastManager = jest.fn();
const mockDeleteByFirebaseUid = jest.fn();
jest.mock('../../infrastructure/AdminRepository', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({
    isLastManager: mockIsLastManager,
    deleteByFirebaseUid: mockDeleteByFirebaseUid,
  })),
}));

const mockDeleteUser = jest.fn();
jest.mock('firebase-admin', () => ({
  auth: () => ({ deleteUser: (...args: unknown[]) => mockDeleteUser(...args) }),
}));

import { DeleteAdminUserUseCase } from '../DeleteAdminUserUseCase';
import { LAST_MANAGER_ERROR } from '../../domain/lastManager';

const UID = 'uid-gestor';

describe('DeleteAdminUserUseCase', () => {
  beforeEach(() => {
    mockIsLastManager.mockReset().mockResolvedValue(false);
    mockDeleteByFirebaseUid.mockReset().mockResolvedValue(undefined);
    mockDeleteUser.mockReset().mockResolvedValue(undefined);
  });

  it('último gestor → falha `last_manager` SEM tocar no Firebase nem no banco', async () => {
    mockIsLastManager.mockResolvedValue(true);

    const result = await new DeleteAdminUserUseCase().execute(UID);

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe(LAST_MANAGER_ERROR);
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockDeleteByFirebaseUid).not.toHaveBeenCalled();
  });

  it('não-último: apaga no Firebase e depois no banco, nesta ordem', async () => {
    const ordem: string[] = [];
    mockDeleteUser.mockImplementation(async () => { ordem.push('firebase'); });
    mockDeleteByFirebaseUid.mockImplementation(async () => { ordem.push('banco'); });

    const result = await new DeleteAdminUserUseCase().execute(UID);

    expect(result.isSuccess).toBe(true);
    expect(ordem).toEqual(['firebase', 'banco']);
    expect(mockDeleteUser).toHaveBeenCalledWith(UID);
    expect(mockDeleteByFirebaseUid).toHaveBeenCalledWith(UID);
  });

  it('o trigger do banco recusando (23514 anti-lockout) vira o MESMO código — segunda tranca', async () => {
    mockDeleteByFirebaseUid.mockRejectedValue(
      Object.assign(new Error('[iam] DELETE rejeitado: deixaria ZERO gestores (anti-lockout)'), { code: '23514' }),
    );

    const result = await new DeleteAdminUserUseCase().execute(UID);

    expect(result.error).toBe(LAST_MANAGER_ERROR);
  });

  it('outro erro do banco segue com a mensagem original', async () => {
    mockDeleteByFirebaseUid.mockRejectedValue(new Error('connection reset'));
    const result = await new DeleteAdminUserUseCase().execute(UID);
    expect(result.error).toBe('connection reset');
  });

  it('erro sem ser Error cai na mensagem padrão', async () => {
    mockDeleteUser.mockRejectedValue('boom');
    const result = await new DeleteAdminUserUseCase().execute(UID);
    expect(result.error).toBe('Failed to delete admin user');
  });
});
