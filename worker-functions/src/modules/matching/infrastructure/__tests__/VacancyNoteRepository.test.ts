/**
 * VacancyNoteRepository.test.ts
 *
 * Testes unitários (mock de pool) do repositório de anotações da vacante
 * (migration 476, job_posting_notes). Cobre o SQL de listByVacancy
 * (ORDER BY occurred_at DESC) e o mapeamento Date → ISO / authorEmail
 * null quando o LEFT JOIN não acha usuário.
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { VacancyNoteRepository } from '../VacancyNoteRepository';

const VACANCY_ID = 'bbbbbbbb-0000-0000-0000-222222222222';
const NOTE_ID = 'cccccccc-0000-0000-0000-333333333333';
const OCCURRED_AT = new Date('2026-07-01T12:00:00.000Z');
const CREATED_AT = new Date('2026-07-01T12:00:05.000Z');

describe('VacancyNoteRepository', () => {
  let repo: VacancyNoteRepository;

  beforeEach(() => {
    mockQuery.mockReset();
    repo = new VacancyNoteRepository();
  });

  describe('vacancyExists()', () => {
    it('true quando encontra uma linha', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
      const result = await repo.vacancyExists(VACANCY_ID);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('SELECT 1 FROM job_postings WHERE id = $1 AND deleted_at IS NULL');
      expect(params).toEqual([VACANCY_ID]);
      expect(result).toBe(true);
    });

    it('false quando não encontra', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
      const result = await repo.vacancyExists(VACANCY_ID);
      expect(result).toBe(false);
    });
  });

  describe('insert()', () => {
    it('grava os 6 campos e devolve authorEmail null', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: NOTE_ID,
          job_posting_id: VACANCY_ID,
          occurred_at: OCCURRED_AT,
          category: 'DIVULGACAO',
          contact: 'grupo Facebook X',
          body: 'Publicado.',
          created_by: 'staff:uid-1',
          created_at: CREATED_AT,
        }],
      });

      const result = await repo.insert({
        jobPostingId: VACANCY_ID,
        occurredAt: OCCURRED_AT.toISOString(),
        category: 'DIVULGACAO',
        contact: 'grupo Facebook X',
        body: 'Publicado.',
        createdBy: 'staff:uid-1',
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('INSERT INTO job_posting_notes');
      expect(sql).toContain('(job_posting_id, occurred_at, category, contact, body, created_by)');
      expect(params).toEqual([
        VACANCY_ID,
        OCCURRED_AT.toISOString(),
        'DIVULGACAO',
        'grupo Facebook X',
        'Publicado.',
        'staff:uid-1',
      ]);

      expect(result.jobPostingId).toBe(VACANCY_ID);
      expect(result.occurredAt).toBe(OCCURRED_AT.toISOString());
      expect(result.createdAt).toBe(CREATED_AT.toISOString());
      expect(result.authorEmail).toBeNull();
    });
  });

  describe('listByVacancy()', () => {
    it('ORDER BY occurred_at DESC e resolve authorEmail via LEFT JOIN', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: NOTE_ID,
          job_posting_id: VACANCY_ID,
          occurred_at: OCCURRED_AT,
          category: 'CONTATO',
          contact: '+54 9 11 0000-0000',
          body: 'Ligação feita.',
          created_by: 'staff:uid-1',
          created_at: CREATED_AT,
          author_email: 'operadora@enlite.health',
        }],
      });

      const result = await repo.listByVacancy(VACANCY_ID);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain('WHERE n.job_posting_id = $1');
      expect(sql).toMatch(/ORDER BY n\.occurred_at DESC, n\.created_at DESC/);
      expect(sql).toContain("LEFT JOIN users u");
      expect(params).toEqual([VACANCY_ID]);

      expect(result).toHaveLength(1);
      expect(result[0].authorEmail).toBe('operadora@enlite.health');
      expect(result[0].occurredAt).toBe(OCCURRED_AT.toISOString());
    });

    it('authorEmail null quando o join não acha usuário', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{
          id: NOTE_ID,
          job_posting_id: VACANCY_ID,
          occurred_at: OCCURRED_AT,
          category: 'OUTRO',
          contact: 'sistema',
          body: 'nota sem autor resolvido',
          created_by: 'staff:uid-desconhecido',
          created_at: CREATED_AT,
          author_email: null,
        }],
      });

      const result = await repo.listByVacancy(VACANCY_ID);
      expect(result[0].authorEmail).toBeNull();
    });

    it('array vazio quando não há notas', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await repo.listByVacancy(VACANCY_ID);
      expect(result).toEqual([]);
    });
  });
});
