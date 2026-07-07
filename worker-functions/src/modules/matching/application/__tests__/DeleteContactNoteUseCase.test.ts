/**
 * DeleteContactNoteUseCase.test.ts
 *
 * Migration 235: params passam a ser { vacancyId, workerId, noteId, requesterAdminId }
 * (antes: wjaId). Guard via validateCandidateVacancyPair; pertencimento da nota
 * ao par verificado via note.workerId/note.jobPostingId (antes: workerJobApplicationId).
 *
 * Cenários:
 * 1. guard — par não pertence à vacante → not_found
 * 2. nota não encontrada → not_found
 * 3. nota pertence a OUTRO par (workerId/jobPostingId diferente) → not_found
 * 4. não-autor tenta excluir → forbidden/not_owner
 * 5. autor fora da janela de 2h → forbidden/window_expired
 * 6. autor dentro da janela → deleta com sucesso
 */

const mockValidateCandidateVacancyPair = jest.fn();
const mockFindOwnershipById = jest.fn();
const mockDeleteById = jest.fn();

jest.mock('../../infrastructure/ContactNoteRepository', () => ({
  ContactNoteRepository: jest.fn().mockImplementation(() => ({
    validateCandidateVacancyPair: mockValidateCandidateVacancyPair,
    findOwnershipById: mockFindOwnershipById,
    deleteById: mockDeleteById,
  })),
}));

import { DeleteContactNoteUseCase } from '../DeleteContactNoteUseCase';

const WORKER_ID = 'aaaa0000-0000-0000-0000-111111111111';
const VACANCY_ID = 'bbbb0000-0000-0000-0000-222222222222';
const OTHER_VACANCY_ID = 'cccc0000-0000-0000-0000-333333333333';
const NOTE_ID = 'note-1';

function baseParams(overrides: Partial<{ workerId: string; vacancyId: string }> = {}) {
  return {
    vacancyId: overrides.vacancyId ?? VACANCY_ID,
    workerId: overrides.workerId ?? WORKER_ID,
    noteId: NOTE_ID,
    requesterAdminId: 'admin-1',
  };
}

describe('DeleteContactNoteUseCase', () => {
  let useCase: DeleteContactNoteUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new DeleteContactNoteUseCase();
  });

  it('par não pertence à vacante → not_found, sem buscar a nota', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(false);

    const result = await useCase.execute(baseParams());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(mockFindOwnershipById).not.toHaveBeenCalled();
  });

  it('nota inexistente → not_found', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(true);
    mockFindOwnershipById.mockResolvedValueOnce(null);

    const result = await useCase.execute(baseParams());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
  });

  it('nota pertence a um par diferente (jobPostingId divergente) → not_found', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(true);
    mockFindOwnershipById.mockResolvedValueOnce({
      id: NOTE_ID,
      workerId: WORKER_ID,
      jobPostingId: OTHER_VACANCY_ID, // divergente do vacancyId solicitado
      createdByAdminId: 'admin-1',
      createdAt: new Date().toISOString(),
    });

    const result = await useCase.execute(baseParams());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(mockDeleteById).not.toHaveBeenCalled();
  });

  it('não-autor tenta excluir → forbidden/not_owner', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(true);
    mockFindOwnershipById.mockResolvedValueOnce({
      id: NOTE_ID,
      workerId: WORKER_ID,
      jobPostingId: VACANCY_ID,
      createdByAdminId: 'admin-OTHER',
      createdAt: new Date().toISOString(),
    });

    const result = await useCase.execute(baseParams());

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'forbidden') {
      expect(result.error.reason).toBe('not_owner');
    } else {
      throw new Error('expected forbidden/not_owner');
    }
  });

  it('autor fora da janela de 2h → forbidden/window_expired', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(true);
    mockFindOwnershipById.mockResolvedValueOnce({
      id: NOTE_ID,
      workerId: WORKER_ID,
      jobPostingId: VACANCY_ID,
      createdByAdminId: 'admin-1',
      createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
    });

    const result = await useCase.execute(baseParams());

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'forbidden') {
      expect(result.error.reason).toBe('window_expired');
    } else {
      throw new Error('expected forbidden/window_expired');
    }
    expect(mockDeleteById).not.toHaveBeenCalled();
  });

  it('autor dentro da janela → deleta com sucesso', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(true);
    mockFindOwnershipById.mockResolvedValueOnce({
      id: NOTE_ID,
      workerId: WORKER_ID,
      jobPostingId: VACANCY_ID,
      createdByAdminId: 'admin-1',
      createdAt: new Date().toISOString(),
    });
    mockDeleteById.mockResolvedValueOnce(undefined);

    const result = await useCase.execute(baseParams());

    expect(result.ok).toBe(true);
    expect(mockDeleteById).toHaveBeenCalledWith(NOTE_ID);
  });
});
