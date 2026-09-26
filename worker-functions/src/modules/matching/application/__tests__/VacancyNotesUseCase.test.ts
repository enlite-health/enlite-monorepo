/**
 * VacancyNotesUseCase.test.ts
 *
 * Cenários:
 * 1. list() — vaga inexistente → not_found, sem chamar listByVacancy
 * 2. list() — vaga existe → devolve as notas do repo
 * 3. create() — payload inválido (categoria fora do enum) → validation, sem tocar o repo
 * 4. create() — vaga inexistente → not_found (só depois de validar o payload)
 * 5. create() — sucesso — delega ao repo com os campos corretos + createdBy do actor
 */

const mockVacancyExists = jest.fn();
const mockListByVacancy = jest.fn();
const mockInsert = jest.fn();

jest.mock('../../infrastructure/VacancyNoteRepository', () => ({
  VacancyNoteRepository: jest.fn().mockImplementation(() => ({
    vacancyExists: mockVacancyExists,
    listByVacancy: mockListByVacancy,
    insert: mockInsert,
  })),
}));

import { VacancyNotesUseCase } from '../VacancyNotesUseCase';

const VACANCY_ID = 'bbbbbbbb-0000-0000-0000-222222222222';

const validPayload = {
  occurredAt: new Date().toISOString(),
  category: 'DIVULGACAO',
  contact: 'grupo Facebook X',
  body: 'Publicado no grupo.',
};

describe('VacancyNotesUseCase', () => {
  let useCase: VacancyNotesUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    useCase = new VacancyNotesUseCase();
  });

  describe('list()', () => {
    it('vaga inexistente → not_found, sem chamar listByVacancy', async () => {
      mockVacancyExists.mockResolvedValueOnce(false);

      const result = await useCase.list(VACANCY_ID);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('not_found');
      expect(mockListByVacancy).not.toHaveBeenCalled();
    });

    it('vaga existe → devolve as notas do repo', async () => {
      mockVacancyExists.mockResolvedValueOnce(true);
      mockListByVacancy.mockResolvedValueOnce([{ id: 'n1' }]);

      const result = await useCase.list(VACANCY_ID);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.notes).toEqual([{ id: 'n1' }]);
      expect(mockListByVacancy).toHaveBeenCalledWith(VACANCY_ID);
    });
  });

  describe('create()', () => {
    it('categoria fora do enum → validation, sem tocar o repo', async () => {
      const result = await useCase.create(VACANCY_ID, { ...validPayload, category: 'BLOQUEADO' }, 'staff:uid-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('validation');
      expect(mockVacancyExists).not.toHaveBeenCalled();
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('vaga inexistente (payload válido) → not_found', async () => {
      mockVacancyExists.mockResolvedValueOnce(false);

      const result = await useCase.create(VACANCY_ID, validPayload, 'staff:uid-1');

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.kind).toBe('not_found');
      expect(mockInsert).not.toHaveBeenCalled();
    });

    it('sucesso — delega ao repo com os campos corretos e createdBy do actor', async () => {
      mockVacancyExists.mockResolvedValueOnce(true);
      mockInsert.mockResolvedValueOnce({ id: 'n1', jobPostingId: VACANCY_ID, ...validPayload });

      const result = await useCase.create(VACANCY_ID, validPayload, 'staff:uid-1');

      expect(result.ok).toBe(true);
      expect(mockInsert).toHaveBeenCalledWith({
        jobPostingId: VACANCY_ID,
        occurredAt: validPayload.occurredAt,
        category: validPayload.category,
        contact: validPayload.contact,
        body: validPayload.body,
        createdBy: 'staff:uid-1',
      });
    });
  });
});
