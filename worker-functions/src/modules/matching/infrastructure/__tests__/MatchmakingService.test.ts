/**
 * MatchmakingService — reescrito pelo PR #249 (remoção do ramo LLM/Groq) e, até
 * este teste, com 0% de cobertura. Cobre as três responsabilidades que sobraram:
 *
 *   1. `matchWorkersForJob` — defaults de `MatchOptions` e delegação ao único path
 *   2. `loadJob`            — mapeamento snake_case → domínio, e o "não encontrado"
 *   3. `saveMatchResults`   — a regra `matchScore = NULL` quando nada pontuou
 *
 * A regra do (3) é a que morde: com o scoring removido, `finalScore` é sempre 0.
 * Persistir 0 faria o dashboard ler "avaliado e deu zero" onde a verdade é "não
 * avaliado". O teste trava isso.
 */

const mockQuery = jest.fn();
const mockDecrypt = jest.fn();
const mockRunHardFilter = jest.fn();
const mockRunHardFilterOnlyPath = jest.fn();
const mockClientQuery = jest.fn();
const mockWithActorContext = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockDecrypt })),
}));
jest.mock('../MatchmakingHardFilterQuery', () => ({ runHardFilter: (...a: unknown[]) => mockRunHardFilter(...a) }));
jest.mock('../MatchmakingHardFilterPath', () => ({ runHardFilterOnlyPath: (...a: unknown[]) => mockRunHardFilterOnlyPath(...a) }));
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: (...a: unknown[]) => mockWithActorContext(...a),
}));
jest.mock('@shared/audit/actorSource', () => ({ systemActor: (n: string) => ({ source: 'system', name: n }) }));

import { MatchmakingService } from '../MatchmakingService';
import { ScoredCandidate } from '../MatchmakingTypes';

const JOB_ROW = {
  id: 'jp-1',
  worker_profile_sought: 'AT con experiencia',
  schedule_days_hours: 'L-V 8-16',
  is_test: false,
  service_lat: '-34.6037',
  service_lng: '-58.3816',
  required_sex: 'F',
  required_professions: ['AT'],
  diagnosis: 'REDIGIDO-NO-TESTE',
  patient_zone: 'Palermo',
};

function candidate(over: Partial<ScoredCandidate> = {}): ScoredCandidate {
  return {
    workerId: 'w-1', workerName: 'Ana', workerPhone: '+549', occupation: 'AT',
    workZone: 'Palermo', distanceKm: 3, activeCasesCount: 0, workerStatus: 'REGISTERED',
    registrationWarning: null, structuredScore: 0, llmScore: null, finalScore: 0,
    llmReasoning: null, llmRedFlags: [], llmStrengths: [], alreadyApplied: false,
    ...over,
  } as ScoredCandidate;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  mockQuery.mockResolvedValue({ rows: [JOB_ROW] });
  mockRunHardFilter.mockResolvedValue([]);
  mockRunHardFilterOnlyPath.mockResolvedValue({ jobPostingId: 'jp-1', radiusKm: 20, matchSummary: {}, candidates: [] });
  mockClientQuery.mockResolvedValue({ rows: [] });
  // executa o callback com um client falso, como o withActorContext real faz
  mockWithActorContext.mockImplementation(async (_pool, cb) => cb({ query: mockClientQuery }));
});

afterEach(() => jest.restoreAllMocks());

describe('matchWorkersForJob — defaults e delegação', () => {
  it('sem options: topN=20, raio default, sem exclusão, sem cadastro incompleto', async () => {
    await new MatchmakingService().matchWorkersForJob('jp-1');

    const [, , , radiusKm, excludeActive, includeIncomplete] = mockRunHardFilter.mock.calls[0];
    expect(excludeActive).toBe(false);
    expect(includeIncomplete).toBe(false);
    expect(typeof radiusKm).toBe('number');

    const [, , , , , topN] = mockRunHardFilterOnlyPath.mock.calls[0];
    expect(topN).toBe(20);
  });

  it('com options: cada valor chega ao hard filter e ao path', async () => {
    await new MatchmakingService().matchWorkersForJob('jp-1', {
      topN: 5, radiusKm: 33, excludeWithActiveCases: true, includeIncompleteRegister: true,
    });

    const [, , , radiusKm, excludeActive, includeIncomplete] = mockRunHardFilter.mock.calls[0];
    expect([radiusKm, excludeActive, includeIncomplete]).toEqual([33, true, true]);

    const [, jobPostingId, , , radiusNoPath, topN] = mockRunHardFilterOnlyPath.mock.calls[0];
    expect([jobPostingId, radiusNoPath, topN]).toEqual(['jp-1', 33, 5]);
  });

  it('delega para o hard filter path e devolve o resultado dele intacto', async () => {
    const esperado = { jobPostingId: 'jp-1', radiusKm: 20, matchSummary: { hardFilteredCount: 2, llmScoredCount: 0 }, candidates: [] };
    mockRunHardFilterOnlyPath.mockResolvedValue(esperado);

    const r = await new MatchmakingService().matchWorkersForJob('jp-1');

    expect(r).toBe(esperado);
    expect(mockRunHardFilterOnlyPath).toHaveBeenCalledTimes(1);
  });

  it('passa os candidatos do hard filter adiante, sem reordenar nem filtrar', async () => {
    const candidatos = [{ workerId: 'a' }, { workerId: 'b' }];
    mockRunHardFilter.mockResolvedValue(candidatos);

    await new MatchmakingService().matchWorkersForJob('jp-1');

    // índices: 0=deps 1=jobPostingId 2=job 3=candidates 4=radiusKm 5=topN
    expect(mockRunHardFilterOnlyPath.mock.calls[0][3]).toBe(candidatos);
  });
});

describe('loadJob', () => {
  it('mapeia snake_case do banco para o domínio, com lat/lng em número', async () => {
    await new MatchmakingService().matchWorkersForJob('jp-1');

    const job = mockRunHardFilter.mock.calls[0][2];
    expect(job).toMatchObject({
      id: 'jp-1',
      workerProfileSought: 'AT con experiencia',
      scheduleDaysHours: 'L-V 8-16',
      serviceLat: -34.6037,
      serviceLng: -58.3816,
      requiredSex: 'F',
      requiredProfessions: ['AT'],
      patientZone: 'Palermo',
    });
  });

  it('lat/lng ausentes viram null, não NaN', async () => {
    mockQuery.mockResolvedValue({ rows: [{ ...JOB_ROW, service_lat: null, service_lng: null }] });

    await new MatchmakingService().matchWorkersForJob('jp-1');

    const job = mockRunHardFilter.mock.calls[0][2];
    expect(job.serviceLat).toBeNull();
    expect(job.serviceLng).toBeNull();
  });

  it.each([
    ['array vazio', []],
    ['null', null],
  ])('required_professions %s vira null', async (_n, valor) => {
    mockQuery.mockResolvedValue({ rows: [{ ...JOB_ROW, required_professions: valor }] });

    await new MatchmakingService().matchWorkersForJob('jp-1');

    expect(mockRunHardFilter.mock.calls[0][2].requiredProfessions).toBeNull();
  });

  it('vaga inexistente: lança com o id na mensagem, e NÃO chama o hard filter', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(new MatchmakingService().matchWorkersForJob('jp-fantasma'))
      .rejects.toThrow('Job posting jp-fantasma não encontrado');
    expect(mockRunHardFilter).not.toHaveBeenCalled();
  });
});

describe('saveMatchResults — a regra do match_score NULL', () => {
  async function persistir(c: ScoredCandidate[]) {
    mockRunHardFilterOnlyPath.mockImplementation(async (deps: { saveMatchResults: (id: string, x: ScoredCandidate[]) => Promise<void> }) => {
      await deps.saveMatchResults('jp-1', c);
      return { jobPostingId: 'jp-1', radiusKm: 20, matchSummary: {}, candidates: c };
    });
    await new MatchmakingService().matchWorkersForJob('jp-1');
    return mockClientQuery.mock.calls;
  }

  it('nada pontuou (o caso de hoje): grava NULL, não 0 — "não avaliado" ≠ "avaliado zero"', async () => {
    const calls = await persistir([candidate()]);

    expect(calls[0][1][2]).toBeNull();
  });

  it('structuredScore diferente de 0: grava o finalScore', async () => {
    const calls = await persistir([candidate({ structuredScore: 70, finalScore: 70 })]);

    expect(calls[0][1][2]).toBe(70);
  });

  it('llmScore presente: grava o finalScore mesmo com structuredScore 0', async () => {
    const calls = await persistir([candidate({ llmScore: 80, finalScore: 80 })]);

    expect(calls[0][1][2]).toBe(80);
  });

  it('grava uma linha por candidato, com worker e vaga', async () => {
    const calls = await persistir([candidate({ workerId: 'w-1' }), candidate({ workerId: 'w-2' })]);

    expect(calls).toHaveLength(2);
    expect(calls.map(c => c[1][0])).toEqual(['w-1', 'w-2']);
    expect(calls.every(c => c[1][1] === 'jp-1')).toBe(true);
  });

  it('carimba a transação como rotina do sistema (senão a autoria vira desconhecida)', async () => {
    await persistir([candidate()]);

    expect(mockWithActorContext.mock.calls[0][2]).toEqual({ source: 'system', name: 'matchmaking' });
  });

  it('lista vazia: abre a transação e não escreve nada', async () => {
    const calls = await persistir([]);

    expect(calls).toHaveLength(0);
    expect(mockWithActorContext).toHaveBeenCalledTimes(1);
  });
});
