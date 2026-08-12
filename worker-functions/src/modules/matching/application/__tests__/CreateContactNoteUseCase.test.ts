/**
 * CreateContactNoteUseCase.test.ts
 *
 * Migration 235: params passam a ser { vacancyId, workerId, ... } (antes: wjaId).
 * Guard de pertencimento passa a ser validateCandidateVacancyPair (WJA real OU
 * tentativa bloqueada) em vez de wjaBelongsToVacancy.
 *
 * Cenários:
 * 1. validação — noteText vazio → kind='validation'
 * 2. validação — noteText > 240 chars → kind='validation'
 * 3. guard — par (workerId, vacancyId) não existe (nem WJA nem blocked) → not_found
 * 4. sucesso — insere delegando pro repo com workerId/jobPostingId corretos
 * 5. snapshot do autor — usa displayName/email do AdminRepository quando disponível
 * 6. snapshot do autor — fallback pro email do token quando admin não encontrado
 */

const mockValidateCandidateVacancyPair = jest.fn();
const mockInsert = jest.fn();

jest.mock('../../infrastructure/ContactNoteRepository', () => ({
  ContactNoteRepository: jest.fn().mockImplementation(() => ({
    validateCandidateVacancyPair: mockValidateCandidateVacancyPair,
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

const WORKER_ID = 'aaaa0000-0000-0000-0000-111111111111';
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
      workerId: WORKER_ID,
      noteText: '   ',
      adminId: 'admin-1',
      adminEmail: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
    expect(mockValidateCandidateVacancyPair).not.toHaveBeenCalled();
  });

  it('noteText > 240 chars → validation error', async () => {
    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      workerId: WORKER_ID,
      noteText: 'a'.repeat(241),
      adminId: 'admin-1',
      adminEmail: null,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation');
  });

  it('par (workerId, vacancyId) sem WJA nem tentativa bloqueada → not_found', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(false);

    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      workerId: WORKER_ID,
      noteText: 'Nota válida',
      adminId: 'admin-1',
      adminEmail: null,
    });

    expect(mockValidateCandidateVacancyPair).toHaveBeenCalledWith(WORKER_ID, VACANCY_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('sucesso: insere delegando workerId/jobPostingId (não workerJobApplicationId) pro repo', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(true);
    mockFindByFirebaseUid.mockResolvedValueOnce({ displayName: 'Operadora', email: 'op@e2e.local' });
    mockInsert.mockResolvedValueOnce({
      id: 'note-1',
      workerId: WORKER_ID,
      jobPostingId: VACANCY_ID,
      workerJobApplicationId: null,
      noteText: 'Nota válida',
      createdByAdminId: 'admin-1',
      createdByAdminName: 'Operadora',
      createdByAdminEmail: 'op@e2e.local',
      createdAt: '2026-07-01T12:00:00.000Z',
    });

    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      workerId: WORKER_ID,
      noteText: 'Nota válida',
      adminId: 'admin-1',
      adminEmail: 'token@e2e.local',
    });

    expect(mockInsert).toHaveBeenCalledWith({
      workerId: WORKER_ID,
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
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(true);
    mockFindByFirebaseUid.mockResolvedValueOnce(null);
    mockInsert.mockResolvedValueOnce({
      id: 'note-2',
      workerId: WORKER_ID,
      jobPostingId: VACANCY_ID,
      workerJobApplicationId: null,
      noteText: 'Nota sem admin cadastrado',
      createdByAdminId: 'admin-1',
      createdByAdminName: null,
      createdByAdminEmail: 'token@e2e.local',
      createdAt: '2026-07-01T12:00:00.000Z',
    });

    await useCase.execute({
      vacancyId: VACANCY_ID,
      workerId: WORKER_ID,
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
