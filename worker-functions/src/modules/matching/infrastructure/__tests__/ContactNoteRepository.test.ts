/**
 * ContactNoteRepository.test.ts
 *
 * Testes unitários (mock de pool) do repositório escopado somente à VAGA
 * (job_posting_id) — migration 236. Antes (migration 235) a chave era o par
 * (worker_id, job_posting_id); o produto decidiu que a thread de notas é
 * ÚNICA POR VAGA (aparece idêntica em todos os cards/candidatos), então
 * worker_id e worker_job_application_id foram removidos. Ver
 * ContactNoteRepository.ts.
 *
 * Cenários:
 *   1. insert() grava só job_posting_id/note_text/autor
 *   2. findByVacancy() filtra por job_posting_id, ORDER BY created_at DESC
 *   3. findOwnershipById() retorna jobPostingId (não mais workerId/workerJobApplicationId)
 *   4. deleteById() — DELETE por id
 *   5. validateVacancyExists() — true quando a vaga existe em job_postings; false caso contrário
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { ContactNoteRepository } from '../ContactNoteRepository';

const VACANCY_ID = 'bbbbbbbb-0000-0000-0000-222222222222';
const NOTE_ID = 'cccccccc-0000-0000-0000-333333333333';
const NOW = new Date('2026-07-01T12:00:00.000Z').toISOString();

function makeNoteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTE_ID,
    job_posting_id: VACANCY_ID,
    note_text: 'Contato feito via WhatsApp',
    created_by_admin_id: 'admin-1',
    created_by_admin_name: 'Operadora Teste',
    created_by_admin_email: 'admin@e2e.local',
    created_at: NOW,
    ...overrides,
  };
}

describe('ContactNoteRepository', () => {
  let repo: ContactNoteRepository;

  beforeEach(() => {
    mockQuery.mockReset();
    repo = new ContactNoteRepository();
  });

  // ── insert() ──────────────────────────────────────────────────────────

  describe('insert()', () => {
    it('grava só job_posting_id, note_text e autor', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeNoteRow()] });

      const result = await repo.insert({
        jobPostingId: VACANCY_ID,
        noteText: 'Contato feito via WhatsApp',
        createdByAdminId: 'admin-1',
        createdByAdminName: 'Operadora Teste',
        createdByAdminEmail: 'admin@e2e.local',
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO wja_contact_notes');
      expect(sql).toContain('job_posting_id');
      expect(sql).not.toContain('worker_id');
      expect(sql).not.toContain('worker_job_application_id');
      expect(params).toEqual([VACANCY_ID, 'Contato feito via WhatsApp', 'admin-1', 'Operadora Teste', 'admin@e2e.local']);

      expect(result.jobPostingId).toBe(VACANCY_ID);
      expect(result).not.toHaveProperty('workerId');
      expect(result).not.toHaveProperty('workerJobApplicationId');
    });
  });

  // ── findByVacancy() ───────────────────────────────────────────────────

  describe('findByVacancy()', () => {
    it('filtra por job_posting_id, ORDER BY created_at DESC', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeNoteRow()] });

      const result = await repo.findByVacancy(VACANCY_ID);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('WHERE job_posting_id = $1');
      expect(sql).toMatch(/ORDER BY created_at DESC/);
      expect(params).toEqual([VACANCY_ID]);

      expect(result).toHaveLength(1);
      expect(result[0].jobPostingId).toBe(VACANCY_ID);
    });

    it('retorna array vazio quando não há notas para a vaga', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await repo.findByVacancy(VACANCY_ID);
      expect(result).toEqual([]);
    });
  });

  // ── findOwnershipById() ───────────────────────────────────────────────

  describe('findOwnershipById()', () => {
    it('retorna jobPostingId — não mais workerId/workerJobApplicationId', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: NOTE_ID,
          job_posting_id: VACANCY_ID,
          created_by_admin_id: 'admin-1',
          created_at: NOW,
        }],
      });

      const result = await repo.findOwnershipById(NOTE_ID);

      expect(result).toEqual({
        id: NOTE_ID,
        jobPostingId: VACANCY_ID,
        createdByAdminId: 'admin-1',
        createdAt: NOW,
      });
    });

    it('retorna null quando a nota não existe', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await repo.findOwnershipById('unknown-id');
      expect(result).toBeNull();
    });
  });

  // ── deleteById() ──────────────────────────────────────────────────────

  it('deleteById() executa DELETE por id', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await repo.deleteById(NOTE_ID);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('DELETE FROM wja_contact_notes WHERE id = $1');
    expect(params).toEqual([NOTE_ID]);
  });

  // ── validateVacancyExists() ───────────────────────────────────────────

  describe('validateVacancyExists()', () => {
    it('SQL verifica EXISTS em job_postings', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });

      const result = await repo.validateVacancyExists(VACANCY_ID);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('job_postings');
      expect(params).toEqual([VACANCY_ID]);
      expect(result).toBe(true);
    });

    it('retorna false quando a vaga não existe', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
      const result = await repo.validateVacancyExists(VACANCY_ID);
      expect(result).toBe(false);
    });
  });
});
