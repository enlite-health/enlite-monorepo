/**
 * ListContactNotesUseCase.test.ts
 *
 * Migration 235: params passam a ser { vacancyId, workerId, requesterAdminId }
 * (antes: wjaId). Guard via validateCandidateVacancyPair; leitura via
 * findByWorkerAndVacancy (par worker_id+job_posting_id).
 *
 * Cenários:
 * 1. guard — par não pertence à vacante → not_found
 * 2. sucesso — lista notas do par e computa canDelete por nota
 */

const mockValidateCandidateVacancyPair = jest.fn();
const mockFindByWorkerAndVacancy = jest.fn();

jest.mock('../../infrastructure/ContactNoteRepository', () => ({
  ContactNoteRepository: jest.fn().mockImplementation(() => ({
    validateCandidateVacancyPair: mockValidateCandidateVacancyPair,
    findByWorkerAndVacancy: mockFindByWorkerAndVacancy,
  })),
}));

import { ListContactNotesUseCase } from '../ListContactNotesUseCase';

const WORKER_ID = 'aaaa0000-0000-0000-0000-111111111111';
const VACANCY_ID = 'bbbb0000-0000-0000-0000-222222222222';

describe('ListContactNotesUseCase', () => {
  let useCase: ListContactNotesUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new ListContactNotesUseCase();
  });

  it('par não pertence à vacante → not_found, sem consultar notas', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(false);

    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      workerId: WORKER_ID,
      requesterAdminId: 'admin-1',
    });

    expect(mockValidateCandidateVacancyPair).toHaveBeenCalledWith(WORKER_ID, VACANCY_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(mockFindByWorkerAndVacancy).not.toHaveBeenCalled();
  });

  it('sucesso: lista via findByWorkerAndVacancy e computa canDelete (autor+recente=true)', async () => {
    mockValidateCandidateVacancyPair.mockResolvedValueOnce(true);
    mockFindByWorkerAndVacancy.mockResolvedValueOnce([
      {
        id: 'note-own-recent',
        workerId: WORKER_ID,
        jobPostingId: VACANCY_ID,
        workerJobApplicationId: null,
        noteText: 'nota do autor, recente',
        createdByAdminId: 'admin-1',
        createdByAdminName: null,
        createdByAdminEmail: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'note-foreign',
        workerId: WORKER_ID,
        jobPostingId: VACANCY_ID,
        workerJobApplicationId: 'wja-1',
        noteText: 'nota de outro operador',
        createdByAdminId: 'admin-2',
        createdByAdminName: null,
        createdByAdminEmail: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      workerId: WORKER_ID,
      requesterAdminId: 'admin-1',
    });

    expect(mockFindByWorkerAndVacancy).toHaveBeenCalledWith(WORKER_ID, VACANCY_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notes.find(n => n.id === 'note-own-recent')?.canDelete).toBe(true);
      expect(result.notes.find(n => n.id === 'note-foreign')?.canDelete).toBe(false);
    }
  });
});
