/**
 * UpdateAdminRoleUseCase — o caminho que MORDE em prod no achado de QA de 16/08:
 * uma troca de papel pelo painel gravava `{ role }` por cima de todos os claims
 * e apagava o `country` da ABAC — o staff sumia do próprio país (fail-closed)
 * até alguém rodar o script da 3.2 de novo. Agora passa por `mergeCustomClaims`.
 */

const mockFindByFirebaseUid = jest.fn();
const mockUpdateRole = jest.fn();
jest.mock('../../infrastructure/AdminRepository', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({
    findByFirebaseUid: mockFindByFirebaseUid,
    updateRole: mockUpdateRole,
  })),
}));

const mockMergeCustomClaims = jest.fn();
jest.mock('../../infrastructure/mergeCustomClaims', () => ({
  mergeCustomClaims: (...args: unknown[]) => mockMergeCustomClaims(...args),
}));

import { UpdateAdminRoleUseCase } from '../UpdateAdminRoleUseCase';

const UID = 'uid-staff-1';
const existing = { firebaseUid: UID, email: 'flor@enlite.health', role: 'recruiter' };

describe('UpdateAdminRoleUseCase', () => {
  const ORIGINAL_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    mockFindByFirebaseUid.mockReset();
    mockUpdateRole.mockReset().mockResolvedValue(undefined);
    mockMergeCustomClaims.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_ENV;
  });

  it('rejeita papel que não é de staff', async () => {
    const result = await new UpdateAdminRoleUseCase().execute({ firebaseUid: UID, newRole: 'worker' });
    expect(result.isFailure).toBe(true);
    expect(result.error).toContain('Invalid staff role');
    expect(mockFindByFirebaseUid).not.toHaveBeenCalled();
  });

  it('usuário inexistente → falha sem tocar em claims', async () => {
    mockFindByFirebaseUid.mockResolvedValue(null);
    const result = await new UpdateAdminRoleUseCase().execute({ firebaseUid: UID, newRole: 'admin' });
    expect(result.error).toBe('User not found');
    expect(mockMergeCustomClaims).not.toHaveBeenCalled();
  });

  it('mesmo papel → falha idempotente, sem escrita', async () => {
    mockFindByFirebaseUid.mockResolvedValue(existing);
    const result = await new UpdateAdminRoleUseCase().execute({ firebaseUid: UID, newRole: 'recruiter' });
    expect(result.error).toBe('User already has this role');
    expect(mockUpdateRole).not.toHaveBeenCalled();
  });

  it('fora de test: atualiza o banco e MERGEIA o claim (nunca setCustomUserClaims cru)', async () => {
    process.env.NODE_ENV = 'production';
    const updated = { ...existing, role: 'admin' };
    mockFindByFirebaseUid.mockResolvedValueOnce(existing).mockResolvedValueOnce(updated);

    const result = await new UpdateAdminRoleUseCase().execute({ firebaseUid: UID, newRole: 'admin', department: 'ops' });

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toEqual(updated);
    expect(mockUpdateRole).toHaveBeenCalledWith(UID, 'admin', { department: 'ops' });
    // O merge é o que preserva `country` — o teste do helper prova o merge em si.
    expect(mockMergeCustomClaims).toHaveBeenCalledWith(UID, { role: 'admin' });
  });

  it('em NODE_ENV=test não toca no Identity Platform', async () => {
    process.env.NODE_ENV = 'test';
    mockFindByFirebaseUid.mockResolvedValueOnce(existing).mockResolvedValueOnce({ ...existing, role: 'admin' });

    await new UpdateAdminRoleUseCase().execute({ firebaseUid: UID, newRole: 'admin' });

    expect(mockUpdateRole).toHaveBeenCalled();
    expect(mockMergeCustomClaims).not.toHaveBeenCalled();
  });

  it('erro no banco vira Result.fail com a mensagem, sem propagar', async () => {
    mockFindByFirebaseUid.mockResolvedValue(existing);
    mockUpdateRole.mockRejectedValue(new Error('change_user_role falhou'));

    const result = await new UpdateAdminRoleUseCase().execute({ firebaseUid: UID, newRole: 'admin' });

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('change_user_role falhou');
  });

  it('erro não-Error vira a mensagem genérica', async () => {
    mockFindByFirebaseUid.mockResolvedValue(existing);
    mockUpdateRole.mockRejectedValue('string crua');

    const result = await new UpdateAdminRoleUseCase().execute({ firebaseUid: UID, newRole: 'admin' });

    expect(result.error).toBe('Failed to update user role');
  });
});
