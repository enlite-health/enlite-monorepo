/**
 * SyncTalentumVacanciesUseCase.v2stub.test.ts — spec 040 / F2 / T2.4 (MEDIÇÃO no stub)
 *
 * Cliente REAL + stub em memória da v2 (conta com 468 projetos: 243 OWNER + 225 VIEWER, como medido
 * em prd) + banco falso. Nada sai para a rede e nada toca produção. Mede e TRAVA:
 *  - o custo em requests do sync de N projetos (1 `GET /projects` por página de 12 + 2 GETs por projeto:
 *    `GET /projects/:id` e `GET /projects/:id/prescreening`, porque o item da lista não traz `publicId`);
 *  - quantas vagas ele CRIA para projetos sem par (ligação por publicId, depois título exato).
 * Os números de "sem par" dependem da massa montada aqui (312 por publicId, como em prd; 20 por título —
 * valor ILUSTRATIVO): o que o stub prova é o MECANISMO e o custo; o nº real de órfãos em prd só sai de
 * um dry-run contra a réplica (fora desta spec).
 */

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

import { FakeJobPostingsDb } from './fakeJobPostingsDb';
import { TalentumV2Stub } from '../../infrastructure/__tests__/talentumV2Stub';
import { SyncTalentumVacanciesUseCase } from '../SyncTalentumVacanciesUseCase';

const originalFetch = global.fetch;
const envBackup = { ...process.env };

const TOTAL = 468;
const OWNED = 243;
const BY_PUBLIC_ID = 312;
const BY_TITLE_ONLY = 20;

const pid = (n: number) => `proj-${String(n).padStart(3, '0')}`;

function seedWorld(stub: TalentumV2Stub, db: FakeJobPostingsDb) {
  for (let n = 1; n <= TOTAL; n++) {
    stub.seed({
      _id: pid(n),
      name: `EN ${n}#1`,
      publicId: `pub-${pid(n)}`,
      myRole: n <= OWNED ? 'OWNER' : 'VIEWER',
      questions: [{ questionId: `q-${n}`, question: '¿Experiencia?', responseType: ['text', 'audio'], idealResponse: 'sí', weight: 5, required: true, analyzed: true, earlyStoppage: false }],
    });
  }
  // 312 vagas com publicId gravado (project_id ANTIGO, morto na v2) — como em prd
  for (let n = 1; n <= BY_PUBLIC_ID; n++) {
    db.add({ id: `jp-${n}`, title: `título antigo ${n}`, talentum_project_id: `id-v1-${n}`, talentum_public_id: `pub-${pid(n)}` });
  }
  // 20 vagas sem publicId cujo título casa 1:1 com o nome do projeto
  for (let n = BY_PUBLIC_ID + 1; n <= BY_PUBLIC_ID + BY_TITLE_ONLY; n++) {
    db.add({ id: `jp-${n}`, title: `EN ${n}#1` });
  }
}

describe('SyncTalentumVacanciesUseCase — custo e vagas criadas, medidos no stub v2', () => {
  let stub: TalentumV2Stub;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    stub = new TalentumV2Stub();
    mockFake = new FakeJobPostingsDb();
    seedWorld(stub, mockFake);
    global.fetch = stub.asFetch();
    process.env.TALENTUM_API_EMAIL = 'stub-user-e2e-only';
    process.env.TALENTUM_API_PASSWORD = 'stub-key-e2e-only';
    process.env.TALENTUM_API_BASE_URL = 'http://stub.invalid';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    process.env = { ...envBackup };
  });

  it('468 projetos: 39 páginas + 2 GETs por projeto = 975 GETs; liga 312 por publicId, 20 por título, CRIA 0 e ignora 136 VIEWER sem par (T7.0)', async () => {
    const report = await new SyncTalentumVacanciesUseCase().execute();

    const listGets = stub.calls.filter((c) => c.method === 'GET' && c.path === '/projects').length;
    const projectGets = stub.calls.filter((c) => c.method === 'GET' && /^\/projects\/[^/]+$/.test(c.path)).length;
    const prescreeningGets = stub.calls.filter((c) => c.method === 'GET' && /\/prescreening$/.test(c.path)).length;
    const writes = stub.calls.filter((c) => c.method !== 'GET' && c.path !== '/auth/login').length;

    expect(report).toMatchObject({
      total: TOTAL,
      updated: BY_PUBLIC_ID + BY_TITLE_ONLY,
      linkedByTitle: BY_TITLE_ONLY,
      created: 0,
      ignoredNotOurs: TOTAL - BY_PUBLIC_ID - BY_TITLE_ONLY,
      skipped: 0,
      withoutWebLink: 0,
      errors: [],
    });
    expect(report.duplicateTitles).toEqual([]);
    expect(listGets).toBe(Math.ceil(TOTAL / 12)); // 39
    expect(projectGets).toBe(TOTAL); // 468
    expect(prescreeningGets).toBe(TOTAL); // 468
    expect(listGets + projectGets + prescreeningGets).toBe(975);
    expect(writes).toBe(0); // o sync é só leitura na Talentum
    // a ligação por publicId repara o project_id antigo e grava o link WEB (nunca wa.me)
    const v = mockFake.vacancies.find((x) => x.id === 'jp-1')!;
    expect(v.talentum_project_id).toBe(pid(1));
    expect(v.talentum_whatsapp_url).toBe(`https://www.v2.talentum.chat/public/pre-screening/pub-${pid(1)}/chat`);

    process.stdout.write(
      `\n[MEDIDO T2.4] GETs: lista=${listGets} projeto=${projectGets} prescreening=${prescreeningGets} total=${listGets + projectGets + prescreeningGets} ` +
        `(+1 login) | vagas: total=${TOTAL} ligadas_publicId=${BY_PUBLIC_ID} ligadas_titulo=${BY_TITLE_ONLY} CRIADAS(sem par)=${report.created} ignoradas_nao_nossas=${report.ignoredNotOurs}\n`,
    );
  });

  it('2ª execução logo depois: 332 ligadas = skip sem GET; as 136 ignoradas (VIEWER sem par) custam 2 GETs cada (272), 0 criadas', async () => {
    await new SyncTalentumVacanciesUseCase().execute();
    stub.calls.length = 0;

    const report = await new SyncTalentumVacanciesUseCase().execute();

    const detailGets = stub.calls.filter((c) => c.method === 'GET' && c.path !== '/projects').length;
    const IGNORED = TOTAL - BY_PUBLIC_ID - BY_TITLE_ONLY;
    expect(report).toMatchObject({ total: TOTAL, skipped: TOTAL - IGNORED, ignoredNotOurs: IGNORED, created: 0, updated: 0, errors: [] });
    expect(detailGets).toBe(IGNORED * 2);
    expect(stub.calls.filter((c) => c.path === '/projects')).toHaveLength(39);
  });
});
