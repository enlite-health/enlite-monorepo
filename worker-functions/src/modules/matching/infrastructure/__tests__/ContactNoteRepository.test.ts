/**
 * ContactNoteRepository.test.ts
 *
 * Testes unitários (mock de pool) do repositório re-chaveado para o par
 * estável (worker_id, job_posting_id) — migration 235. Antes desta migration
 * a chave era worker_job_application_id (WJA); um card BLOQUEADO
 * (worker_blocked_applications) não tem WJA, então notas escritas nesse
 * estágio não tinham onde ser penduradas. Ver ContactNoteRepository.ts.
 *
 * Cenários:
 *   1. insert() grava worker_id/job_posting_id e resolve worker_job_application_id
 *      via subquery (pode ser NULL quando não existe WJA ainda — card BLOQUEADO)
 *   2. findByWorkerAndVacancy() filtra por worker_id+job_posting_id, ORDER BY created_at DESC
 *   3. findOwnershipById() retorna workerId/jobPostingId (não mais workerJobApplicationId)
 *   4. deleteById() — DELETE por id
 *   5. validateCandidateVacancyPair() — true quando existe WJA OU worker_blocked_applications
 *      para o par; false quando nenhum dos dois existe
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

const WORKER_ID = 'aaaaaaaa-0000-0000-0000-111111111111';
const VACANCY_ID = 'bbbbbbbb-0000-0000-0000-222222222222';
const NOTE_ID = 'cccccccc-0000-0000-0000-333333333333';
const NOW = new Date('2026-07-01T12:00:00.000Z').toISOString();

function makeNoteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTE_ID,
    worker_id: WORKER_ID,
    job_posting_id: VACANCY_ID,
    worker_job_application_id: null,
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
    it('grava worker_id/job_posting_id e usa subquery para resolver worker_job_application_id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeNoteRow({ worker_job_application_id: 'wja-1' })] });

      const result = await repo.insert({
        workerId: WORKER_ID,
        jobPostingId: VACANCY_ID,
        noteText: 'Contato feito via WhatsApp',
        createdByAdminId: 'admin-1',
        createdByAdminName: 'Operadora Teste',
        createdByAdminEmail: 'admin@e2e.local',
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO wja_contact_notes');
      expect(sql).toContain('worker_id, job_posting_id, worker_job_application_id');
      expect(sql).toContain('SELECT id FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2');
      expect(params).toEqual([WORKER_ID, VACANCY_ID, 'Contato feito via WhatsApp', 'admin-1', 'Operadora Teste', 'admin@e2e.local']);

      expect(result.workerId).toBe(WORKER_ID);
      expect(result.jobPostingId).toBe(VACANCY_ID);
      expect(result.workerJobApplicationId).toBe('wja-1');
    });

    it('workerJobApplicationId fica null quando não existe WJA (card ainda BLOQUEADO)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeNoteRow({ worker_job_application_id: null })] });

      const result = await repo.insert({
        workerId: WORKER_ID,
        jobPostingId: VACANCY_ID,
        noteText: 'Nota em card bloqueado',
        createdByAdminId: 'admin-1',
        createdByAdminName: null,
        createdByAdminEmail: null,
      });

      expect(result.workerJobApplicationId).toBeNull();
    });
  });

  // ── findByWorkerAndVacancy() ──────────────────────────────────────────

  describe('findByWorkerAndVacancy()', () => {
    it('filtra por worker_id + job_posting_id, ORDER BY created_at DESC', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [makeNoteRow()] });

      const result = await repo.findByWorkerAndVacancy(WORKER_ID, VACANCY_ID);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('WHERE worker_id = $1 AND job_posting_id = $2');
      expect(sql).toMatch(/ORDER BY created_at DESC/);
      expect(params).toEqual([WORKER_ID, VACANCY_ID]);

      expect(result).toHaveLength(1);
      expect(result[0].workerId).toBe(WORKER_ID);
      expect(result[0].jobPostingId).toBe(VACANCY_ID);
    });

    it('retorna array vazio quando não há notas para o par', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await repo.findByWorkerAndVacancy(WORKER_ID, VACANCY_ID);
      expect(result).toEqual([]);
    });
  });

  // ── findOwnershipById() ───────────────────────────────────────────────

  describe('findOwnershipById()', () => {
    it('retorna workerId/jobPostingId (par estável) — não workerJobApplicationId', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: NOTE_ID,
          worker_id: WORKER_ID,
          job_posting_id: VACANCY_ID,
          created_by_admin_id: 'admin-1',
          created_at: NOW,
        }],
      });

      const result = await repo.findOwnershipById(NOTE_ID);

      expect(result).toEqual({
        id: NOTE_ID,
        workerId: WORKER_ID,
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

  // ── validateCandidateVacancyPair() ───────────────────────────────────

  describe('validateCandidateVacancyPair()', () => {
    it('SQL verifica EXISTS em worker_job_applications OR worker_blocked_applications', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: true }] });

      const result = await repo.validateCandidateVacancyPair(WORKER_ID, VACANCY_ID);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('EXISTS');
      expect(sql).toContain('worker_job_applications');
      expect(sql).toContain('worker_blocked_applications');
      expect(sql).toContain('OR');
      expect(params).toEqual([WORKER_ID, VACANCY_ID]);
      expect(result).toBe(true);
    });

    it('retorna false quando nem WJA nem blocked existem para o par', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ exists: false }] });
      const result = await repo.validateCandidateVacancyPair(WORKER_ID, VACANCY_ID);
      expect(result).toBe(false);
    });
  });
});
