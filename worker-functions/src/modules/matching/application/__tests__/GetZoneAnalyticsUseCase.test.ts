import { GetZoneAnalyticsUseCase } from '../GetZoneAnalyticsUseCase';
import { zoneAnalyticsSchema } from '../zoneAnalyticsSchema';
import { BlindIndexService } from '@shared/security/BlindIndexService';
import { normalizeSexValue } from '@shared/utils/normalizeSexValue';

/**
 * "Zona" = PROVÍNCIA canônica (decisão do user, 2026-07-13 — ver docstring de
 * @shared/utils/zoneKey). Bairro/localidade NÃO entra mais na chave nem no
 * rótulo: worker com áreas em bairros diferentes da MESMA província conta
 * como 1 zona; o que fragmenta é a província, não a cidade.
 *
 * Ordem das 2 queries (Promise.all, invocação síncrona em ordem de array):
 *   1. job_postings LEFT JOIN patient_addresses — 1 linha por job_posting
 *      (grão de ID, não pré-agregada — dedup de patient_id acontece em JS via
 *      Set, ver GetZoneAnalyticsUseCase). Filtro por jp.required_professions
 *      — NÃO llm_required_profession, dropada da tabela em migration 082.
 *   2. workers LEFT JOIN worker_service_areas — 1 linha por (worker, área);
 *      worker sem NENHUMA área ainda aparece 1x (state/city null → "Não
 *      informado"), worker com N áreas aparece N vezes (dedup por Set de id).
 *
 * BlindIndexService NÃO é mockado: em NODE_ENV=test (jest) ele usa uma chave
 * fixa determinística (TEST_KEY) e não faz nenhuma chamada de rede/Secret
 * Manager — não é uma fronteira externa, é computação pura. O único mock
 * permitido é db.query. Os fixtures de sex_bidx usam o MESMO SSOT do
 * write-path (normalizeSexValue → 'MALE'/'FEMALE') antes de gerar o HMAC.
 */
interface PatientDemandRow {
  patient_id: string | null;
  state: string | null;
  city: string | null;
  status: string;
}

interface WorkerZoneRow {
  id: string;
  state: string | null;
  city: string | null;
  sex_bidx: Buffer | null;
  status: string;
}

function mockDb(
  patientRows: PatientDemandRow[],
  workerRows: WorkerZoneRow[],
): { query: jest.Mock } {
  const query = jest
    .fn()
    .mockResolvedValueOnce({ rows: patientRows })
    .mockResolvedValueOnce({ rows: workerRows });
  return { query };
}

describe('GetZoneAnalyticsUseCase', () => {
  let maleBidx: Buffer;
  let femaleBidx: Buffer;

  beforeAll(async () => {
    const bidx = new BlindIndexService();
    maleBidx = (await bidx.generateValueBidx(normalizeSexValue('male'))) as Buffer;
    femaleBidx = (await bidx.generateValueBidx(normalizeSexValue('female'))) as Buffer;
  });

  it('agrega pacientes, prestadores por sexo, demanda e disponibilidade por PROVÍNCIA', async () => {
    const db = mockDb(
      [
        { patient_id: 'p1', state: 'CABA', city: 'Palermo', status: 'SEARCHING' },
        { patient_id: 'p2', state: 'Provincia de Buenos Aires', city: 'Lanús', status: 'CLOSED' },
      ],
      [
        { id: 'w1', state: 'CABA', city: 'Palermo', sex_bidx: maleBidx, status: 'REGISTERED' },
        // w2 está num bairro DIFERENTE (Flores) mas MESMA província — deve
        // ficar na mesma zona "CABA" que w1 (city não fragmenta mais a zona).
        { id: 'w2', state: 'CABA', city: 'Flores', sex_bidx: femaleBidx, status: 'REGISTERED' },
        { id: 'w3', state: 'CABA', city: 'Palermo', sex_bidx: femaleBidx, status: 'REGISTERED' },
        { id: 'w4', state: 'Provincia de Buenos Aires', city: 'Lanús', sex_bidx: maleBidx, status: 'INCOMPLETE_REGISTER' },
      ],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toEqual([
      // ordenado por demand desc: CABA (1) antes de Provincia de Buenos Aires (0)
      {
        zone: 'CABA',
        patients: 1,
        workersMale: 1,
        workersFemale: 2,
        demand: 1,
        availability: 3, // w1, w2, w3 são REGISTERED
      },
      {
        zone: 'Provincia de Buenos Aires',
        patients: 1,
        workersMale: 1,
        workersFemale: 0,
        demand: 0,
        availability: 0, // w4 é INCOMPLETE_REGISTER — não conta em availability
      },
    ]);
    expect(result.unresolvedCount).toBe(0);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('dedupa paciente com N vagas na mesma província (não conta 2x)', async () => {
    const db = mockDb(
      [
        { patient_id: 'p1', state: 'CABA', city: 'Palermo', status: 'SEARCHING' },
        { patient_id: 'p1', state: 'CABA', city: 'Belgrano', status: 'CLOSED' }, // outro bairro, mesma província
      ],
      [],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toEqual([
      { zone: 'CABA', patients: 1, workersMale: 0, workersFemale: 0, demand: 1, availability: 0 },
    ]);
  });

  it('dedupa worker com N worker_service_areas na mesma província canônica (CABA vs Capital Federal, bairros diferentes)', async () => {
    const db = mockDb(
      [],
      [
        { id: 'w1', state: 'CABA', city: 'Palermo', sex_bidx: maleBidx, status: 'REGISTERED' },
        { id: 'w1', state: 'Capital Federal', city: 'Villa Crespo', sex_bidx: maleBidx, status: 'REGISTERED' },
      ],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toEqual([
      { zone: 'CABA', patients: 0, workersMale: 1, workersFemale: 0, demand: 0, availability: 1 },
    ]);
  });

  it('agrega localidades diferentes na MESMA província juntas — bairro não fragmenta mais a zona', async () => {
    const db = mockDb(
      [
        { patient_id: 'p1', state: 'Provincia de Buenos Aires', city: 'Lanús', status: 'SEARCHING' },
        { patient_id: 'p2', state: 'Provincia de Buenos Aires', city: 'San Isidro', status: 'SEARCHING' },
      ],
      [],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toHaveLength(1);
    expect(result.zones[0].zone).toBe('Provincia de Buenos Aires');
    expect(result.zones[0].patients).toBe(2);
    expect(result.zones[0].demand).toBe(2);
  });

  it('worker sem NENHUMA worker_service_areas (LEFT JOIN) cai em "Não informado", não some', async () => {
    const db = mockDb(
      [],
      [{ id: 'w1', state: null, city: null, sex_bidx: maleBidx, status: 'REGISTERED' }],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toEqual([
      { zone: 'Não informado', patients: 0, workersMale: 1, workersFemale: 0, demand: 0, availability: 1 },
    ]);
    expect(result.unresolvedCount).toBe(1);
  });

  it('agrupa zonas não resolvidas (state nulo, mesmo com city presente) no bucket "Não informado"', async () => {
    const db = mockDb(
      [
        { patient_id: 'p1', state: null, city: 'CABA', status: 'SEARCHING' },
        { patient_id: 'p2', state: null, city: null, status: 'SEARCHING' },
      ],
      [{ id: 'w1', state: null, city: null, sex_bidx: femaleBidx, status: 'REGISTERED' }],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toEqual([
      {
        zone: 'Não informado',
        patients: 2,
        workersMale: 0,
        workersFemale: 1,
        demand: 2,
        availability: 1,
      },
    ]);
    // patients (2) + workersMale (0) + workersFemale (1) da linha "Não informado"
    expect(result.unresolvedCount).toBe(3);
  });

  it('cai em "Não informado" quando a província resolvida é lixo (CPA postal, ex. "B1748 AEJ")', async () => {
    const db = mockDb(
      [{ patient_id: 'p1', state: 'B1748 AEJ', city: null, status: 'SEARCHING' }],
      [{ id: 'w1', state: 'B1748 AEJ', city: null, sex_bidx: maleBidx, status: 'REGISTERED' }],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toEqual([
      { zone: 'Não informado', patients: 1, workersMale: 1, workersFemale: 0, demand: 1, availability: 1 },
    ]);
    expect(result.unresolvedCount).toBe(2);
  });

  it('sex_bidx nulo/desconhecido não entra em workersMale nem workersFemale, mas conta em availability', async () => {
    const db = mockDb(
      [],
      [
        { id: 'w1', state: 'CABA', city: 'Palermo', sex_bidx: null, status: 'REGISTERED' },
        { id: 'w2', state: 'CABA', city: 'Palermo', sex_bidx: Buffer.from('garbage'), status: 'REGISTERED' },
      ],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toEqual([
      { zone: 'CABA', patients: 0, workersMale: 0, workersFemale: 0, demand: 0, availability: 2 },
    ]);
  });

  it('funde patient-zone e worker-zone quando a mesma província vem de ambas queries', async () => {
    const db = mockDb(
      [{ patient_id: 'p1', state: 'CABA', city: 'Palermo', status: 'SEARCHING' }],
      [{ id: 'w1', state: 'CABA', city: 'Recoleta', sex_bidx: maleBidx, status: 'REGISTERED' }],
    );

    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result.zones).toHaveLength(1);
    expect(result.zones[0]).toEqual({
      zone: 'CABA',
      patients: 1,
      workersMale: 1,
      workersFemale: 0,
      demand: 1,
      availability: 1,
    });
  });

  it('repassa o filtro de profession como param único para as duas queries', async () => {
    const db = mockDb([], []);
    const useCase = new GetZoneAnalyticsUseCase(db as never);
    await useCase.execute({ profession: 'AT' });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query.mock.calls[0][1]).toEqual(['AT']);
    expect(db.query.mock.calls[1][1]).toEqual(['AT']);
  });

  it('sem filtro de profession, passa null (não aplica filtro no SQL)', async () => {
    const db = mockDb([], []);
    const useCase = new GetZoneAnalyticsUseCase(db as never);
    await useCase.execute();

    expect(db.query.mock.calls[0][1]).toEqual([null]);
    expect(db.query.mock.calls[1][1]).toEqual([null]);
  });

  it('retorna vazio quando as duas queries não têm linhas', async () => {
    const db = mockDb([], []);
    const useCase = new GetZoneAnalyticsUseCase(db as never);
    const result = await useCase.execute();

    expect(result).toEqual({ zones: [], unresolvedCount: 0 });
  });

  it('contrato Zod rejeita shape inválido (defesa em profundidade) — teste direto do schema, pois patients/demand/etc. agora vêm de Set.size (sempre >= 0) e não são mais forçáveis a negativo via mock de db.query', () => {
    expect(() =>
      zoneAnalyticsSchema.parse({ zones: [{ zone: '', patients: -1 }], unresolvedCount: 0 }),
    ).toThrow();
  });
});
