/**
 * JobPostingARRepository.test.ts
 *
 * Suíte nova (arquivo não tinha teste unit — achado da revisão da 028, F3 do
 * plano de execução) — cobertura 100% do arquivo, mock de pool no molde de
 * ContactNoteRepository.test.ts / BlockedApplicationRepository.test.ts.
 *
 * Cenários:
 *   1. upsertByCaseNumber() — update (existing) / insert (vnResult+formatCaseTitle) / catch+rethrow
 *   2. resolveCoordinatorId() (privado, exercitado via upsertByCaseNumber) — nome ausente vs presente
 *   3. findByCaseNumber() — found / null
 *   4. upsertFromClickUp() — update (title fill-only) / insert (title ?? formatCaseTitle) / upsertClickUpSync
 *   5. findActivePublic() — delega a buildPublicJobsWhere, devolve rows
 *   6. saveCommentIfNew() — texto vazio, sem comentário anterior, texto igual, texto mudou, contagem cresceu/não cresceu
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

import { JobPostingARRepository } from '../JobPostingARRepository';

describe('JobPostingARRepository', () => {
  let repo: JobPostingARRepository;

  beforeEach(() => {
    mockQuery.mockReset();
    repo = new JobPostingARRepository();
  });

  // ── upsertByCaseNumber() ──────────────────────────────────────────

  describe('upsertByCaseNumber', () => {
    it('vacante existente (case_number encontrado) → UPDATE, created=false', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'coord-1' }] })       // resolveCoordinatorId
        .mockResolvedValueOnce({ rows: [{ id: 'jp-existing' }] })   // lookup case_number
        .mockResolvedValueOnce({ rows: [] });                       // UPDATE

      const result = await repo.upsertByCaseNumber({
        caseNumber: 230,
        status: 'SEARCHING',
        coordinatorName: 'María',
      });

      expect(result).toEqual({ id: 'jp-existing', created: false });
      const updateCall = mockQuery.mock.calls[2];
      expect(updateCall[0]).toContain('UPDATE job_postings');
      expect(updateCall[1][0]).toBe('jp-existing');
    });

    it('sem coordinatorName → resolveCoordinatorId devolve null, sem INSERT em coordinators', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'jp-existing' }] })   // lookup case_number (resolveCoordinatorId nem chama query)
        .mockResolvedValueOnce({ rows: [] });                       // UPDATE

      await repo.upsertByCaseNumber({ caseNumber: 230 });

      // Só 2 chamadas: lookup + UPDATE — resolveCoordinatorId(undefined) não gerou query.
      expect(mockQuery).toHaveBeenCalledTimes(2);
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[1][5]).toBeNull(); // coordinatorId
    });

    it('case_number não encontrado → INSERT com título via formatCaseTitle (legado, <1000, sem prefixo)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })                        // lookup case_number (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '42' }] })            // nextval
        .mockResolvedValueOnce({ rows: [{ id: 'jp-new' }] });       // INSERT

      const result = await repo.upsertByCaseNumber({ caseNumber: 230 });

      expect(result).toEqual({ id: 'jp-new', created: true });
      const insertCall = mockQuery.mock.calls[2];
      expect(insertCall[0]).toContain('INSERT INTO job_postings');
      expect(insertCall[1][10]).toBe('CASO 230-42'); // title
      expect(insertCall[1][9]).toBe('AR');           // country default
    });

    it('case_number nativo (≥1000) → título com prefixo EN (D422)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ vn: '7' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-native' }] });

      await repo.upsertByCaseNumber({ caseNumber: 1234, country: 'UY' });

      const insertCall = mockQuery.mock.calls[2];
      expect(insertCall[1][10]).toBe('CASO EN1234-7');
      expect(insertCall[1][9]).toBe('UY');
    });

    it('erro no pool → loga e relança (não engole)', async () => {
      const dbError = new Error('connection refused');
      mockQuery.mockRejectedValueOnce(dbError); // resolveCoordinatorId ou lookup — primeira query falha
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();

      await expect(repo.upsertByCaseNumber({ caseNumber: 999 })).rejects.toThrow('connection refused');

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[JobPostingRepo.upsertByCaseNumber] ERROR'));
      errorSpy.mockRestore();
    });
  });

  // ── findByCaseNumber() ────────────────────────────────────────────

  describe('findByCaseNumber', () => {
    it('encontrado → devolve { id }', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'jp-1' }] });

      const result = await repo.findByCaseNumber(230);

      expect(result).toEqual({ id: 'jp-1' });
    });

    it('não encontrado → devolve null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const result = await repo.findByCaseNumber(999);

      expect(result).toBeNull();
    });
  });

  // ── upsertFromClickUp() ───────────────────────────────────────────

  describe('upsertFromClickUp', () => {
    it('vacante existente → UPDATE fill-only + upsertClickUpSync, created=false', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'jp-cu-1' }] })       // lookup
        .mockResolvedValueOnce({ rows: [] })                        // UPDATE job_postings
        .mockResolvedValueOnce({ rows: [] });                       // upsertClickUpSync INSERT

      const result = await repo.upsertFromClickUp({ caseNumber: 500, status: 'SEARCHING' });

      expect(result).toEqual({ id: 'jp-cu-1', created: false });
      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[0]).toContain('UPDATE job_postings');
      expect(updateCall[1][3]).toBe('Caso 500'); // title fallback (data.title ausente)
      const syncCall = mockQuery.mock.calls[2];
      expect(syncCall[0]).toContain('job_postings_clickup_sync');
      expect(syncCall[1][0]).toBe('jp-cu-1');
    });

    it('vacante existente com title explícito → não usa o fallback "Caso N"', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'jp-cu-2' }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.upsertFromClickUp({ caseNumber: 500, title: 'Título ClickUp' });

      const updateCall = mockQuery.mock.calls[1];
      expect(updateCall[1][3]).toBe('Título ClickUp');
    });

    it('case_number não encontrado + sem title → INSERT com formatCaseTitle + upsertClickUpSync, created=true', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })                        // lookup (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '9' }] })            // nextval
        .mockResolvedValueOnce({ rows: [{ id: 'jp-cu-new' }] })    // INSERT job_postings
        .mockResolvedValueOnce({ rows: [] });                       // upsertClickUpSync INSERT

      const result = await repo.upsertFromClickUp({ caseNumber: 230, clickupTaskId: 'cu-task-1' });

      expect(result).toEqual({ id: 'jp-cu-new', created: true });
      const insertCall = mockQuery.mock.calls[2];
      expect(insertCall[1][3]).toBe('CASO 230-9'); // title via formatCaseTitle
      const syncCall = mockQuery.mock.calls[3];
      expect(syncCall[1][0]).toBe('jp-cu-new');
      expect(syncCall[1][1]).toBe('cu-task-1');
    });

    it('case_number não encontrado + title explícito → usa o title dado (não gera via formatCaseTitle)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ vn: '3' }] })
        .mockResolvedValueOnce({ rows: [{ id: 'jp-cu-new2' }] })
        .mockResolvedValueOnce({ rows: [] });

      await repo.upsertFromClickUp({ caseNumber: 230, title: 'Vacante Norte' });

      const insertCall = mockQuery.mock.calls[2];
      expect(insertCall[1][3]).toBe('Vacante Norte');
    });
  });

  // ── findActivePublic() ────────────────────────────────────────────

  describe('findActivePublic', () => {
    it('delega o WHERE a buildPublicJobsWhere e devolve as rows', async () => {
      const rows = [{ id: 'jp-1', case_number: 230 }];
      mockQuery.mockResolvedValueOnce({ rows });

      const result = await repo.findActivePublic({ country: 'AR' });

      expect(result).toBe(rows);
      const call = mockQuery.mock.calls[0];
      expect(call[0]).toContain('FROM job_postings jp');
      expect(call[1]).toEqual(['AR']); // buildPublicJobsWhere: country é o único param aqui
    });
  });

  // ── saveCommentIfNew() ────────────────────────────────────────────

  describe('saveCommentIfNew', () => {
    it('comentário vazio (só espaço) → false, sem tocar o banco', async () => {
      const result = await repo.saveCommentIfNew({
        jobPostingId: 'jp-1',
        commentText: '   ',
        commentCount: 1,
      });

      expect(result).toBe(false);
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('sem comentário anterior (lastRow ausente) → textChanged=true → insere, devolve true', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })    // SELECT último comentário — nenhum
        .mockResolvedValueOnce({ rows: [] });   // INSERT

      const result = await repo.saveCommentIfNew({
        jobPostingId: 'jp-1',
        commentText: 'Primeiro comentário',
        commentCount: 1,
      });

      expect(result).toBe(true);
      expect(mockQuery.mock.calls[1][0]).toContain('INSERT INTO job_posting_comments');
    });

    it('texto igual ao último e contagem não cresceu → false, sem INSERT', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ comment_text: 'Mesmo texto', clickup_comment_count: 5 }],
      });

      const result = await repo.saveCommentIfNew({
        jobPostingId: 'jp-1',
        commentText: 'Mesmo texto',
        commentCount: 5,
      });

      expect(result).toBe(false);
      expect(mockQuery).toHaveBeenCalledTimes(1); // só o SELECT, sem INSERT
    });

    it('texto mudou (mesmo com contagem igual) → true, insere', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ comment_text: 'Texto antigo', clickup_comment_count: 5 }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repo.saveCommentIfNew({
        jobPostingId: 'jp-1',
        commentText: 'Texto novo',
        commentCount: 5,
      });

      expect(result).toBe(true);
    });

    it('texto igual mas contagem cresceu → true, insere (countGrew)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ comment_text: 'Mesmo texto', clickup_comment_count: 5 }] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await repo.saveCommentIfNew({
        jobPostingId: 'jp-1',
        commentText: 'Mesmo texto',
        commentCount: 8,
      });

      expect(result).toBe(true);
    });

    it('commentCount=null (não veio do ClickUp) → countGrew nunca dispara sozinho; texto igual → false', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ comment_text: 'Mesmo texto', clickup_comment_count: 5 }],
      });

      const result = await repo.saveCommentIfNew({
        jobPostingId: 'jp-1',
        commentText: 'Mesmo texto',
        commentCount: null,
      });

      expect(result).toBe(false);
    });

    it('lastRow.clickup_comment_count=null (nunca sincronizado antes) → countGrew não dispara; texto igual → false', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [{ comment_text: 'Mesmo texto', clickup_comment_count: null }],
      });

      const result = await repo.saveCommentIfNew({
        jobPostingId: 'jp-1',
        commentText: 'Mesmo texto',
        commentCount: 3,
      });

      expect(result).toBe(false);
    });

    it('lastRow.clickup_comment_count UNDEFINED (coluna nunca lida, distinto de null) → fallback 0 na comparação; commentCount undefined → INSERT grava null', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [{ comment_text: 'Texto antigo' }] }) // sem clickup_comment_count no row
        .mockResolvedValueOnce({ rows: [] });

      const result = await repo.saveCommentIfNew({
        jobPostingId: 'jp-1',
        commentText: 'Texto novo',
        commentCount: undefined as unknown as number | null,
      });

      expect(result).toBe(true); // textChanged=true garante o INSERT independente do countGrew
      const insertCall = mockQuery.mock.calls[1];
      expect(insertCall[1][2]).toBeNull(); // params.commentCount ?? null
    });
  });
});
