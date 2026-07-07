/**
 * CreateContactNoteUseCase.test.ts
 *
 * Migration 236: params passam a ser { vacancyId, noteText, adminId, adminEmail }
 * (antes: também workerId). Guard de existência passa a ser validateVacancyExists
 * (a vaga precisa existir; não há mais noção de par candidato×vaga — a nota é
 * escopada SÓ à vaga).
 *
 * Cenários:
 * 1. validação — noteText vazio → kind='validation'
 * 2. validação — noteText > 240 chars → kind='validation'
 * 3. guard — vaga não existe → not_found
 * 4. sucesso — insere delegando pro repo com jobPostingId=vacancyId
 * 5. snapshot do autor — usa displayName/email do AdminRepository quando disponível
 * 6. snapshot do autor — fallback pro email do token quando admin não encontrado
 */

const mockValidateVacancyExists = jest.fn();
const mockInsert = jest.fn();

jest.mock('../../infrastructure/ContactNoteRepository', () => ({
  ContactNoteRepository: jest.fn().mockImplementation(() => ({
    validateVacancyExists: mockValidateVacancyExists,
    insert: mockInsert,
  })),
}));

const mockFindByFirebaseUid = jest.fn();

jest.mock('@modules/identity', () => ({
  AdminRepository: jest.fn().mockImplementation(() => ({
    findByFirebaseUid: mockFindByFirebaseUid,
  })),
}));

import { CreateContactNoteUseCase } from '../CreateContactNoteUseCase';

const VACANCY_ID = 'bbbb0000-0000-0000-0000-222222222222';

describe('CreateContactNoteUseCase', () => {
  let useCase: CreateContactNoteUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new CreateContactNoteUseCase();
  });

  it('noteText vazio → validation error, sem tocar o repo', async () => {
    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      noteText: '   ',
      adminId: 'admin-1',
      adminEmail: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
    expect(mockValidateVacancyExists).not.toHaveBeenCalled();
  });

  it('noteText > 240 chars → validation error', async () => {
    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      noteText: 'a'.repeat(241),
      adminId: 'admin-1',
      adminEmail: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });

  it('vaga inexistente → not_found', async () => {
    mockValidateVacancyExists.mockResolvedValueOnce(false);

    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      noteText: 'Nota válida',
      adminId: 'admin-1',
      adminEmail: null,
    });

    expect(mockValidateVacancyExists).toHaveBeenCalledWith(VACANCY_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('sucesso: insere delegando jobPostingId=vacancyId pro repo (sem workerId)', async () => {
    mockValidateVacancyExists.mockResolvedValueOnce(true);
    mockFindByFirebaseUid.mockResolvedValueOnce({ displayName: 'Operadora', email: 'op@e2e.local' });
    mockInsert.mockResolvedValueOnce({
      id: 'note-1',
      jobPostingId: VACANCY_ID,
      noteText: 'Nota válida',
      createdByAdminId: 'admin-1',
      createdByAdminName: 'Operadora',
      createdByAdminEmail: 'op@e2e.local',
      createdAt: '2026-07-01T12:00:00.000Z',
    });

    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      noteText: 'Nota válida',
      adminId: 'admin-1',
      adminEmail: 'token@e2e.local',
    });

    expect(mockInsert).toHaveBeenCalledWith({
      jobPostingId: VACANCY_ID,
      noteText: 'Nota válida',
      createdByAdminId: 'admin-1',
      createdByAdminName: 'Operadora',
      createdByAdminEmail: 'op@e2e.local',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.note.id).toBe('note-1');
  });

  it('fallback: sem admin no cadastro → usa email do token e nome null', async () => {
    mockValidateVacancyExists.mockResolvedValueOnce(true);
    mockFindByFirebaseUid.mockResolvedValueOnce(null);
    mockInsert.mockResolvedValueOnce({
      id: 'note-2',
      jobPostingId: VACANCY_ID,
      noteText: 'Nota sem admin cadastrado',
      createdByAdminId: 'admin-1',
      createdByAdminName: null,
      createdByAdminEmail: 'token@e2e.local',
      createdAt: '2026-07-01T12:00:00.000Z',
    });

    await useCase.execute({
      vacancyId: VACANCY_ID,
      noteText: 'Nota sem admin cadastrado',
      adminId: 'admin-1',
      adminEmail: 'token@e2e.local',
    });

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        createdByAdminName: null,
        createdByAdminEmail: 'token@e2e.local',
      }),
    );
  });
});
