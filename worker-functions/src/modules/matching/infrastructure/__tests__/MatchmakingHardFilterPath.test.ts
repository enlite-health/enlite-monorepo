/**
 * MatchmakingHardFilterPath — o ÚNICO path do matching desde 23/08/2026.
 *
 * Antes deste PR ele era um dos dois ramos e tinha 0% de cobertura; ao virar o
 * único caminho, todo match de produção passa por aqui. Cobre:
 *   1. distância por haversine quando as 4 coordenadas existem
 *   2. distância null quando falta qualquer coordenada (vaga ou worker)
 *   3. ordenação ASC por distância, com os sem-coordenada NO FIM
 *   4. corte em topN, aplicado DEPOIS da ordenação
 *   5. montagem do nome (KMS), incluindo o caso first === last e o 'Sin nombre'
 *   6. os campos do contrato que hoje são constantes (llmScore, llmScoredCount…)
 *   7. hardFilteredCount conta os candidatos ANTES do corte
 */

import { runHardFilterOnlyPath, HardFilterPathDeps } from '../MatchmakingHardFilterPath';
import { JobPosting, WorkerCandidate } from '../MatchmakingTypes';

const CABA = { lat: -34.6037, lng: -58.3816 };
const LA_PLATA = { lat: -34.9215, lng: -57.9545 }; // 52,6 km de CABA (medido, não estimado)
const ROSARIO = { lat: -32.9442, lng: -60.6505 };  // ~280 km de CABA

function makeJob(over: Partial<JobPosting> = {}): JobPosting {
  return {
    serviceLat: CABA.lat,
    serviceLng: CABA.lng,
  } as unknown as JobPosting;
}

function makeWorker(over: Partial<WorkerCandidate> = {}): WorkerCandidate {
  return {
    workerId: 'w-1',
    firstNameEncrypted: 'enc:Ana',
    lastNameEncrypted: 'enc:Silva',
    phone: '+5491100000000',
    occupation: 'AT',
    workZone: 'Palermo',
    workerAddress: 'Av. Santa Fe 1000',
    workerLat: CABA.lat,
    workerLng: CABA.lng,
    activeCases: [],
    workerStatus: 'REGISTERED',
    alreadyApplied: false,
    ...over,
  } as unknown as WorkerCandidate;
}

function makeDeps(): HardFilterPathDeps & { saved: unknown[][] } {
  const saved: unknown[][] = [];
  return {
    saved,
    kms: {
      // devolve o que vem depois de "enc:" — sem KMS real no unit
      decrypt: jest.fn(async (v: string | null) => (v ? String(v).replace(/^enc:/, '') : null)),
    } as unknown as HardFilterPathDeps['kms'],
    saveMatchResults: jest.fn(async (_id: string, c: unknown[]) => {
      saved.push(c);
    }),
  };
}

describe('runHardFilterOnlyPath', () => {
  it('calcula a distância por haversine quando vaga e worker têm coordenada', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(
      deps, 'jp-1', makeJob(),
      [makeWorker({ workerLat: LA_PLATA.lat, workerLng: LA_PLATA.lng })],
      50, 20,
    );

    expect(r.candidates[0].distanceKm).toBeCloseTo(52.6, 1);
  });

  it.each([
    ['vaga sem coordenada', { serviceLat: null }, {}],
    ['worker sem coordenada', {}, { workerLat: null }],
    ['worker sem longitude', {}, { workerLng: null }],
    ['vaga sem longitude', { serviceLng: null }, {}],
  ])('distância é null quando falta coordenada — %s', async (_nome, jobOver, workerOver) => {
    const deps = makeDeps();
    const job = { ...makeJob(), ...jobOver } as JobPosting;
    const r = await runHardFilterOnlyPath(deps, 'jp-1', job, [makeWorker(workerOver)], 50, 20);

    expect(r.candidates[0].distanceKm).toBeNull();
  });

  it('ordena por distância ASC e joga os sem-coordenada para o FIM', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(
      deps, 'jp-1', makeJob(),
      [
        makeWorker({ workerId: 'sem-coord-1', workerLat: null, workerLng: null }),
        makeWorker({ workerId: 'rosario', workerLat: ROSARIO.lat, workerLng: ROSARIO.lng }),
        makeWorker({ workerId: 'sem-coord-2', workerLat: null, workerLng: null }),
        makeWorker({ workerId: 'la-plata', workerLat: LA_PLATA.lat, workerLng: LA_PLATA.lng }),
        makeWorker({ workerId: 'caba' }),
      ],
      50, 20,
    );

    expect(r.candidates.map(c => c.workerId).slice(0, 3)).toEqual(['caba', 'la-plata', 'rosario']);
    expect(r.candidates.slice(3).map(c => c.distanceKm)).toEqual([null, null]);
  });

  it('corta em topN DEPOIS de ordenar — o mais próximo sobrevive, não o primeiro da lista', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(
      deps, 'jp-1', makeJob(),
      [
        makeWorker({ workerId: 'longe', workerLat: ROSARIO.lat, workerLng: ROSARIO.lng }),
        makeWorker({ workerId: 'perto' }),
      ],
      50, 1,
    );

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].workerId).toBe('perto');
    // hardFilteredCount conta ANTES do corte
    expect(r.matchSummary.hardFilteredCount).toBe(2);
  });

  it.each([
    ['nome e sobrenome', 'enc:Ana', 'enc:Silva', 'Ana Silva'],
    ['first === last, não duplica', 'enc:Ana', 'enc:Ana', 'Ana'],
    ['só nome', 'enc:Ana', null, 'Ana'],
    ['só sobrenome', null, 'enc:Silva', 'Silva'],
    ['sem nenhum → Sin nombre', null, null, 'Sin nombre'],
  ])('monta o nome via KMS — %s', async (_nome, first, last, esperado) => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(
      deps, 'jp-1', makeJob(),
      [makeWorker({ firstNameEncrypted: first, lastNameEncrypted: last })],
      50, 20,
    );

    expect(r.candidates[0].workerName).toBe(esperado);
  });

  it('workZone cai para o endereço quando a zona é nula', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(
      deps, 'jp-1', makeJob(), [makeWorker({ workZone: null })], 50, 20,
    );

    expect(r.candidates[0].workZone).toBe('Av. Santa Fe 1000');
  });

  it.each([
    ['REGISTERED', null],
    ['INCOMPLETE_REGISTER', 'Cadastro incompleto — faltam dados ou documentos'],
    ['DISABLED', 'Worker desativado'],
    ['ESTADO_DESCONHECIDO', null],
    [null, null],
  ])('registrationWarning para status %s', async (status, esperado) => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(
      deps, 'jp-1', makeJob(), [makeWorker({ workerStatus: status })], 50, 20,
    );

    expect(r.candidates[0].registrationWarning).toBe(esperado);
  });

  // Estes campos são CONSTANTES desde a remoção do ramo LLM (PR #249). Ficaram no
  // contrato de propósito: já valiam exatamente isto antes, porque `useScoring`
  // tinha default false. O teste existe para que, se alguém reviver o scoring,
  // a mudança de contrato seja uma decisão VISÍVEL e não um efeito colateral.
  it('os campos do scoring removido são constantes no contrato', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(deps, 'jp-1', makeJob(), [makeWorker()], 50, 20);

    expect(r.candidates[0]).toMatchObject({
      structuredScore: 0,
      finalScore: 0,
      llmScore: null,
      llmReasoning: null,
      llmRedFlags: [],
      llmStrengths: [],
    });
    expect(r.matchSummary.llmScoredCount).toBe(0);
  });

  it('persiste o resultado e devolve jobPostingId e radiusKm', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(deps, 'jp-42', makeJob(), [makeWorker()], 33, 20);

    expect(deps.saveMatchResults).toHaveBeenCalledWith('jp-42', r.candidates);
    expect(r.jobPostingId).toBe('jp-42');
    expect(r.radiusKm).toBe(33);
  });

  it('lista vazia: devolve zero candidatos e ainda assim persiste', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(deps, 'jp-1', makeJob(), [], 50, 20);

    expect(r.candidates).toEqual([]);
    expect(r.matchSummary.hardFilteredCount).toBe(0);
    expect(deps.saveMatchResults).toHaveBeenCalledWith('jp-1', []);
  });

  it('arredonda a distância para uma casa decimal', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(
      deps, 'jp-1', makeJob(),
      [makeWorker({ workerLat: LA_PLATA.lat, workerLng: LA_PLATA.lng })],
      50, 20,
    );

    const d = r.candidates[0].distanceKm as number;
    expect(d).toBe(Math.round(d * 10) / 10);
  });

  it('activeCasesCount reflete os casos ativos do worker', async () => {
    const deps = makeDeps();
    const r = await runHardFilterOnlyPath(
      deps, 'jp-1', makeJob(),
      [makeWorker({ activeCases: [{ case_number: 1 }, { case_number: 2 }] as never })],
      50, 20,
    );

    expect(r.candidates[0].activeCasesCount).toBe(2);
  });
});
