/**
 * ListAdminUsersUseCase — a lista do painel sai SEM `role` (07/09): o papel deixou
 * de ser nível de acesso e não existe mais tela que o mostre.
 */
const mockListAdmins = jest.fn();
jest.mock('../../infrastructure/AdminRepository', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({ listAdmins: mockListAdmins })),
}));

import { ListAdminUsersUseCase } from '../ListAdminUsersUseCase';

describe('ListAdminUsersUseCase', () => {
  beforeEach(() => mockListAdmins.mockReset());

  it('projeta cada registro sem `role` e preserva o total', async () => {
    mockListAdmins.mockResolvedValue({
      admins: [
        { firebaseUid: 'u1', email: 'a@enlite.health', displayName: 'A', role: 'admin', department: null, lastLoginAt: null, loginCount: 1, createdAt: 'x' },
        { firebaseUid: 'u2', email: 'b@enlite.health', displayName: 'B', role: 'recruiter', department: 'RH', lastLoginAt: null, loginCount: 0, createdAt: 'y' },
      ],
      total: 2,
    });

    const result = await new ListAdminUsersUseCase().execute(10, 0);

    expect(mockListAdmins).toHaveBeenCalledWith(10, 0);
    expect(result.isSuccess).toBe(true);
    const { admins, total } = result.getValue();
    expect(total).toBe(2);
    expect(admins.map((a) => a.firebaseUid)).toEqual(['u1', 'u2']);
    expect(admins.every((a) => !('role' in a))).toBe(true);
    expect(admins[1]).toMatchObject({ email: 'b@enlite.health', department: 'RH' });
  });

  it('usa os defaults de paginação (50, 0)', async () => {
    mockListAdmins.mockResolvedValue({ admins: [], total: 0 });
    await new ListAdminUsersUseCase().execute();
    expect(mockListAdmins).toHaveBeenCalledWith(50, 0);
  });

  it('erro do repositório vira Result.fail com a mensagem (Error) ou a genérica (não-Error)', async () => {
    mockListAdmins.mockRejectedValueOnce(new Error('banco fora'));
    expect((await new ListAdminUsersUseCase().execute()).error).toBe('banco fora');
    mockListAdmins.mockRejectedValueOnce('string');
    expect((await new ListAdminUsersUseCase().execute()).error).toBe('Failed to list admin users');
  });
});
