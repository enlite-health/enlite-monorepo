/**
 * SyncTalentumWorkersUseCase.v2stub.test.ts — spec 040 / F3 / T3.4 (MEDIÇÃO de requests no stub)
 *
 * Cliente REAL + stub em memória da v2 + banco falso. Nada sai para a rede, nada toca produção.
 * A massa reproduz os TOTAIS medidos em prd (fatos-medidos §P4.d): 468 projetos (317 IN_PROGRESS,
 * 150 PAUSED, 1 DRAFT), 289 deles com candidato, 5425 candidatos, 12 por página. A distribuição por
 * projeto é SINTÉTICA, escolhida para que a soma de páginas feche nos 625 requests medidos em prd
 * (28 projetos vazios custam 1 request cada + 597 páginas). Os candidatos são inventados.
 *
 * O que o teste prova é o MECANISMO e o custo do sync: nº de requests de candidatos, que só projeto
 * IN_PROGRESS com vaga par é lido, e que `ready-for-interview` só é pedido onde há qualificado.
 * O TEMPO de parede (que depende da rede real) está em `evidencias/scripts/medir-sync-workers-real.mjs`.
 */

let mockFake: FakeWorkersDb;
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => ({ query: (...a: unknown[]) => (mockFake.query as any)(...a) }) }),
  },
}));

import { FakeWorkersDb } from './fakeWorkersDb';
import { TalentumV2Stub, StubCandidate } from '../../infrastructure/__tests__/talentumV2Stub';
import { SyncTalentumWorkersUseCase } from '../SyncTalentumWorkersUseCase';
import { logger } from '@shared/logging';

const originalFetch = global.fetch;
const envBackup = { ...process.env };

const pid = (n: number) => `proj-${String(n).padStart(3, '0')}`;

/** 289 projetos com candidato: páginas = 81×1 + 128×2 + 60×3 + 20×4 = 597; candidatos = 5425. */
function pagesPlan(): number[] {
  return [...Array(81).fill(1), ...Array(128).fill(2), ...Array(60).fill(3), ...Array(20).fill(4)];
}

function candidatesPerProject(plan: number[]): number[] {
  // mínimo para ocupar `c` páginas = 12*(c-1)+1; o resto (1440) é distribuído até 11 por projeto
  const counts = plan.map((c) => 12 * (c - 1) + 1);
  let rest = 5425 - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; rest > 0; i = (i + 1) % counts.length) {
    const add = Math.min(11, rest);
    counts[i] += add;
    rest -= add;
  }
  return counts;
}

describe('SyncTalentumWorkersUseCase — custo medido no stub v2 (T3.4)', () => {
  let stub: TalentumV2Stub;
  let phoneSeq = 0;

  const mk = (profileId: string, qualified: boolean): StubCandidate => {
    phoneSeq += 1;
    return {
      profileId, firstName: 'Nome', lastName: 'Sintetico',
      phoneNumber: `11${String(30000000 + phoneSeq)}`,
      email: qualified ? `sint${phoneSeq}@example.test` : undefined,
      status: qualified ? 'qualified' : 'in_progress',
    };
  };

  beforeEach(() => {
    jest.spyOn(logger, 'info').mockImplementation();
    jest.spyOn(logger, 'error').mockImplementation();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    stub = new TalentumV2Stub();
    mockFake = new FakeWorkersDb();
    phoneSeq = 0;

    const sizes = candidatesPerProject(pagesPlan());
    let n = 0;
    // 317 IN_PROGRESS = 289 com candidato + 28 vazios; todos com vaga par
    for (let i = 0; i < 317; i++) {
      n++;
      const count = i < 289 ? sizes[i] : 0;
      stub.seed({
        _id: pid(n), name: `EN ${n}#1`, status: 'IN_PROGRESS', myRole: n <= 108 ? 'OWNER' : 'VIEWER',
        candidates: Array.from({ length: count }, (_, k) => mk(`pf-${n}-${k}`, k % 5 === 0)),
      });
      mockFake.vacancies.push({ id: `jp-${n}`, talentumProjectId: pid(n), caseNumber: n });
    }
    for (let i = 0; i < 150; i++) { n++; stub.seed({ _id: pid(n), name: `EN ${n}#1`, status: 'PAUSED', myRole: 'VIEWER' }); }
    n++; stub.seed({ _id: pid(n), name: `EN ${n}#1`, status: 'DRAFT', myRole: 'OWNER' });

    global.fetch = stub.asFetch();
    process.env.TALENTUM_API_EMAIL = 'stub-user-e2e-only';
    process.env.TALENTUM_API_PASSWORD = 'stub-key-e2e-only';
    process.env.TALENTUM_API_BASE_URL = 'http://stub.invalid';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  it('MEDIDO: 317 projetos IN_PROGRESS, 5425 candidatos → 625 requests de candidatos; PAUSED/DRAFT não são lidos', async () => {
    const report = await new SyncTalentumWorkersUseCase().execute();

    const candidateGets = stub.calls.filter((c) => c.path.endsWith('/prescreening/candidates')).length;
    const readyGets = stub.calls.filter((c) => c.path.endsWith('/ready-for-interview')).length;
    const listGets = stub.calls.filter((c) => c.method === 'GET' && c.path === '/projects').length;
    const touchedProjects = new Set(stub.calls.map((c) => /^\/projects\/([^/]+)\//.exec(c.path)?.[1]).filter(Boolean));
    // eslint-disable-next-line no-console
    process.stdout.write(
      `[MEDIDO T3.4] GETs: lista=${listGets} candidates=${candidateGets} ready-for-interview=${readyGets} ` +
      `total=${listGets + candidateGets + readyGets} (+1 login) | projetos lidos=${report.projects} ` +
      `candidatos=${report.total} workers criados=${report.created}\n`,
    );

    expect(report).toMatchObject({ projects: 317, projectsWithoutVacancy: 0, total: 5425, errors: [] });
    expect(candidateGets).toBe(625);            // = o número medido em prd (§P4.d)
    expect(listGets).toBe(39);                  // ceil(468/12)
    expect(touchedProjects.size).toBe(317);     // PAUSED (150) e DRAFT (1) nunca tocados
    expect(report.requests).toBe(candidateGets + readyGets);
    expect(readyGets).toBeGreaterThan(0);
    expect(readyGets).toBeLessThan(candidateGets); // só onde há qualificado
    expect(stub.calls.every((c) => c.method === 'GET' || c.path === '/auth/login')).toBe(true); // 0 escritas na Talentum
  });
});
