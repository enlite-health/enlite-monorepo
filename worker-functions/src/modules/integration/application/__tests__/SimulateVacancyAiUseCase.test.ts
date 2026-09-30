/**
 * SimulateVacancyAiUseCase — spec 029 T071.
 *
 * Fronteiras dubladas: Vertex (`generateContentVertex`, espionado no 1º argumento = modelo e no
 * systemInstruction = prompt efetivo), `AiPromptRepository` (a tabela) e o pool (só SELECT).
 * Os serviços de IA são os REAIS nos blocos de modelo/fallback (é o que prova o que chega ao modelo);
 * nos blocos de escolha/estrutura entram fakes para isolar a decisão do caso de uso.
 */
const mockGenerateContentVertex = jest.fn();
jest.mock('../../infrastructure/vertex-gemini', () => ({
  generateContentVertex: (...args: unknown[]) => mockGenerateContentVertex(...args),
}));

const mockFindActiveBySlug = jest.fn();
jest.mock('../../infrastructure/AiPromptRepository', () => ({
  AiPromptRepository: jest.fn().mockImplementation(() => ({
    findActiveBySlug: (...args: unknown[]) => mockFindActiveBySlug(...args),
  })),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) },
}));

import type { Pool } from 'pg';
import { SimulateVacancyAiUseCase } from '../SimulateVacancyAiUseCase';
import { JobPostingNotFoundError, TalentumDescriptionService } from '../../infrastructure/TalentumDescriptionService';
import type { GeminiVacancyParserService } from '../../infrastructure/GeminiVacancyParserService';

const JOB_ID = '33333333-3333-3333-3333-333333333333';

function caseRow(professions: string[]) {
  return {
    id: JOB_ID, title: 'Caso 9', case_number: 9, required_professions: professions, required_sex: null,
    age_range_min: 20, age_range_max: 40, required_experience: null, worker_attributes: null,
    schedule: null, work_schedule: null, providers_needed: 1, salary_text: null, payment_day: null,
    daily_obs: null, address_formatted: null, city: 'CABA', state: 'BA',
    diagnosis: 'TEA', dependency_level: 'Leve', service_type: ['Domiciliario'],
  };
}

function makePool(rows: unknown[]) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { pool: { query, connect: jest.fn() } as unknown as Pool, query };
}

const QUESTION = { question: 'P?', responseType: ['text'], desiredResponse: 'r', weight: 1, required: true, analyzed: true, earlyStoppage: false };
const FAQ = { question: 'F?', answer: 'R' };

function makeFakes() {
  const composeDescription = jest.fn().mockResolvedValue({ title: 'Caso 9', description: 'DESCRICAO GERADA' });
  const generateFromVacancyData = jest.fn().mockResolvedValue({
    // `vacancy` existe no retorno do parser e NÃO pode vazar para a saída.
    vacancy: { title: 'NAO-VAZAR', case_number: 9 },
    prescreening: { questions: [QUESTION], faq: [FAQ] },
  });
  return {
    composeDescription,
    generateFromVacancyData,
    descService: { composeDescription } as unknown as TalentumDescriptionService,
    parserService: { generateFromVacancyData } as unknown as GeminiVacancyParserService,
  };
}

describe('SimulateVacancyAiUseCase — escolha pela VAGA e estrutura de saída', () => {
  it('vaga AT: prescreening AT com o corpo em edição; corpo de CAREGIVER recebido é ignorado', async () => {
    const { pool } = makePool([caseRow(['AT'])]);
    const f = makeFakes();
    const out = await new SimulateVacancyAiUseCase({ db: pool, descService: f.descService, parserService: f.parserService })
      .execute({
        jobPostingId: JOB_ID,
        bodies: { VACANCY_DESCRIPTION: 'CORPO-VD', PRESCREENING_AT: 'CORPO-AT', PRESCREENING_CAREGIVER: 'CORPO-CAREGIVER' },
      });

    expect(f.composeDescription).toHaveBeenCalledWith(JOB_ID, 'CORPO-VD');
    expect(f.generateFromVacancyData).toHaveBeenCalledTimes(1);
    const args = f.generateFromVacancyData.mock.calls[0];
    expect(args[3]).toBe('AT');
    expect(args[4]).toBe('CORPO-AT');
    expect(JSON.stringify(f.generateFromVacancyData.mock.calls)).not.toContain('CORPO-CAREGIVER');
    expect(out.workerType).toBe('AT');
    expect(out.usedSlugs).toEqual(['VACANCY_DESCRIPTION', 'PRESCREENING_AT']);
  });

  it('vaga CUIDADOR: prescreening CAREGIVER com o corpo em edição; corpo de AT recebido é ignorado', async () => {
    const { pool } = makePool([caseRow(['AT', 'CUIDADOR'])]);
    const f = makeFakes();
    const out = await new SimulateVacancyAiUseCase({ db: pool, descService: f.descService, parserService: f.parserService })
      .execute({ jobPostingId: JOB_ID, bodies: { PRESCREENING_AT: 'CORPO-AT', PRESCREENING_CAREGIVER: 'CORPO-CAREGIVER' } });

    const args = f.generateFromVacancyData.mock.calls[0];
    expect(args[3]).toBe('CUIDADOR');
    expect(args[4]).toBe('CORPO-CAREGIVER');
    expect(JSON.stringify(f.generateFromVacancyData.mock.calls)).not.toContain('CORPO-AT');
    expect(out.workerType).toBe('CUIDADOR');
    expect(out.usedSlugs).toEqual(['VACANCY_DESCRIPTION', 'PRESCREENING_CAREGIVER']);
  });

  it('vaga sem profissões (null) cai em AT, como a produção', async () => {
    const { pool } = makePool([caseRow(null as unknown as string[])]);
    const f = makeFakes();
    const out = await new SimulateVacancyAiUseCase({ db: pool, descService: f.descService, parserService: f.parserService })
      .execute({ jobPostingId: JOB_ID, bodies: {} });
    expect(out.workerType).toBe('AT');
  });

  it('a saída é ESTRUTURA {description, prescreening:{questions,faq}} e NÃO traz vacancy{}', async () => {
    const { pool } = makePool([caseRow(['AT'])]);
    const f = makeFakes();
    const out = await new SimulateVacancyAiUseCase({ db: pool, descService: f.descService, parserService: f.parserService })
      .execute({ jobPostingId: JOB_ID, bodies: {} });

    expect(out).toEqual({
      description: 'DESCRICAO GERADA',
      prescreening: { questions: [QUESTION], faq: [FAQ] },
      workerType: 'AT',
      usedSlugs: ['VACANCY_DESCRIPTION', 'PRESCREENING_AT'],
    });
    expect(typeof out.description).toBe('string');
    expect(Object.keys(out)).not.toContain('vacancy');
    expect(JSON.stringify(out)).not.toContain('NAO-VAZAR');
  });

  it('as duas gerações partem juntas (Promise.all): a 2ª começa antes de a 1ª terminar', async () => {
    const { pool } = makePool([caseRow(['AT'])]);
    const f = makeFakes();
    let releaseDesc!: () => void;
    f.composeDescription.mockImplementation(() => new Promise((res) => { releaseDesc = () => res({ title: 't', description: 'D' }); }));
    const p = new SimulateVacancyAiUseCase({ db: pool, descService: f.descService, parserService: f.parserService })
      .execute({ jobPostingId: JOB_ID, bodies: {} });
    await new Promise((r) => setImmediate(r));
    expect(f.generateFromVacancyData).toHaveBeenCalledTimes(1); // a descrição ainda pendente
    releaseDesc();
    await p;
  });

  it('vaga inexistente: JobPostingNotFoundError e nenhuma chamada de IA', async () => {
    const { pool } = makePool([]);
    const f = makeFakes();
    await expect(
      new SimulateVacancyAiUseCase({ db: pool, descService: f.descService, parserService: f.parserService })
        .execute({ jobPostingId: JOB_ID, bodies: {} }),
    ).rejects.toBeInstanceOf(JobPostingNotFoundError);
    expect(f.composeDescription).not.toHaveBeenCalled();
    expect(f.generateFromVacancyData).not.toHaveBeenCalled();
  });

  it('não escreve: toda query do caso de uso é SELECT', async () => {
    const { pool, query } = makePool([caseRow(['AT'])]);
    const f = makeFakes();
    await new SimulateVacancyAiUseCase({ db: pool, descService: f.descService, parserService: f.parserService })
      .execute({ jobPostingId: JOB_ID, bodies: {} });
    expect(query).toHaveBeenCalled(); // senão "só SELECT" seria vácuo
    for (const c of query.mock.calls) expect(String(c[0]).trim()).toMatch(/^SELECT/i);
  });
});

function vertexResponse(payload: unknown) {
  return { ok: true, json: () => Promise.resolve({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] }, finishReason: 'STOP' }] }) };
}

function makeRealServicesUseCase(professions: string[]) {
  const { pool } = makePool([caseRow(professions)]);
  const useCase = new SimulateVacancyAiUseCase({ db: pool });
  const svc = (useCase as any).descService as TalentumDescriptionService;
  jest.spyOn(svc as any, 'loadInput').mockResolvedValue({ caseNumber: '9', title: 'Caso 9', requiredProfessions: professions });
  return useCase;
}

// Vacante completa: sem campo faltando o parser NÃO faz a 2ª chamada de retry (que tem outro formato).
const VACANCY_COMPLETA = {
  title: 'Caso 9', case_number: 9, required_professions: ['AT'], required_sex: 'BOTH',
  age_range_min: 20, age_range_max: 60, required_experience: 'sem exigência', worker_attributes: 'a',
  schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }], work_schedule: 'part-time',
  providers_needed: 1, salary_text: 'a combinar', payment_day: '5', daily_obs: null, status: 'SEARCHING',
};

function stubModel() {
  mockGenerateContentVertex.mockImplementation(async (_m: string, body: any) => {
    const sys: string = body?.systemInstruction?.parts?.[0]?.text ?? '';
    // Só o prompt de prescreening carrega as instruções de saída com a chave "prescreening".
    return sys.includes('"prescreening"')
      ? vertexResponse({ vacancy: VACANCY_COMPLETA, prescreening: { questions: [], faq: [] } })
      : vertexResponse({ propuesta: 'p', perfilProfesional: 'pp' });
  });
}

const SAVED_FAST = process.env.GEMINI_MODEL_FAST;
const SAVED_BASE = process.env.GEMINI_MODEL;
beforeEach(() => {
  jest.clearAllMocks();
  mockFindActiveBySlug.mockImplementation(async (slug: string) => ({ slug, body: `TABELA-${slug}`, version: 1, isActive: true }));
});
afterAll(() => {
  if (SAVED_FAST === undefined) delete process.env.GEMINI_MODEL_FAST; else process.env.GEMINI_MODEL_FAST = SAVED_FAST;
  if (SAVED_BASE === undefined) delete process.env.GEMINI_MODEL; else process.env.GEMINI_MODEL = SAVED_BASE;
});

describe('SimulateVacancyAiUseCase — modelo = o da produção', () => {
  it('CONTROLE POSITIVO: com GEMINI_MODEL_FAST inventado, AS DUAS chamadas ao Vertex usam exatamente esse valor', async () => {
    process.env.GEMINI_MODEL_FAST = 'gemini-test-sentinela';
    process.env.GEMINI_MODEL = 'gemini-2.5-pro';
    stubModel();
    await makeRealServicesUseCase(['AT']).execute({ jobPostingId: JOB_ID, bodies: { VACANCY_DESCRIPTION: 'vd propuesta', PRESCREENING_AT: 'at' } });
    expect(mockGenerateContentVertex).toHaveBeenCalledTimes(2);
    expect(mockGenerateContentVertex.mock.calls.map((c) => c[0])).toEqual(['gemini-test-sentinela', 'gemini-test-sentinela']);
  });

  it('NEGATIVA: sem GEMINI_MODEL_FAST o modelo é o flash da produção, nunca o default pro', async () => {
    delete process.env.GEMINI_MODEL_FAST;
    process.env.GEMINI_MODEL = 'gemini-2.5-pro';
    stubModel();
    await makeRealServicesUseCase(['AT']).execute({ jobPostingId: JOB_ID, bodies: { VACANCY_DESCRIPTION: 'vd propuesta', PRESCREENING_AT: 'at' } });
    const models = mockGenerateContentVertex.mock.calls.map((c) => c[0]);
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash']);
  });
});

describe('SimulateVacancyAiUseCase — corpo ausente cai na tabela', () => {
  it('sem corpos: os dois prompts vêm da tabela (findActiveBySlug) e chegam ao modelo', async () => {
    stubModel();
    await makeRealServicesUseCase(['CUIDADOR']).execute({ jobPostingId: JOB_ID, bodies: {} });
    const slugsLidos = mockFindActiveBySlug.mock.calls.map((c) => c[0]).sort();
    expect(slugsLidos).toEqual(['PRESCREENING_CAREGIVER', 'VACANCY_DESCRIPTION']); // AT NÃO é lido: vaga é de CUIDADOR
    const systems = mockGenerateContentVertex.mock.calls.map((c) => (c[1] as any).systemInstruction.parts[0].text as string);
    expect(systems.some((s) => s.includes('TABELA-VACANCY_DESCRIPTION'))).toBe(true);
    expect(systems.some((s) => s.includes('TABELA-PRESCREENING_CAREGIVER'))).toBe(true);
  });

  it('corpo em edição só para a descrição: prescreening ainda vem da tabela, e a descrição NÃO lê a tabela', async () => {
    stubModel();
    await makeRealServicesUseCase(['AT']).execute({ jobPostingId: JOB_ID, bodies: { VACANCY_DESCRIPTION: 'EDITADO propuesta' } });
    expect(mockFindActiveBySlug.mock.calls.map((c) => c[0])).toEqual(['PRESCREENING_AT']);
    const systems = mockGenerateContentVertex.mock.calls.map((c) => (c[1] as any).systemInstruction.parts[0].text as string);
    expect(systems.some((s) => s.includes('EDITADO propuesta'))).toBe(true);
    expect(systems.some((s) => s.includes('TABELA-VACANCY_DESCRIPTION'))).toBe(false);
  });
});
