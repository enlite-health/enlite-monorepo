/**
 * CreateJobPostingFromTalentumUseCase.test.ts
 *
 * Cenarios:
 *  1. Vaga criada com sucesso (caminho feliz)
 *  2. Skip silencioso quando talentum_project_id ja existe (anti-loop)
 *  3. Race condition — erro 23505 tratado como skip
 *  4. Titulo gerado como "CASO {caseNumber}-{vacancyNumber}" — case_number extraido de data.name
 *  5. Status SEARCHING e country AR sao sempre usados no INSERT
 *  6. talentum_project_id e talentum_published_at sao salvos no INSERT
 *  7. Erro de DB diferente de 23505 e relancado
 *  8. environment nao e persistido no banco (apenas logging)
 *  9. vacancy_number gerado via SEQUENCE (nao MAX+1)
 * 10. case_number extraido do nome via regex /CASO\s+(\d+)/i
 */

import { Pool } from 'pg';
import {
  CreateJobPostingFromTalentumUseCase,
  CreateJobPostingFromTalentumInput,
} from '../CreateJobPostingFromTalentumUseCase';

// ── Helpers ──────────────────────────────────────────────────────

function makeInput(overrides: Partial<CreateJobPostingFromTalentumInput> = {}): CreateJobPostingFromTalentumInput {
  return {
    _id: overrides._id ?? 'talentum-proj-abc123',
    name: overrides.name ?? 'Nome da Vaga Talentum',
  };
}

function makePool(queryImpl: jest.Mock, clientQueryImpl?: jest.Mock): Pool {
  const clientQuery = clientQueryImpl ?? jest.fn().mockResolvedValue({ rows: [] });
  const connect = jest.fn().mockResolvedValue({
    query: clientQuery,
    release: jest.fn(),
  });
  return { query: queryImpl, connect } as unknown as Pool;
}

// ── Tests ────────────────────────────────────────────────────────

describe('CreateJobPostingFromTalentumUseCase', () => {
  let mockQuery: jest.Mock;
  let mockClientQuery: jest.Mock;

  beforeEach(() => {
    mockQuery = jest.fn();
    // Default client mock: all client queries (BEGIN, INSERT/UPDATE, audit, COMMIT) resolve safely.
    mockClientQuery = jest.fn().mockResolvedValue({ rows: [] });
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Caminho feliz ─────────────────────────────────────────

  describe('criacao com sucesso', () => {
    it('deve criar job_posting e retornar created=true com jobPostingId, caseNumber e vacancyNumber', async () => {
      // Pool: anti-loop SELECT, case_number SELECT, nextval; INSERT on client
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop (not found)
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '42' }] }); // nextval SEQUENCE
      mockClientQuery
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-uuid-1' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                   // audit SAVEPOINT + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ _id: 'proj-new', name: 'CASO 230, AT para paciente' }), 'production');

      expect(result.created).toBe(true);
      expect(result.skipped).toBe(false);
      expect(result.jobPostingId).toBe('jp-uuid-1');
      expect(result.caseNumber).toBe(230);
      expect(result.vacancyNumber).toBe(42);
      expect(result.reason).toBeUndefined();
    });

    it('deve chamar anti-loop SELECT com talentum_project_id correto', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '10' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-x' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                   // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      await useCase.execute(makeInput({ _id: 'my-talentum-id', name: 'CASO 5' }), 'production');

      const selectCall = mockQuery.mock.calls[0];
      expect(selectCall[0]).toContain('WHERE talentum_project_id = $1');
      expect(selectCall[1]).toEqual(['my-talentum-id']);
    });

    it('deve usar nextval SEQUENCE para gerar vacancy_number', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '1' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                            // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-first' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                     // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ name: 'CASO 100' }), 'production');

      expect(result.vacancyNumber).toBe(1);
      expect(result.caseNumber).toBe(100);

      const seqCall = mockQuery.mock.calls[2];
      expect(seqCall[0]).toContain('nextval');
    });
  });

  // ── 2. Anti-loop: skip quando ja existe ─────────────────────

  describe('skip por talentum_project_id existente', () => {
    it('deve retornar skipped=true sem fazer INSERT quando ja existe', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'jp-existing' }] }); // SELECT encontra

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ _id: 'proj-dup' }), 'production');

      expect(result.created).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.jobPostingId).toBe('jp-existing');
      expect(result.reason).toBe('already_exists');

      // Deve executar apenas 1 query (SELECT) e nenhum INSERT
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockClientQuery).not.toHaveBeenCalled(); // connect never called
    });

    it('deve retornar o id do job_posting existente', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'jp-abc-456' }] });

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput(), 'test');

      expect(result.jobPostingId).toBe('jp-abc-456');
    });
  });

  // ── 3. Race condition (23505) ────────────────────────────────

  describe('race condition — unique violation 23505', () => {
    it('deve tratar 23505 como skip e buscar o id inserido concorrentemente', async () => {
      const pgError = Object.assign(new Error('duplicate key value'), { code: '23505' });

      // Pool: anti-loop, case_number lookup, nextval, recovery SELECT (after 23505)
      // Client: BEGIN, INSERT (throws 23505), ROLLBACK
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop (not found)
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '5' }] }) // nextval SEQUENCE
        .mockResolvedValueOnce({ rows: [{ id: 'jp-race-winner' }] }); // SELECT de recuperacao (pool)
      mockClientQuery
        .mockResolvedValueOnce({})                    // BEGIN
        .mockRejectedValueOnce(pgError)               // INSERT — race condition → 23505
        .mockResolvedValueOnce({});                   // ROLLBACK (inside catch)

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ _id: 'proj-race', name: 'CASO 10' }), 'production');

      expect(result.created).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('race_condition');
      expect(result.jobPostingId).toBe('jp-race-winner');
    });

    it('deve retornar jobPostingId undefined quando recovery SELECT não encontra rows', async () => {
      const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });

      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '5' }] }) // nextval
        .mockResolvedValueOnce({ rows: [] });         // SELECT recovery — no rows
      mockClientQuery
        .mockResolvedValueOnce({})                    // BEGIN
        .mockRejectedValueOnce(pgError)               // INSERT race
        .mockResolvedValueOnce({});                   // ROLLBACK

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ _id: 'proj-ghost', name: 'CASO 10' }), 'production');

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('race_condition');
      expect(result.jobPostingId).toBeUndefined();
    });

    it('deve fazer SELECT de recuperacao com o mesmo talentum_project_id', async () => {
      const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });

      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '3' }] }) // nextval
        .mockResolvedValueOnce({ rows: [{ id: 'jp-recovered' }] }); // SELECT de recuperacao
      mockClientQuery
        .mockResolvedValueOnce({})                    // BEGIN
        .mockRejectedValueOnce(pgError)               // INSERT → 23505
        .mockResolvedValueOnce({});                   // ROLLBACK

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      await useCase.execute(makeInput({ _id: 'proj-race-id', name: 'CASO 20' }), 'production');

      // Recovery SELECT is now pool calls[3] (anti-loop=0, case_num=1, nextval=2, recovery=3)
      const recoveryCall = mockQuery.mock.calls[3];
      expect(recoveryCall[0]).toContain('WHERE talentum_project_id = $1');
      expect(recoveryCall[1]).toEqual(['proj-race-id']);
    });
  });

  // ── 4. Titulo gerado corretamente ────────────────────────────

  describe('titulo CASO {caseNumber}-{vacancyNumber}', () => {
    it('deve extrair case_number de data.name e gerar titulo com vacancy_number', async () => {
      // Pool: anti-loop, case_number SELECT, nextval; INSERT on client
      mockQuery
        .mockResolvedValueOnce({ rows: [] })           // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })           // SELECT por case_number (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '99' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-99' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                   // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      await useCase.execute(
        makeInput({ _id: 'proj-99', name: 'CASO 230, AT para paciente complexo' }),
        'production',
      );

      // INSERT is on clientQuery (index 1 = after BEGIN)
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const insertParams = insertCall![1] as unknown[];

      // vacancy_number = 99, case_number = 230, title = 'CASO 230-99'
      expect(insertParams[0]).toBe(99);    // vacancy_number
      expect(insertParams[1]).toBe(230);   // case_number
      expect(insertParams[2]).toBe('CASO 230-99'); // title
    });

    it('deve gerar titulo "CASO EN{caseNumber}-{vacancyNumber}" para case_number nativo (>=1000, migration 459)', async () => {
      // Pool: anti-loop, case_number SELECT, nextval; INSERT on client
      mockQuery
        .mockResolvedValueOnce({ rows: [] })           // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })           // SELECT por case_number (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '1500' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1000' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                   // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      await useCase.execute(
        makeInput({ _id: 'proj-1000', name: 'CASO 1000, AT para paciente complexo' }),
        'production',
      );

      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const insertParams = insertCall![1] as unknown[];

      expect(insertParams[0]).toBe(1500);   // vacancy_number
      expect(insertParams[1]).toBe(1000);   // case_number
      expect(insertParams[2]).toBe('CASO EN1000-1500'); // title
    });

    it('deve gerar titulo "VACANTE {vacancyNumber}" quando case_number nao encontrado no nome', async () => {
      // No case_number in name → no case_number lookup; only anti-loop + nextval on pool
      mockQuery
        .mockResolvedValueOnce({ rows: [] })            // SELECT anti-loop (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '50' }] }); // nextval (no case_number/vacancy_number match)
      mockClientQuery
        .mockResolvedValueOnce({})                            // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-50' }] })  // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                     // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      await useCase.execute(
        makeInput({ _id: 'proj-no-case', name: 'Vaga sem numero de caso' }),
        'production',
      );

      // INSERT is on clientQuery
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const insertParams = insertCall![1] as unknown[];

      expect(insertParams[0]).toBe(50);    // vacancy_number
      expect(insertParams[1]).toBeNull();  // case_number (not found)
      expect(insertParams[2]).toBe('VACANTE 50'); // title
    });
  });

  // ── 5. Status e country fixos ────────────────────────────────

  describe('status SEARCHING e country AR', () => {
    it('deve sempre inserir com status SEARCHING e country AR', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '7' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-7' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                   // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      await useCase.execute(makeInput({ name: 'CASO 7' }), 'production');

      // INSERT is on clientQuery — check SQL contains literals
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const sql = insertCall![0] as string;

      expect(sql).toContain("'SEARCHING'");
      expect(sql).toContain("'AR'");
    });
  });

  // ── 6. talentum_project_id e talentum_published_at no INSERT ─

  describe('referencia Talentum no INSERT', () => {
    it('deve salvar talentum_project_id no INSERT', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '15' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                            // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-15' }] })  // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                     // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      await useCase.execute(makeInput({ _id: 'talentum-xyz', name: 'CASO 15' }), 'production');

      // INSERT is on clientQuery
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const sql = insertCall![0] as string;
      const params = insertCall![1] as unknown[];

      expect(sql).toContain('talentum_project_id');
      expect(sql).toContain('talentum_published_at');
      expect(params).toContain('talentum-xyz');
    });

    it('deve usar NOW() para talentum_published_at (sem parametro explicito)', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '20' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                            // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-20' }] })  // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                     // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      await useCase.execute(makeInput({ name: 'CASO 20' }), 'production');

      // INSERT is on clientQuery — talentum_published_at deve ser NOW() no SQL
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      expect(insertCall![0] as string).toContain('NOW()');
    });
  });

  // ── 6b. Link de vacante existente por vacancy_number ─────────

  describe('link de vacante existente (CASO XXX-YY)', () => {
    it('deve vincular vacante existente por vacancy_number quando nome é "CASO 230-42"', async () => {
      // Pool: anti-loop SELECT (not found), SELECT by vacancy_number (found)
      // Client: BEGIN + UPDATE talentum_project_id + audit + COMMIT
      mockQuery
        .mockResolvedValueOnce({ rows: [] })               // SELECT anti-loop (não existe)
        .mockResolvedValueOnce({ rows: [{ id: 'jp-existing', vacancy_number: 42 }] }); // SELECT vacancy_number=42
      mockClientQuery
        .mockResolvedValueOnce({})                         // BEGIN
        .mockResolvedValueOnce({ rows: [] })               // UPDATE talentum_project_id
        .mockResolvedValue({ rows: [] });                  // audit SAVEPOINT + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ _id: 'proj-link', name: 'CASO 230-42' }), 'production');

      expect(result.created).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe('linked_existing');
      expect(result.jobPostingId).toBe('jp-existing');
      expect(result.caseNumber).toBe(230);
      expect(result.vacancyNumber).toBe(42);

      // UPDATE is now on clientQuery (index 1 = after BEGIN)
      const updateCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('UPDATE job_postings'),
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![0]).toContain('UPDATE job_postings');
      expect(updateCall![1]).toEqual(['proj-link', 'jp-existing']);
    });

    it('deve vincular vacante existente por case_number quando nome é "CASO 230" (sem vacancy_number)', async () => {
      // Pool: anti-loop (not found), SELECT by case_number (found)
      // Client: BEGIN + UPDATE + audit + COMMIT
      mockQuery
        .mockResolvedValueOnce({ rows: [] })               // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [{ id: 'jp-by-case', vacancy_number: 10 }] }); // SELECT case_number=230
      mockClientQuery
        .mockResolvedValueOnce({})                         // BEGIN
        .mockResolvedValueOnce({ rows: [] })               // UPDATE
        .mockResolvedValue({ rows: [] });                  // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ _id: 'proj-link2', name: 'CASO 230' }), 'production');

      expect(result.created).toBe(false);
      expect(result.skipped).toBe(false);
      expect(result.reason).toBe('linked_existing');
      expect(result.jobPostingId).toBe('jp-by-case');
      expect(result.vacancyNumber).toBe(10);
    });

    it('deve dar ROLLBACK e propagar o erro se o UPDATE de link falhar (transação de link não é best-effort)', async () => {
      const updateError = new Error('connection lost');

      mockQuery
        .mockResolvedValueOnce({ rows: [] })               // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [{ id: 'jp-existing', vacancy_number: 42 }] }); // SELECT vacancy_number=42
      mockClientQuery
        .mockResolvedValueOnce({})                         // BEGIN
        .mockRejectedValueOnce(updateError)                 // UPDATE job_postings — falha
        .mockResolvedValueOnce({});                         // ROLLBACK (inside catch)

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));

      await expect(
        useCase.execute(makeInput({ _id: 'proj-link-fail', name: 'CASO 230-42' }), 'production'),
      ).rejects.toThrow('connection lost');

      const rollbackCall = mockClientQuery.mock.calls.find((c: unknown[]) => c[0] === 'ROLLBACK');
      expect(rollbackCall).toBeDefined();
    });

    it('deve criar nova vacante quando vacancy_number não encontra match', async () => {
      // Pool: anti-loop, SELECT by vacancy_number (not found), nextval; INSERT on client
      mockQuery
        .mockResolvedValueOnce({ rows: [] })               // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })               // SELECT por vacancy_number=999 (não encontra)
        .mockResolvedValueOnce({ rows: [{ vn: '60' }] }); // nextval SEQUENCE
      mockClientQuery
        .mockResolvedValueOnce({})                           // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-new' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                    // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ name: 'CASO 230-999' }), 'production');

      expect(result.created).toBe(true);
      expect(result.vacancyNumber).toBe(60);
    });
  });

  // ── 7. Erro de DB nao-23505 e relancado ─────────────────────

  describe('erros inesperados de banco', () => {
    it('deve relancar erros de DB que nao sao unique_violation', async () => {
      const dbError = Object.assign(new Error('connection refused'), { code: '08006' });

      // Pool: anti-loop, case_number lookup, nextval; INSERT on client throws non-23505
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '50' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                    // BEGIN
        .mockRejectedValueOnce(dbError)               // INSERT → non-23505 error
        .mockResolvedValueOnce({});                   // ROLLBACK (in catch)

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));

      await expect(
        useCase.execute(makeInput({ name: 'CASO 50' }), 'production'),
      ).rejects.toThrow('connection refused');
    });

    it('deve relancar erro sem code (nao e erro Postgres)', async () => {
      const genericError = new Error('network error');

      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '50' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                    // BEGIN
        .mockRejectedValueOnce(genericError)          // INSERT → generic error
        .mockResolvedValueOnce({});                   // ROLLBACK (in catch)

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));

      await expect(
        useCase.execute(makeInput({ name: 'CASO 50' }), 'production'),
      ).rejects.toThrow('network error');
    });
  });

  // ── 8. environment nao persistido ───────────────────────────

  describe('environment nao persistido', () => {
    it('deve aceitar environment sem salva-lo no banco', async () => {
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
        .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '30' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                            // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-30' }] })  // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                     // audit + COMMIT

      const useCase = new CreateJobPostingFromTalentumUseCase(makePool(mockQuery, mockClientQuery));
      const result = await useCase.execute(makeInput({ name: 'CASO 30' }), 'test');

      expect(result.created).toBe(true);

      // INSERT is on clientQuery — environment 'test' nao deve aparecer como parametro
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const params = insertCall![1] as unknown[];
      expect(params).not.toContain('test');
    });

    it('deve funcionar igualmente com environment=production e environment=test', async () => {
      const runWith = async (environment: string) => {
        const q = jest.fn()
          .mockResolvedValueOnce({ rows: [] })          // SELECT anti-loop
          .mockResolvedValueOnce({ rows: [] })          // SELECT por case_number
          .mockResolvedValueOnce({ rows: [{ vn: '1' }] }); // nextval
        const cq = jest.fn()
          .mockResolvedValueOnce({})                            // BEGIN
          .mockResolvedValueOnce({ rows: [{ id: 'jp-env' }] }) // INSERT RETURNING id
          .mockResolvedValue({ rows: [] });                     // audit + COMMIT
        return new CreateJobPostingFromTalentumUseCase(makePool(q, cq)).execute(makeInput({ name: 'CASO 1' }), environment);
      };

      const [prodResult, testResult] = await Promise.all([
        runWith('production'),
        runWith('test'),
      ]);

      expect(prodResult.created).toBe(true);
      expect(testResult.created).toBe(true);
    });
  });
});
