/**
 * SyncTalentumVacanciesUseCase.test.ts
 *
 * Cobertura do use case de sync Talentum → Enlite (sem Gemini).
 *
 * Cenarios:
 *  1. Sync com vacante existente (update reference only)
 *  2. Sync com vacante nova (create)
 *  3. Titulo sem case_number
 *  4. Erro individual nao aborta sync dos demais
 *  5. Multiplos projects
 *  6. Salva referencia Talentum apos create/update
 *  7. Report retorna totais corretos
 *  8. Sync questions e FAQ
 */

// ── Mocks (antes dos imports) ────────────────────────────────────

const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({
  query: mockClientQuery,
  release: mockClientRelease,
});

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
        connect: mockConnect,
      }),
    }),
  },
}));

const mockListAllPrescreenings = jest.fn();
const mockGetPrescreening = jest.fn();
jest.mock('../../infrastructure/TalentumApiClient', () => ({
  TalentumApiClient: {
    create: jest.fn().mockResolvedValue({
      listAllPrescreenings: mockListAllPrescreenings,
      getPrescreening: mockGetPrescreening,
    }),
  },
}));

// ── Imports ──────────────────────────────────────────────────────

import { SyncTalentumVacanciesUseCase, SyncReport } from '../SyncTalentumVacanciesUseCase';
import type { TalentumProject } from '../../domain/ITalentumApiClient';

// ── Helpers ──────────────────────────────────────────────────────

function makeTalentumProject(overrides: Partial<TalentumProject> = {}): TalentumProject {
  return {
    projectId: overrides.projectId ?? 'proj-1',
    publicId: overrides.publicId ?? 'pub-1',
    title: overrides.title ?? 'CASO 42 - AT Recoleta',
    description: overrides.description ?? 'Descripcion de la Propuesta: paciente adulto...',
    whatsappUrl: overrides.whatsappUrl ?? 'https://wa.me/talentum/proj-1',
    slug: overrides.slug ?? 'caso-42-at-recoleta',
    active: overrides.active ?? true,
    timestamp: overrides.timestamp ?? '2025-01-15T10:00:00Z',
    questions: overrides.questions ?? [
      { questionId: 'q1', question: 'Tiene experiencia?', type: 'text' as const, responseType: ['text' as const], desiredResponse: 'Si', weight: 5, required: false, analyzed: true, earlyStoppage: false },
    ],
    faq: overrides.faq ?? [
      { question: 'Cual es el horario?', answer: 'Lunes a viernes 9 a 17' },
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('SyncTalentumVacanciesUseCase', () => {
  let useCase: SyncTalentumVacanciesUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    mockQuery.mockResolvedValue({ rows: [] });
    // Default: client queries (BEGIN, INSERT/UPDATE, audit SAVEPOINT, COMMIT) resolve safely.
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockClientRelease });
    useCase = new SyncTalentumVacanciesUseCase();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Sync com vacante existente ────────────────────────────

  describe('update vacante existente', () => {
    it('deve atualizar referencia quando talentum_project_id ja existe no DB (com force=true)', async () => {
      const project = makeTalentumProject({ projectId: 'proj-exist', title: 'CASO 10 - AT' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      // Pool: SELECT talentum_project_id (found) + syncQuestions + syncFaq pool queries
      // saveTalentumReference UPDATE now runs on client
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'jp-existing-1', talentum_project_id: 'proj-exist' }] }) // lookup
        .mockResolvedValueOnce({ rows: [] }) // DELETE questions
        .mockResolvedValueOnce({ rows: [] }) // INSERT question
        .mockResolvedValueOnce({ rows: [] }) // DELETE faq
        .mockResolvedValueOnce({ rows: [] }); // INSERT faq
      // saveTalentumReference: BEGIN + UPDATE + logEventSafe (wasCreated=false audit) + COMMIT → all on client

      const report = await useCase.execute({ force: true });

      expect(report.updated).toBe(1);
      expect(report.created).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.errors).toHaveLength(0);
      expect(report.total).toBe(1);
    });

    it('deve skip sem chamar Gemini quando ja synced e force=false', async () => {
      const project = makeTalentumProject({ projectId: 'proj-exist', title: 'CASO 10' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'jp-1', talentum_project_id: 'proj-exist' }] });

      const report = await useCase.execute({ force: false });

      expect(report.skipped).toBe(1);
      expect(report.updated).toBe(0);
      expect(report.created).toBe(0);
    });

    it('deve dar ROLLBACK e registrar o erro no report se o UPDATE de saveTalentumReference falhar (não é best-effort)', async () => {
      const project = makeTalentumProject({ projectId: 'proj-ref-fail', title: 'CASO 400' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      // Achado por talentum_project_id, mas com projectId DIFERENTE do atual — não é skip.
      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'jp-ref-fail', talentum_project_id: 'other-proj' }] });
      mockClientQuery
        .mockResolvedValueOnce({})                              // BEGIN (saveTalentumReference)
        .mockRejectedValueOnce(new Error('update ref failed'))  // UPDATE job_postings — falha
        .mockResolvedValueOnce({});                              // ROLLBACK

      const report = await useCase.execute();

      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toEqual({
        projectId: 'proj-ref-fail',
        title: 'CASO 400',
        error: 'update ref failed',
      });
      const rollbackCall = mockClientQuery.mock.calls.find((c: unknown[]) => c[0] === 'ROLLBACK');
      expect(rollbackCall).toBeDefined();
    });
  });

  // ── 2. Sync com vacante nova ─────────────────────────────────

  describe('criar vacante nova', () => {
    it('deve criar vacancy quando talentum_project_id nao existe no DB', async () => {
      const project = makeTalentumProject({ projectId: 'proj-new', title: 'CASO 100' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      // Pool: SELECT talentum_project_id, SELECT case_number, SELECT nextval, syncQuestions/syncFaq
      // INSERT is now on client (createFromSync), saveTalentumReference UPDATE also on client
      mockQuery
        .mockResolvedValueOnce({ rows: [] })    // lookup por talentum_project_id (not found)
        .mockResolvedValueOnce({ rows: [] })    // lookup por case_number (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '42' }] }) // nextval
        .mockResolvedValueOnce({ rows: [] })    // DELETE questions (syncQuestions)
        .mockResolvedValueOnce({ rows: [] })    // INSERT question (syncQuestions)
        .mockResolvedValueOnce({ rows: [] })    // DELETE faq (syncFaq)
        .mockResolvedValueOnce({ rows: [] });   // INSERT faq (syncFaq)
      // client handles: BEGIN + INSERT RETURNING id + logEventSafe + COMMIT (createFromSync)
      mockClientQuery
        .mockResolvedValueOnce({})                          // BEGIN (createFromSync)
        .mockResolvedValueOnce({ rows: [{ id: 'jp-new-100' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                   // audit + COMMIT + saveTalentumReference txn

      const report = await useCase.execute();

      expect(report.created).toBe(1);
      expect(report.updated).toBe(0);
    });

    it('deve inserir com status SEARCHING e country AR', async () => {
      const project = makeTalentumProject({ title: 'CASO 200' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })    // lookup por talentum_project_id
        .mockResolvedValueOnce({ rows: [] })    // lookup por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '10' }] }); // nextval
      // INSERT now on client
      mockClientQuery
        .mockResolvedValueOnce({})                       // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-200' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                // audit + COMMIT + saveTalentumReference txn

      await useCase.execute();

      // INSERT is on clientQuery (index 1 = after BEGIN)
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const sql = insertCall![0] as string;
      expect(sql).toContain("'AR'");
      expect(sql).toContain("'SEARCHING'");
    });

    it('deve gerar titulo "CASO {caseNumber}-{vacancyNumber}" no INSERT', async () => {
      const project = makeTalentumProject({ title: 'CASO 55' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })    // lookup por talentum_project_id
        .mockResolvedValueOnce({ rows: [] })    // lookup por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '99' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                       // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-55' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                // audit + COMMIT + saveTalentumReference txn

      await useCase.execute();

      // INSERT is on clientQuery
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const insertParams = insertCall![1] as unknown[];
      expect(insertParams[0]).toBe(99);       // vacancy_number
      expect(insertParams[1]).toBe(55);       // case_number
      expect(insertParams[2]).toBe('CASO 55-99'); // title
    });

    it('deve buscar por vacancy_number quando titulo é "CASO N-M" e talentum_project_id não bate (link com vacante do novo esquema)', async () => {
      const project = makeTalentumProject({ projectId: 'proj-new-src', title: 'CASO 230-42' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })  // lookup por talentum_project_id (not found)
        .mockResolvedValueOnce({ rows: [{ id: 'jp-v42', talentum_project_id: null }] }); // lookup por vacancy_number=42 (found)

      const report = await useCase.execute();

      expect(report.updated).toBe(1);
      expect(report.created).toBe(0);
      expect(report.errors).toHaveLength(0);

      const vacancyLookupCall = mockQuery.mock.calls[1];
      expect(vacancyLookupCall[0]).toContain('vacancy_number = $1');
      expect(vacancyLookupCall[1]).toEqual([42]);
    });

    it('não encontra por vacancy_number ("CASO N-M" sem vacante correspondente) → cai no lookup por case_number e cria nova', async () => {
      const project = makeTalentumProject({ projectId: 'proj-vac-miss', title: 'CASO 600-15' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })              // lookup por talentum_project_id
        .mockResolvedValueOnce({ rows: [] })              // lookup por vacancy_number=15 (not found)
        .mockResolvedValueOnce({ rows: [] })              // lookup por case_number=600 (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '16' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                          // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-600' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                   // audit + COMMIT + saveTalentumReference txn

      const report = await useCase.execute();

      expect(report.created).toBe(1);
      const vacancyLookupCall = mockQuery.mock.calls[1];
      expect(vacancyLookupCall[1]).toEqual([15]);
      const caseLookupCall = mockQuery.mock.calls[2];
      expect(caseLookupCall[1]).toEqual([600]);
    });

    it('deve dar ROLLBACK e registrar o erro no report se o INSERT de createFromSync falhar (create não é best-effort)', async () => {
      const project = makeTalentumProject({ projectId: 'proj-create-fail', title: 'CASO 300' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })              // lookup por talentum_project_id
        .mockResolvedValueOnce({ rows: [] })              // lookup por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '77' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                              // BEGIN (createFromSync)
        .mockRejectedValueOnce(new Error('insert failed'))      // INSERT RETURNING id — falha
        .mockResolvedValueOnce({});                              // ROLLBACK

      const report = await useCase.execute();

      expect(report.errors).toHaveLength(1);
      expect(report.errors[0]).toEqual({
        projectId: 'proj-create-fail',
        title: 'CASO 300',
        error: 'insert failed',
      });
      const rollbackCall = mockClientQuery.mock.calls.find((c: unknown[]) => c[0] === 'ROLLBACK');
      expect(rollbackCall).toBeDefined();
    });
  });

  // ── 3. Titulo sem case_number ────────────────────────────────

  describe('titulo sem case_number', () => {
    it('deve criar vacancy com case_number=null quando titulo nao tem CASO', async () => {
      const project = makeTalentumProject({
        projectId: 'proj-generic',
        title: 'Proyecto generico sin numero',
      });
      mockListAllPrescreenings.mockResolvedValue([project]);

      // Sem case_number → só lookup talentum_project_id (sem lookup case_number)
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // lookup por talentum_project_id (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '5' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                       // BEGIN (createFromSync)
        .mockResolvedValueOnce({ rows: [{ id: 'jp-generic' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                // audit + COMMIT + saveTalentumReference txn

      const report = await useCase.execute();

      expect(report.created).toBe(1);
      expect(report.skipped).toBe(0);

      // INSERT is on clientQuery — case_number=null e titulo "VACANTE {vn}"
      const insertCall = mockClientQuery.mock.calls.find(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('INSERT INTO job_postings'),
      );
      expect(insertCall).toBeDefined();
      const insertParams = insertCall![1] as unknown[];
      expect(insertParams[1]).toBeNull();        // case_number
      expect(insertParams[2]).toBe('VACANTE 5'); // title
    });

    it('deve aceitar CASO case-insensitive', async () => {
      const project = makeTalentumProject({ title: 'caso 88 - AT' });
      mockListAllPrescreenings.mockResolvedValue([project]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })    // lookup por talentum_project_id
        .mockResolvedValueOnce({ rows: [] })    // lookup por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '20' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                       // BEGIN
        .mockResolvedValueOnce({ rows: [{ id: 'jp-88' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                // audit + COMMIT + saveTalentumReference txn

      const report = await useCase.execute();

      expect(report.created).toBe(1);
    });
  });

  // ── 4. Resiliencia a erros individuais ──────────────────────

  describe('resiliencia a erros individuais', () => {
    it('deve continuar sync quando um project falha', async () => {
      const projects = [
        makeTalentumProject({ projectId: 'proj-fail', title: 'CASO 1' }),
        makeTalentumProject({ projectId: 'proj-ok', title: 'CASO 2' }),
      ];
      mockListAllPrescreenings.mockResolvedValue(projects);

      // proj-fail: lookup (not found) → case_number lookup (not found) → nextval fails
      // proj-ok:   lookup (not found) → case_number lookup (not found) → nextval ok
      mockQuery
        .mockResolvedValueOnce({ rows: [] })              // proj-fail: SELECT talentum_project_id
        .mockResolvedValueOnce({ rows: [] })              // proj-fail: SELECT case_number
        .mockRejectedValueOnce(new Error('DB connection lost')) // proj-fail: nextval → error
        .mockResolvedValueOnce({ rows: [] })              // proj-ok:   SELECT talentum_project_id
        .mockResolvedValueOnce({ rows: [] })              // proj-ok:   SELECT case_number
        .mockResolvedValueOnce({ rows: [{ vn: '1' }] })  // proj-ok:   nextval
        // proj-ok: syncQuestions/syncFaq (default mockResolvedValue handles these)
        ;
      mockClientQuery
        .mockResolvedValueOnce({})                          // BEGIN (proj-ok createFromSync)
        .mockResolvedValueOnce({ rows: [{ id: 'jp-new-2' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                   // audit + COMMIT + saveTalentumReference txn

      const report = await useCase.execute();

      expect(report.total).toBe(2);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].projectId).toBe('proj-fail');
    });

    it('deve registrar projectId e title no erro', async () => {
      const project = makeTalentumProject({
        projectId: 'proj-x',
        title: 'CASO 77 - fallido',
      });
      mockListAllPrescreenings.mockResolvedValue([project]);

      mockQuery
        .mockResolvedValueOnce({ rows: [] })  // lookup por talentum_project_id (not found)
        .mockResolvedValueOnce({ rows: [] })  // lookup por case_number (not found)
        .mockRejectedValueOnce(new Error('timeout')); // nextval fails

      const report = await useCase.execute();

      expect(report.errors[0]).toEqual({
        projectId: 'proj-x',
        title: 'CASO 77 - fallido',
        error: 'timeout',
      });
    });
  });

  // ── 4b. Parametro `force` default (processProject) ──────────
  //
  // `execute()` sempre encaminha `force` já resolvido (`opts?.force ?? false`),
  // então o valor DEFAULT do parâmetro de `processProject` nunca é exercitado
  // pela API pública — chamada direta ao método privado é o único jeito de
  // cobrir esse branch (cobertura 100% do ARQUIVO, não só do caminho público).
  describe('parametro force default de processProject (branch não alcançável via execute())', () => {
    it('chamada sem 4º argumento (force) trata como false — já synced é skip', async () => {
      const project = makeTalentumProject({ projectId: 'proj-force-default', title: 'CASO 500' });
      const report: SyncReport = { total: 0, updated: 0, created: 0, skipped: 0, errors: [] };

      mockQuery
        .mockResolvedValueOnce({ rows: [{ id: 'jp-500', talentum_project_id: 'proj-force-default' }] }); // já synced

      // needsDetail=false (project tem description+questions) → talentumClient nunca é usado.
      await (useCase as any).processProject(project, {} as never, report);

      expect(report.skipped).toBe(1);
      expect(report.updated).toBe(0);
      expect(report.created).toBe(0);
    });
  });

  // ── 5. Multiplos projects ───────────────────────────────────

  describe('multiplos projects', () => {
    it('deve processar todos os projects', async () => {
      const projects = [
        makeTalentumProject({ projectId: 'p1', title: 'CASO 1' }),
        makeTalentumProject({ projectId: 'p2', title: 'CASO 2' }),
        makeTalentumProject({ projectId: 'p3', title: 'CASO 3' }),
      ];
      mockListAllPrescreenings.mockResolvedValue(projects);

      // Pool: each project: SELECT talentum_project_id, SELECT case_number, nextval
      // INSERT is on client (createFromSync); syncQuestions/syncFaq use pool (default resolves)
      mockQuery.mockImplementation((sql: string) => {
        if (sql.includes('SELECT') && sql.includes('talentum_project_id')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('nextval')) return Promise.resolve({ rows: [{ vn: '1' }] });
        // SELECT case_number and any other pool queries
        return Promise.resolve({ rows: [] });
      });
      // Use mockImplementation on client to return the correct RETURNING row for INSERT,
      // and safe defaults for everything else (BEGIN, SAVEPOINT, audit, RELEASE, COMMIT, UPDATE).
      let insertCounter = 0;
      mockClientQuery.mockImplementation((sql: unknown) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO job_postings')) {
          insertCounter++;
          return Promise.resolve({ rows: [{ id: `jp-${insertCounter}` }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const report = await useCase.execute();

      expect(report.total).toBe(3);
      expect(report.created).toBe(3);
    });

    it('deve retornar total=0 quando nao ha projects', async () => {
      mockListAllPrescreenings.mockResolvedValue([]);

      const report = await useCase.execute();

      expect(report.total).toBe(0);
      expect(report.updated).toBe(0);
      expect(report.created).toBe(0);
      expect(report.skipped).toBe(0);
      expect(report.errors).toHaveLength(0);
    });
  });

  // ── 6. Salva referencia Talentum ─────────────────────────────

  describe('saveTalentumReference', () => {
    it('deve salvar projectId, publicId, whatsappUrl, slug, timestamp e description', async () => {
      const project = makeTalentumProject({
        projectId: 'proj-ref',
        publicId: 'pub-ref',
        title: 'CASO 60',
        description: 'Descripcion completa...',
        whatsappUrl: 'https://wa.me/ref',
        slug: 'caso-60-ref',
        timestamp: '2025-06-01T12:00:00Z',
      });
      mockListAllPrescreenings.mockResolvedValue([project]);

      // Pool: lookup talentum_project_id (not found), lookup case_number (not found), nextval
      // INSERT + saveTalentumReference UPDATE + audits are now all on client
      mockQuery
        .mockResolvedValueOnce({ rows: [] })              // lookup por talentum_project_id (not found)
        .mockResolvedValueOnce({ rows: [] })              // lookup por case_number (not found)
        .mockResolvedValueOnce({ rows: [{ vn: '30' }] }); // nextval
      mockClientQuery.mockImplementation((sql: unknown) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO job_postings')) {
          return Promise.resolve({ rows: [{ id: 'jp-60' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await useCase.execute();

      // saveTalentumReference UPDATE runs on client, not pool
      const refCall = mockClientQuery.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('SET talentum_project_id'),
      );
      expect(refCall).toBeDefined();
      const refParams = refCall![1] as unknown[];

      expect(refParams[0]).toBe('proj-ref');
      expect(refParams[1]).toBe('pub-ref');
      expect(refParams[2]).toBe('https://wa.me/ref');
      expect(refParams[3]).toBe('caso-60-ref');
      expect(refParams[4]).toBe('2025-06-01T12:00:00Z');
      expect(refParams[5]).toBe('Descripcion completa...');
      expect(refParams[6]).toBe('jp-60');
    });
  });

  // ── 7. Report completo ───────────────────────────────────────

  describe('relatorio final', () => {
    it('deve retornar skipped quando talentum_project_id ja synced (sem force)', async () => {
      const projects = [
        makeTalentumProject({ projectId: 'p-skip', title: 'CASO 1' }),
        makeTalentumProject({ projectId: 'p-create', title: 'CASO 2' }),
      ];
      mockListAllPrescreenings.mockResolvedValue(projects);

      // Pool: p-skip lookup (found=skip), p-create lookup (not found), case_number lookup, nextval
      // INSERT + saveTalentumReference are on client
      mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT') && sql.includes('talentum_project_id') && params?.[0] === 'p-skip') {
          return Promise.resolve({ rows: [{ id: 'jp-1', talentum_project_id: 'p-skip' }] });
        }
        if (sql.includes('SELECT') && sql.includes('talentum_project_id')) {
          return Promise.resolve({ rows: [] }); // p-create: not found
        }
        if (sql.includes('nextval')) return Promise.resolve({ rows: [{ vn: '1' }] });
        return Promise.resolve({ rows: [] }); // SELECT case_number, syncQuestions/FAQ pool queries
      });
      // Client: any INSERT RETURNING returns jp-new; all other calls safe (BEGIN, SAVEPOINT, etc.)
      mockClientQuery.mockImplementation((sql: unknown) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO job_postings')) {
          return Promise.resolve({ rows: [{ id: 'jp-new' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const report = await useCase.execute();

      expect(report.total).toBe(2);
      expect(report.skipped).toBe(1);
      expect(report.created).toBe(1);
      expect(report.updated).toBe(0);
    });

    it('deve retornar updated quando force=true e talentum_project_id ja synced', async () => {
      const projects = [
        makeTalentumProject({ projectId: 'p-update', title: 'CASO 1' }),
        makeTalentumProject({ projectId: 'p-create', title: 'CASO 2' }),
      ];
      mockListAllPrescreenings.mockResolvedValue(projects);

      // Pool: p-update lookup (found=update path), p-create lookup (not found), case_number, nextval
      // All INSERT + UPDATE saveTalentumReference are on client
      mockQuery.mockImplementation((sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT') && sql.includes('talentum_project_id') && params?.[0] === 'p-update') {
          return Promise.resolve({ rows: [{ id: 'jp-1', talentum_project_id: 'p-update' }] });
        }
        if (sql.includes('SELECT') && sql.includes('talentum_project_id')) {
          return Promise.resolve({ rows: [] }); // p-create: not found
        }
        if (sql.includes('nextval')) return Promise.resolve({ rows: [{ vn: '1' }] });
        return Promise.resolve({ rows: [] }); // SELECT case_number, syncQuestions/FAQ pool queries
      });
      // Client: any INSERT RETURNING returns jp-new; all other calls safe
      mockClientQuery.mockImplementation((sql: unknown) => {
        if (typeof sql === 'string' && sql.includes('INSERT INTO job_postings')) {
          return Promise.resolve({ rows: [{ id: 'jp-new' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const report = await useCase.execute({ force: true });

      expect(report.total).toBe(2);
      expect(report.updated).toBe(1);
      expect(report.created).toBe(1);
      expect(report.skipped).toBe(0);
    });
  });

  // ── 8. Sync questions e FAQ ─────────────────────────────────

  describe('sync questions e FAQ', () => {
    it('deve sincronizar questions e FAQ da Talentum', async () => {
      const project = makeTalentumProject({
        projectId: 'proj-q',
        title: 'CASO 10',
        questions: [
          { questionId: 'q1', question: 'Pregunta 1?', type: 'text' as const, responseType: ['text' as const], desiredResponse: 'Si', weight: 5, required: true, analyzed: true, earlyStoppage: false },
          { questionId: 'q2', question: 'Pregunta 2?', type: 'text' as const, responseType: ['audio' as const], desiredResponse: 'No', weight: 3, required: false, analyzed: false, earlyStoppage: true },
        ],
        faq: [
          { question: 'FAQ 1?', answer: 'Respuesta 1' },
        ],
      });
      mockListAllPrescreenings.mockResolvedValue([project]);

      // Pool: lookup talentum_project_id, lookup case_number, nextval
      // + syncQuestions/FAQ (DELETE+INSERT) still use pool
      // INSERT job_posting + saveTalentumReference UPDATE are on client
      mockQuery
        .mockResolvedValueOnce({ rows: [] })         // lookup por talentum_project_id
        .mockResolvedValueOnce({ rows: [] })         // lookup por case_number
        .mockResolvedValueOnce({ rows: [{ vn: '1' }] }) // nextval
        .mockResolvedValueOnce({ rows: [] })         // DELETE questions (syncQuestions)
        .mockResolvedValueOnce({ rows: [] })         // INSERT question 1 (syncQuestions)
        .mockResolvedValueOnce({ rows: [] })         // INSERT question 2 (syncQuestions)
        .mockResolvedValueOnce({ rows: [] })         // DELETE faq (syncFaq)
        .mockResolvedValueOnce({ rows: [] });        // INSERT faq 1 (syncFaq)
      mockClientQuery
        .mockResolvedValueOnce({})                              // BEGIN (createFromSync)
        .mockResolvedValueOnce({ rows: [{ id: 'jp-q' }] })     // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                       // audit + COMMIT + saveTalentumReference txn

      await useCase.execute();

      // syncQuestions/FAQ still use pool — assert via mockQuery
      const deleteQCall = mockQuery.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM job_posting_prescreening_questions'),
      );
      expect(deleteQCall).toBeDefined();

      const insertQCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO job_posting_prescreening_questions'),
      );
      expect(insertQCalls).toHaveLength(2);

      // Verify DELETE + INSERT for FAQ
      const deleteFaqCall = mockQuery.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM job_posting_prescreening_faq'),
      );
      expect(deleteFaqCall).toBeDefined();

      const insertFaqCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('INSERT INTO job_posting_prescreening_faq'),
      );
      expect(insertFaqCalls).toHaveLength(1);
    });

    it('deve pular sync de questions/FAQ quando nao existem', async () => {
      const project = makeTalentumProject({
        projectId: 'proj-no-q',
        title: 'CASO 20',
        questions: [],
        faq: [],
      });
      mockListAllPrescreenings.mockResolvedValue([project]);

      // Pool: lookup talentum_project_id, lookup case_number, nextval (no DELETE/INSERT since empty)
      mockQuery
        .mockResolvedValueOnce({ rows: [] })          // lookup talentum_project_id
        .mockResolvedValueOnce({ rows: [] })          // lookup case_number
        .mockResolvedValueOnce({ rows: [{ vn: '2' }] }); // nextval
      mockClientQuery
        .mockResolvedValueOnce({})                              // BEGIN (createFromSync)
        .mockResolvedValueOnce({ rows: [{ id: 'jp-no-q' }] }) // INSERT RETURNING id
        .mockResolvedValue({ rows: [] });                       // audit + COMMIT + saveTalentumReference txn

      await useCase.execute();

      const deleteQCalls = mockQuery.mock.calls.filter(
        (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('DELETE FROM job_posting_prescreening'),
      );
      expect(deleteQCalls).toHaveLength(0);
    });
  });
});
