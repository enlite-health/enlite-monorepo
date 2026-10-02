/**
 * SyncTalentumVacanciesUseCase.test.ts — sync de vagas na Talentum API v2 (spec 040 / F2 / T2.4)
 *
 * O banco é FALSO e responde pelo SQL (`fakeJobPostingsDb.ts`); o cliente é um mock com os dois métodos
 * que o use case usa (`listAllPrescreenings` e `getPrescreening`). Cenários:
 *  1. projeto já ligado por talentum_project_id → skip SEM gastar GET; force → atualiza
 *  2. liga por publicId quando o project_id gravado é o antigo (morto), por título exato 1:1, e reporta
 *     duplicata de título (nada ligado nem criado); título só casa se a vaga não tem OUTRO publicId
 *  3. legado: número do título (vacancy_number / case_number) e criação de vaga nova
 *  4. PHONE_CALL e `/prescreening` 400: sem link web, liga/cria sem apagar o que já está gravado
 *  5. a FAQ do banco NÃO é tocada (decisão (g)); perguntas são substituídas pelas da Talentum
 *  6. erro de um projeto não aborta o sync; falha de INSERT/UPDATE dá ROLLBACK e vai para o relatório
 */

import { FakeJobPostingsDb } from './fakeJobPostingsDb';

let mockFake: FakeJobPostingsDb;

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockImplementation(() => ({
        query: (...a: [string, unknown[]?]) => mockFake.query(...(a as [string, unknown[]])),
        connect: () => mockFake.connect(),
      })),
    }),
  },
}));

const mockListAllPrescreenings = jest.fn();
const mockGetPrescreening = jest.fn();
jest.mock('../../infrastructure/TalentumApiClient', () => ({
  ...jest.requireActual('../../infrastructure/TalentumApiClient'),
  TalentumApiClient: {
    create: jest.fn().mockImplementation(async () => ({
      listAllPrescreenings: mockListAllPrescreenings,
      getPrescreening: mockGetPrescreening,
    })),
  },
}));

import { SyncTalentumVacanciesUseCase, type SyncReport } from '../SyncTalentumVacanciesUseCase';
import type { TalentumProject } from '../../domain/ITalentumApiClient';

// ── Helpers ──────────────────────────────────────────────────────

const WEB = (publicId: string) => `https://www.v2.talentum.chat/public/pre-screening/${publicId}/chat`;

/** Item da LISTA da v2: só `_id,name,status,type,myRole` (sem publicId, descrição nem perguntas). */
function listItem(projectId: string, title: string, over: Partial<TalentumProject> = {}): TalentumProject {
  return {
    projectId,
    publicId: '',
    title,
    description: '',
    whatsappUrl: '',
    slug: '',
    active: true,
    timestamp: '',
    questions: [],
    faq: [],
    status: 'IN_PROGRESS',
    type: 'FULL',
    myRole: 'OWNER',
    ...over,
  };
}

/** Detalhe composto por `getPrescreening` (GET /projects/:id + /prescreening). */
function detail(item: TalentumProject, over: Partial<TalentumProject> = {}): TalentumProject {
  return {
    ...item,
    publicId: `pub-${item.projectId}`,
    description: 'Descripción del puesto',
    whatsappUrl: WEB(`pub-${item.projectId}`),
    slug: `slug-${item.projectId}`,
    timestamp: '2026-10-01T10:00:00.000Z',
    questions: [
      { questionId: 'q1', question: '¿Experiencia?', type: 'text', responseType: ['text', 'audio'], desiredResponse: 'Sí', weight: 5, required: true, analyzed: true, earlyStoppage: false },
    ],
    ...over,
  };
}

function givenProjects(...items: TalentumProject[]) {
  mockListAllPrescreenings.mockResolvedValue(items);
  mockGetPrescreening.mockImplementation(async (id: string) => detail(items.find((i) => i.projectId === id)!));
}

function emptyReport(): SyncReport {
  return { total: 0, updated: 0, created: 0, skipped: 0, linkedByTitle: 0, withoutWebLink: 0, ignoredNotOurs: 0, duplicateTitles: [], errors: [] };
}

// ── Tests ────────────────────────────────────────────────────────

describe('SyncTalentumVacanciesUseCase (API v2)', () => {
  let useCase: SyncTalentumVacanciesUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    mockFake = new FakeJobPostingsDb();
    useCase = new SyncTalentumVacanciesUseCase();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. Já ligada ───────────────────────────────────────────────

  describe('vaga já ligada por talentum_project_id', () => {
    it('sem force: skip e NENHUM GET de detalhe na Talentum (economiza 2 GETs por projeto)', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'proj-1' });
      givenProjects(listItem('proj-1', 'EN 1#1'));

      const report = await useCase.execute({ force: false });

      expect(report).toMatchObject({ total: 1, skipped: 1, updated: 0, created: 0 });
      expect(mockGetPrescreening).not.toHaveBeenCalled();
    });

    it('force=true: relê o detalhe e atualiza link web, slug, descrição e perguntas', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'proj-1' });
      givenProjects(listItem('proj-1', 'EN 1#1'));

      const report = await useCase.execute({ force: true });

      expect(report).toMatchObject({ updated: 1, created: 0, skipped: 0 });
      expect(mockFake.vacancies[0]).toMatchObject({
        talentum_project_id: 'proj-1',
        talentum_public_id: 'pub-proj-1',
        talentum_whatsapp_url: WEB('pub-proj-1'),
        talentum_slug: 'slug-proj-1',
        talentum_description: 'Descripción del puesto',
      });
      expect(mockFake.questionsByVacancy.get('jp-1')).toBe(1);
    });

    it('chamada direta sem o 4º argumento (force) trata como false — já ligada é skip', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'proj-1' });
      const report = emptyReport();

      await (useCase as any).processProject(listItem('proj-1', 'EN 1#1'), {} as never, report);

      expect(report.skipped).toBe(1);
    });
  });

  // ── 2. Ligação por publicId / título ───────────────────────────

  describe('ligação sem talentum_project_id', () => {
    it('project_id gravado é o ANTIGO (morto): liga pelo publicId e repara o project_id', async () => {
      mockFake.add({ id: 'jp-7', title: 'EN 7#1', talentum_project_id: 'id-antigo-v1', talentum_public_id: 'pub-proj-new', talentum_whatsapp_url: 'https://wa.me/antigo' });
      givenProjects(listItem('proj-new', 'EN 7#1'));

      const report = await useCase.execute();

      expect(report).toMatchObject({ updated: 1, created: 0, linkedByTitle: 0 });
      expect(mockFake.vacancies).toHaveLength(1);
      expect(mockFake.vacancies[0].talentum_project_id).toBe('proj-new');
      expect(mockFake.vacancies[0].talentum_whatsapp_url).toBe(WEB('pub-proj-new')); // wa.me antigo sai
    });

    it('sem publicId no banco: liga pelo título EXATO 1:1 e conta em linkedByTitle', async () => {
      mockFake.add({ id: 'jp-8', title: 'EN 8#1' });
      givenProjects(listItem('proj-8', 'EN 8#1'));

      const report = await useCase.execute();

      expect(report).toMatchObject({ updated: 1, created: 0, linkedByTitle: 1 });
      expect(mockFake.vacancies[0].talentum_project_id).toBe('proj-8');
      expect(mockFake.vacancies[0].talentum_public_id).toBe('pub-proj-8');
    });

    it('vaga com título > 50 liga pelo título cortado em 50 (mesma regra da reconciliação)', async () => {
      const longo = 'EN 10#1 ' + 'x'.repeat(60);
      mockFake.add({ id: 'jp-long', title: longo });
      givenProjects(listItem('proj-long', longo.slice(0, 50)));

      const report = await useCase.execute();

      expect(report).toMatchObject({ updated: 1, created: 0, linkedByTitle: 1 });
      expect(mockFake.vacancies).toHaveLength(1);
      expect(mockFake.vacancies[0].talentum_project_id).toBe('proj-long');
    });

    it('título que casa com 2 vagas: relata a duplicata e NÃO liga nem cria nada', async () => {
      mockFake.add({ id: 'jp-a', title: 'EN 9#1' });
      mockFake.add({ id: 'jp-b', title: 'EN 9#1' });
      givenProjects(listItem('proj-9', 'EN 9#1'));

      const report = await useCase.execute();

      expect(report.duplicateTitles).toEqual([{ projectId: 'proj-9', title: 'EN 9#1', matches: 2 }]);
      expect(report).toMatchObject({ updated: 0, created: 0, linkedByTitle: 0, errors: [] });
      expect(mockFake.vacancies).toHaveLength(2);
      expect(mockFake.vacancies.every((v) => v.talentum_project_id === null)).toBe(true);
    });

    it('vaga de MESMO título mas com OUTRO publicId não é ligada pelo título (cria nova)', async () => {
      mockFake.add({ id: 'jp-x', title: 'Proyecto X', talentum_public_id: 'pub-de-outro-projeto' });
      givenProjects(listItem('proj-x', 'Proyecto X'));

      const report = await useCase.execute();

      expect(report).toMatchObject({ created: 1, updated: 0, linkedByTitle: 0 });
      expect(mockFake.vacancies.find((v) => v.id === 'jp-x')!.talentum_project_id).toBeNull();
    });
  });

  // ── 2b. T7.0: só vira vaga nova o projeto que é NOSSO ───────────

  describe('projeto sem par: só cria se myRole === OWNER (spec 040 T7.0)', () => {
    it('VIEWER sem par: 0 INSERT e conta em ignoredNotOurs', async () => {
      givenProjects(listItem('proj-v', 'Proyecto ajeno', { myRole: 'VIEWER' }));

      const report = await useCase.execute();

      expect(report).toMatchObject({ total: 1, created: 0, updated: 0, ignoredNotOurs: 1, errors: [] });
      expect(mockFake.vacancies).toHaveLength(0);
    });

    it('OWNER sem par: cria a vaga, como antes', async () => {
      givenProjects(listItem('proj-o', 'Proyecto propio', { myRole: 'OWNER' }));

      const report = await useCase.execute();

      expect(report).toMatchObject({ created: 1, ignoredNotOurs: 0, errors: [] });
      expect(mockFake.vacancies).toHaveLength(1);
    });

    it('VIEWER COM par (por publicId): continua ligando a vaga existente', async () => {
      mockFake.add({ id: 'jp-1', title: 'antigo', talentum_project_id: 'id-v1', talentum_public_id: 'pub-proj-v' });
      givenProjects(listItem('proj-v', 'Proyecto ajeno', { myRole: 'VIEWER' }));

      const report = await useCase.execute();

      expect(report).toMatchObject({ updated: 1, created: 0, ignoredNotOurs: 0 });
      expect(mockFake.vacancies[0].talentum_project_id).toBe('proj-v');
    });
  });

  // ── 3. Legado (número do título) e criação ─────────────────────

  describe('número do título (legado) e vaga nova', () => {
    it('"CASO N-M": liga pela vacancy_number M', async () => {
      mockFake.add({ id: 'jp-v42', title: 'outro título', vacancy_number: 42 });
      givenProjects(listItem('proj-1', 'CASO 230-42'));

      const report = await useCase.execute();

      expect(report).toMatchObject({ updated: 1, created: 0, errors: [] });
      expect(mockFake.vacancies[0].talentum_project_id).toBe('proj-1');
    });

    it('"CASO N" sem vaga com o número: cai no case_number e liga a vaga do caso', async () => {
      mockFake.add({ id: 'jp-c88', title: 'outro', case_number: 88 });
      givenProjects(listItem('proj-1', 'caso 88 - AT')); // case-insensitive

      const report = await useCase.execute();

      expect(report).toMatchObject({ updated: 1, created: 0 });
    });

    it('"CASO N-M" sem vaga correspondente e sem caso: cria vaga nova (SEARCHING, AR)', async () => {
      mockFake.nextVn = 99;
      givenProjects(listItem('proj-1', 'CASO 55'));

      const report = await useCase.execute();

      expect(report).toMatchObject({ created: 1, updated: 0 });
      expect(mockFake.vacancies[0]).toMatchObject({ title: 'CASO 55-99', vacancy_number: 99, case_number: 55, talentum_project_id: 'proj-1' });
      const insert = mockFake.clientSql.find((q) => q.includes('INSERT INTO job_postings'))!;
      expect(insert).toContain("'AR'");
      expect(insert).toContain("'SEARCHING'");
    });

    it('case_number nativo (>= 1000) gera "CASO EN{caso}-{vaga}"', async () => {
      mockFake.nextVn = 1500;
      givenProjects(listItem('proj-1', 'CASO 1000'));

      await useCase.execute();

      expect(mockFake.vacancies[0].title).toBe('CASO EN1000-1500');
    });

    it('título sem número: cria "VACANTE {n}" com case_number null', async () => {
      mockFake.nextVn = 5;
      givenProjects(listItem('proj-1', 'Proyecto genérico sin número'));

      const report = await useCase.execute();

      expect(report.created).toBe(1);
      expect(mockFake.vacancies[0]).toMatchObject({ title: 'VACANTE 5', case_number: null });
    });

    it('"CASO 600-15" sem vaga 15 nem caso 600 → cria nova', async () => {
      givenProjects(listItem('proj-1', 'CASO 600-15'));

      const report = await useCase.execute();

      expect(report.created).toBe(1);
    });
  });

  // ── 4. Sem link web ────────────────────────────────────────────

  describe('projeto sem link web (PHONE_CALL e /prescreening 400)', () => {
    it('PHONE_CALL: não pede detalhe, conta withoutWebLink e cria SEM publicId nem link', async () => {
      givenProjects(listItem('proj-tel', 'Llamada de prueba', { type: 'PHONE_CALL' }));

      const report = await useCase.execute();

      expect(mockGetPrescreening).not.toHaveBeenCalled();
      expect(report).toMatchObject({ created: 1, withoutWebLink: 1, errors: [] });
      expect(mockFake.vacancies[0]).toMatchObject({ talentum_project_id: 'proj-tel', talentum_public_id: null, talentum_whatsapp_url: null });
    });

    it('/prescreening 400: liga pelo título SEM apagar link e descrição já gravados', async () => {
      mockFake.add({ id: 'jp-400', title: 'EN 4#1', talentum_whatsapp_url: WEB('pub-gravado'), talentum_description: 'texto gravado' });
      mockListAllPrescreenings.mockResolvedValue([listItem('proj-400', 'EN 4#1')]);
      mockGetPrescreening.mockRejectedValue(new Error('[TalentumApiClient] GET /projects/proj-400/prescreening — HTTP 400: {}'));

      const report = await useCase.execute();

      expect(report).toMatchObject({ updated: 1, withoutWebLink: 1, linkedByTitle: 1, errors: [] });
      expect(mockFake.vacancies[0]).toMatchObject({
        talentum_project_id: 'proj-400',
        talentum_whatsapp_url: WEB('pub-gravado'),
        talentum_description: 'texto gravado',
      });
    });

    it('o UPDATE usa COALESCE nos campos que podem vir vazios (item da lista não traz link)', async () => {
      givenProjects(listItem('proj-1', 'EN 1#1'));
      await useCase.execute();
      const update = mockFake.clientSql.find((q) => q.includes('UPDATE job_postings'))!;
      for (const col of ['talentum_public_id', 'talentum_whatsapp_url', 'talentum_slug', 'talentum_published_at', 'talentum_description']) {
        expect(update).toMatch(new RegExp(`${col}\\s*= COALESCE\\(`));
      }
    });

    it('erro do detalhe que NÃO é 400 (ex.: 500) vai para o relatório e o sync segue', async () => {
      mockListAllPrescreenings.mockResolvedValue([listItem('p-ruim', 'EN 1#1'), listItem('p-ok', 'EN 2#1')]);
      mockGetPrescreening.mockImplementation(async (id: string) => {
        if (id === 'p-ruim') throw new Error('[TalentumApiClient] GET /projects/p-ruim — HTTP 500: x');
        return detail(listItem(id, 'EN 2#1'));
      });

      const report = await useCase.execute();

      expect(report.total).toBe(2);
      expect(report.errors).toEqual([{ projectId: 'p-ruim', title: 'EN 1#1', error: expect.stringContaining('HTTP 500') }]);
      expect(report.created).toBe(1);
    });

    it('rejeição que não é Error também é relatada (e não derruba o sync)', async () => {
      mockListAllPrescreenings.mockResolvedValue([listItem('p-1', 'EN 1#1')]);
      mockGetPrescreening.mockRejectedValue('texto cru');

      const report = await useCase.execute();

      expect(report.errors).toHaveLength(1);
    });
  });

  // ── 5. FAQ e perguntas ─────────────────────────────────────────

  describe('FAQ e perguntas', () => {
    it('a FAQ do banco sobrevive a um sync com faq: [] (nenhuma SQL toca a tabela de FAQ)', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'proj-1' });
      mockFake.faq.set('jp-1', [{ question: 'q', answer: 'a' }]);
      givenProjects(listItem('proj-1', 'EN 1#1'));

      await useCase.execute({ force: true });

      expect(mockFake.faqSql).toEqual([]);
      expect(mockFake.faq.get('jp-1')).toHaveLength(1);
    });

    it('mesmo que o detalhe traga FAQ (forma legada), o sync NÃO a grava', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'proj-1' });
      mockListAllPrescreenings.mockResolvedValue([listItem('proj-1', 'EN 1#1')]);
      mockGetPrescreening.mockResolvedValue(detail(listItem('proj-1', 'EN 1#1'), { faq: [{ question: 'x', answer: 'y' }] }));

      await useCase.execute({ force: true });

      expect(mockFake.faqSql).toEqual([]);
    });

    it('substitui as perguntas pelas da Talentum (DELETE + 1 INSERT por pergunta)', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'proj-1' });
      mockListAllPrescreenings.mockResolvedValue([listItem('proj-1', 'EN 1#1')]);
      const q = (n: number) => ({ questionId: `q${n}`, question: `P${n}?`, type: 'text' as const, responseType: ['audio' as const], desiredResponse: 'x', weight: 3, required: false, analyzed: false, earlyStoppage: true });
      mockGetPrescreening.mockResolvedValue(detail(listItem('proj-1', 'EN 1#1'), { questions: [q(1), q(2)] }));

      await useCase.execute({ force: true });

      expect(mockFake.questionsByVacancy.get('jp-1')).toBe(2);
    });

    it('sem perguntas no detalhe: não toca nas perguntas do banco', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'proj-1' });
      mockFake.questionsByVacancy.set('jp-1', 4);
      mockListAllPrescreenings.mockResolvedValue([listItem('proj-1', 'EN 1#1')]);
      mockGetPrescreening.mockResolvedValue(detail(listItem('proj-1', 'EN 1#1'), { questions: [] }));

      await useCase.execute({ force: true });

      expect(mockFake.questionsByVacancy.get('jp-1')).toBe(4);
    });
  });

  // ── 6. Resiliência e relatório ─────────────────────────────────

  describe('resiliência e relatório', () => {
    it('um projeto que falha (nextval) não aborta os demais; erro leva projectId e título', async () => {
      givenProjects(listItem('proj-fail', 'CASO 1'), listItem('proj-ok', 'CASO 2'));
      mockFake.failOnce.set('nextval', new Error('DB connection lost'));

      const report = await useCase.execute();

      expect(report.total).toBe(2);
      expect(report.errors).toEqual([{ projectId: 'proj-fail', title: 'CASO 1', error: 'DB connection lost' }]);
      expect(report.created).toBe(1);
    });

    it('INSERT de createFromSync falha → ROLLBACK e erro no relatório', async () => {
      givenProjects(listItem('proj-1', 'CASO 300'));
      mockFake.failOnce.set('INSERT INTO job_postings', new Error('insert failed'));

      const report = await useCase.execute();

      expect(report.errors).toEqual([{ projectId: 'proj-1', title: 'CASO 300', error: 'insert failed' }]);
      expect(mockFake.clientSql).toContain('ROLLBACK');
    });

    it('UPDATE da referência falha → ROLLBACK e erro no relatório (não é best-effort)', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'proj-velho' });
      mockFake.vacancies[0].talentum_public_id = 'pub-proj-1';
      givenProjects(listItem('proj-1', 'EN 1#1'));
      mockFake.failOnce.set('SET talentum_project_id', new Error('update ref failed'));

      const report = await useCase.execute();

      expect(report.errors).toEqual([{ projectId: 'proj-1', title: 'EN 1#1', error: 'update ref failed' }]);
      expect(mockFake.clientSql).toContain('ROLLBACK');
    });

    it('lista vazia: total 0 e nenhuma escrita', async () => {
      mockListAllPrescreenings.mockResolvedValue([]);

      const report = await useCase.execute();

      expect(report).toEqual(emptyReport());
      expect(mockFake.clientSql).toEqual([]);
    });

    it('mistura: skip + atualiza + cria + duplicata, com totais coerentes', async () => {
      mockFake.add({ id: 'jp-1', title: 'EN 1#1', talentum_project_id: 'p1' });
      mockFake.add({ id: 'jp-2', title: 'EN 2#1', talentum_project_id: 'velho-2', talentum_public_id: 'pub-p2' });
      mockFake.add({ id: 'jp-d1', title: 'EN 4#1' });
      mockFake.add({ id: 'jp-d2', title: 'EN 4#1' });
      givenProjects(listItem('p1', 'EN 1#1'), listItem('p2', 'EN 2#1'), listItem('p3', 'Proyecto nuevo'), listItem('p4', 'EN 4#1'));

      const report = await useCase.execute();

      expect(report).toMatchObject({ total: 4, skipped: 1, updated: 1, created: 1, errors: [] });
      expect(report.duplicateTitles).toHaveLength(1);
    });
  });
});
