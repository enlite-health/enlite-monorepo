/**
 * ListContactNotesUseCase.test.ts
 *
 * Migration 236: params passam a ser { vacancyId, requesterAdminId } (sem
 * workerId — a nota é escopada só à vaga, não ao par candidato×vaga). Guard
 * via validateVacancyExists; leitura via findByVacancy(vacancyId).
 *
 * Cenários:
 * 1. guard — vaga não existe → not_found
 * 2. sucesso — lista notas da vaga e computa canDelete por nota
 */

const mockValidateVacancyExists = jest.fn();
const mockFindByVacancy = jest.fn();

jest.mock('../../infrastructure/ContactNoteRepository', () => ({
  ContactNoteRepository: jest.fn().mockImplementation(() => ({
    validateVacancyExists: mockValidateVacancyExists,
    findByVacancy: mockFindByVacancy,
  })),
}));

import { ListContactNotesUseCase } from '../ListContactNotesUseCase';

const VACANCY_ID = 'bbbb0000-0000-0000-0000-222222222222';

describe('ListContactNotesUseCase', () => {
  let useCase: ListContactNotesUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new ListContactNotesUseCase();
  });

  it('vaga não existe → not_found, sem consultar notas', async () => {
    mockValidateVacancyExists.mockResolvedValueOnce(false);

    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      requesterAdminId: 'admin-1',
    });

    expect(mockValidateVacancyExists).toHaveBeenCalledWith(VACANCY_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('not_found');
    expect(mockFindByVacancy).not.toHaveBeenCalled();
  });

  it('sucesso: lista via findByVacancy e computa canDelete (autor+recente=true)', async () => {
    mockValidateVacancyExists.mockResolvedValueOnce(true);
    mockFindByVacancy.mockResolvedValueOnce([
      {
        id: 'note-own-recent',
        jobPostingId: VACANCY_ID,
        noteText: 'nota do autor, recente',
        createdByAdminId: 'admin-1',
        createdByAdminName: null,
        createdByAdminEmail: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'note-foreign',
        jobPostingId: VACANCY_ID,
        noteText: 'nota de outro operador',
        createdByAdminId: 'admin-2',
        createdByAdminName: null,
        createdByAdminEmail: null,
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await useCase.execute({
      vacancyId: VACANCY_ID,
      requesterAdminId: 'admin-1',
    });

    expect(mockFindByVacancy).toHaveBeenCalledWith(VACANCY_ID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.notes.find(n => n.id === 'note-own-recent')?.canDelete).toBe(true);
      expect(result.notes.find(n => n.id === 'note-foreign')?.canDelete).toBe(false);
    }
  });
});
