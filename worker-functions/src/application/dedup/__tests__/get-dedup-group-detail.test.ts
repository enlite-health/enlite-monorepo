/**
 * get-dedup-group-detail.test.ts
 *
 * Testes unitários de GetDedupGroupDetailUseCase.
 * Cobre: grupo não encontrado, workers inativos removidos,
 * buildFieldComparisons (values por account, conflict/no-conflict/encrypted/array),
 * buildReparentPreview (array entity→count, tabela com 0 linhas ignorada, erro ignorado),
 * tier classification, login_real, survivor_suggested.
 *
 * Contrato (PLURAL): field_comparisons + reparent_preview[] + survivor_suggested.
 */

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

jest.mock('../../../infrastructure/services/WorkerPhoneMergeFkDiscovery');

import type { Pool } from 'pg';
import { GetDedupGroupDetailUseCase } from '../GetDedupGroupDetailUseCase';
import { discoverWorkerFkTables } from '../../../infrastructure/services/WorkerPhoneMergeFkDiscovery';

const mockDiscoverFks = discoverWorkerFkTables as jest.MockedFunction<typeof discoverWorkerFkTables>;

const BASE_DATE = new Date('2026-01-01T00:00:00Z');

function makePool(responses: Array<{ rows: unknown[] }>): jest.Mocked<Pick<Pool, 'query'>> {
  let idx = 0;
  return {
    query: jest.fn().mockImplementation(() => {
      const resp = responses[idx++] ?? { rows: [] };
      return Promise.resolve(resp);
    }),
  } as unknown as jest.Mocked<Pick<Pool, 'query'>>;
}

const SURVIVOR_ID = 'cccccccc-0000-0000-0000-000000000001';
const ABSORBED_ID = 'cccccccc-0000-0000-0000-000000000002';
const PHONE_NORM  = '5491199990001';

beforeEach(() => {
  jest.clearAllMocks();
  mockDiscoverFks.mockResolvedValue([
    { table: 'worker_job_applications', fk_column: 'worker_id', strategy: 'upsert_delete', unique_cols: ['worker_id', 'job_posting_id'] },
    { table: 'worker_documents',        fk_column: 'worker_id', strategy: 'upsert_delete', unique_cols: ['worker_id'] },
    { table: 'encuadres',               fk_column: 'worker_id', strategy: 'update',        unique_cols: [] },
  ]);
});

function buildWorkerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: SURVIVOR_ID,
    email: 'survivor@example.com',
    auth_uid: 'FirebaseReal_abc123',
    status: 'REGISTERED',
    created_at: BASE_DATE,
    updated_at: BASE_DATE,
    profession: 'AT',
    country: 'AR',
    first_name_encrypted: null,
    last_name_encrypted: null,
    sex_encrypted: null,
    birth_date_encrypted: null,
    document_number_encrypted: null,
    languages_encrypted: null,
    knowledge_level: null,
    years_experience: null,
    data_sources: null,
    wja_count: 2,
    docs_count: 1,
    encuadres_count: 0,
    ...overrides,
  };
}

// ── Grupo não encontrado ──────────────────────────────────────────────────────

describe('GetDedupGroupDetailUseCase — grupo não encontrado', () => {
  it('retorna null quando não há colisão para o phone', async () => {
    const pool = makePool([{ rows: [] }]);
    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);
    expect(result).toBeNull();
  });

  it('retorna null quando todos os workers do grupo já foram mergeados', async () => {
    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [] },
    ]);
    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);
    expect(result).toBeNull();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('GetDedupGroupDetailUseCase — happy path', () => {
  it('retorna preview com accounts, field_comparisons, reparent_preview[], survivor_suggested', async () => {
    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({
      id: ABSORBED_ID,
      email: 'absorbed@enlite.import',
      auth_uid: 'base1import_abc',
      profession: null,
      wja_count: 0,
      docs_count: 0,
      encuadres_count: 1,
    });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '2' }] }, // wja
      { rows: [{ cnt: '1' }] }, // docs
      { rows: [{ cnt: '1' }] }, // encuadres
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result).not.toBeNull();
    expect(result!.phone_normalized).toBe(PHONE_NORM);
    expect(result!.accounts).toHaveLength(2);

    // reparent_preview agora é array entity→count
    expect(result!.reparent_preview).toEqual([
      { entity: 'worker_job_applications', count: 2 },
      { entity: 'worker_documents', count: 1 },
      { entity: 'encuadres', count: 1 },
    ]);

    // survivor_suggested: única conta tier1 (Firebase real) vence
    expect(result!.survivor_suggested).toBe(SURVIVOR_ID);
  });

  it('classifica tier corretamente: Firebase real = 1, import = 3', async () => {
    const survivorRow = buildWorkerRow({ auth_uid: 'FirebaseReal_xyz' });
    const absorbedRow = buildWorkerRow({
      id: ABSORBED_ID,
      email: 'abs@enlite.import',
      auth_uid: 'base1import_yyy',
    });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const survivor = result!.accounts.find(a => a.id === SURVIVOR_ID);
    const absorbed = result!.accounts.find(a => a.id === ABSORBED_ID);

    expect(survivor?.tier).toBe(1);
    expect(survivor?.login_real).toBe(true);
    expect(absorbed?.tier).toBe(3);
    expect(absorbed?.login_real).toBe(false);
  });
});

// ── field_comparisons ─────────────────────────────────────────────────────────

describe('GetDedupGroupDetailUseCase — field_comparisons', () => {
  it('detecta conflito e expõe values por account quando valores diferem', async () => {
    const survivorRow = buildWorkerRow({ profession: 'AT' });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_zz', profession: 'CUIDADOR' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const cmp = result!.field_comparisons.find(f => f.field === 'profession');
    expect(cmp?.has_conflict).toBe(true);
    expect(cmp?.is_encrypted).toBe(false);
    expect(cmp?.values[SURVIVOR_ID]).toBe('AT');
    expect(cmp?.values[ABSORBED_ID]).toBe('CUIDADOR');
  });

  it('sem conflito quando valores são iguais', async () => {
    const survivorRow = buildWorkerRow({ profession: 'AT' });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_qq', profession: 'AT' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const cmp = result!.field_comparisons.find(f => f.field === 'profession');
    expect(cmp?.has_conflict).toBe(false);
  });

  it('retorna [] quando há menos de 2 workers', async () => {
    const survivorRow = buildWorkerRow();

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID] }] },
      { rows: [survivorRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.field_comparisons).toEqual([]);
    // survivor_suggested ainda presente (única conta)
    expect(result!.survivor_suggested).toBe(SURVIVOR_ID);
  });

  it('campo só preenchido em uma conta → sem conflito, values null para a vazia', async () => {
    const survivorRow = buildWorkerRow({ profession: 'AT' });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_nonull', profession: null });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const cmp = result!.field_comparisons.find(f => f.field === 'profession');
    expect(cmp?.has_conflict).toBe(false);
    expect(cmp?.values[SURVIVOR_ID]).toBe('AT');
    expect(cmp?.values[ABSORBED_ID]).toBeNull();
  });

  it('ambos null → sem conflito, values null para ambos', async () => {
    const survivorRow = buildWorkerRow({ profession: null });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_bothnull', profession: null });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const cmp = result!.field_comparisons.find(f => f.field === 'profession');
    expect(cmp?.has_conflict).toBe(false);
    expect(cmp?.values[SURVIVOR_ID]).toBeNull();
    expect(cmp?.values[ABSORBED_ID]).toBeNull();
  });

  it('campo encriptado → is_encrypted=true MAS decriptado (endpoint admin-only); conflito sobre o plaintext', async () => {
    // KMSEncryptionService roda em passthrough (NODE_ENV=test): "ciphertext" = base64.
    const cipher = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const survivorRow = buildWorkerRow({ first_name_encrypted: cipher('Ana') });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_enc', first_name_encrypted: cipher('Maria') });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const enc = result!.field_comparisons.find(f => f.field === 'first_name_encrypted');
    // Continua marcado como sensível, mas agora COM o valor real decriptado.
    expect(enc?.is_encrypted).toBe(true);
    expect(enc?.values[SURVIVOR_ID]).toBe('Ana');
    expect(enc?.values[ABSORBED_ID]).toBe('Maria');
    // plaintext diverge → conflito detectado sobre o valor decriptado
    expect(enc?.has_conflict).toBe(true);
  });

  it('campo encriptado com mesmo plaintext → sem conflito (compara plaintext, não ciphertext)', async () => {
    const cipher = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const survivorRow = buildWorkerRow({ first_name_encrypted: cipher('Ana') });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_enc2', first_name_encrypted: cipher('Ana') });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const enc = result!.field_comparisons.find(f => f.field === 'first_name_encrypted');
    expect(enc?.values[SURVIVOR_ID]).toBe('Ana');
    expect(enc?.values[ABSORBED_ID]).toBe('Ana');
    expect(enc?.has_conflict).toBe(false);
  });

  it('erro de decrypt de 1 campo é gracioso → value null, não derruba o endpoint', async () => {
    const survivorRow = buildWorkerRow({ first_name_encrypted: 'cipher-ok' });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_err', first_name_encrypted: 'cipher-fail' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    // Serviço cujo decrypt lança pro ciphertext do absorbed.
    const flakyEncryption = {
      decrypt: jest.fn(async (ct: string | null | undefined) => {
        if (ct === 'cipher-fail') throw new Error('KMS decrypt boom');
        return ct ? Buffer.from(String(ct), 'utf8').toString('utf8') : '';
      }),
    } as unknown as import('@shared/security/KMSEncryptionService').KMSEncryptionService;

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool, flakyEncryption);
    const result = await useCase.execute(PHONE_NORM);

    const enc = result!.field_comparisons.find(f => f.field === 'first_name_encrypted');
    expect(enc?.values[SURVIVOR_ID]).toBe('cipher-ok');
    expect(enc?.values[ABSORBED_ID]).toBeNull(); // decrypt falhou → null gracioso
  });

  it('campo array (data_sources) é serializado como CSV em values', async () => {
    const survivorRow = buildWorkerRow({ data_sources: ['talentum', 'manual'] });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_arr', data_sources: ['talentum', 'manual'] });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const cmp = result!.field_comparisons.find(f => f.field === 'data_sources');
    expect(cmp?.values[SURVIVOR_ID]).toBe('talentum, manual');
    expect(cmp?.has_conflict).toBe(false);
  });
});

// ── account flags ─────────────────────────────────────────────────────────────

describe('GetDedupGroupDetailUseCase — account flags', () => {
  it('auth_uid null/vazio → tier 3, prefix "null"', async () => {
    const survivorWithNullUid = buildWorkerRow({ auth_uid: null, id: SURVIVOR_ID });
    const absorbedWithEmptyUid = buildWorkerRow({ auth_uid: '', id: ABSORBED_ID, email: 'a@e.com' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorWithNullUid, absorbedWithEmptyUid] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const sv = result!.accounts.find(a => a.id === SURVIVOR_ID);
    expect(sv?.tier).toBe(3);
    expect(sv?.auth_uid_prefix).toBe('null');
  });

  it('extractPrefix retorna "null" quando auth_uid é string vazia', async () => {
    const survivorEmptyUid = buildWorkerRow({ auth_uid: '' });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_ep' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorEmptyUid, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const sv = result!.accounts.find(a => a.id === SURVIVOR_ID);
    expect(sv?.auth_uid_prefix).toBe('null');
  });

  it('profession e country null → null nos accounts', async () => {
    const survivorNoProf = buildWorkerRow({ profession: null, country: null });
    const absorbedNoProf = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_pp', profession: null, country: null });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorNoProf, absorbedNoProf] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const sv = result!.accounts.find(a => a.id === SURVIVOR_ID);
    expect(sv?.profession).toBeNull();
    expect(sv?.country).toBeNull();
  });

  it('has_encrypted_pii=true quando algum campo encriptado está preenchido', async () => {
    const survivorWithPii = buildWorkerRow({ first_name_encrypted: 'ciphertext_here' });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_pii' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorWithPii, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const sv = result!.accounts.find(a => a.id === SURVIVOR_ID);
    expect(sv?.has_encrypted_pii).toBe(true);
  });
});

// ── reparent_preview[] ────────────────────────────────────────────────────────

describe('GetDedupGroupDetailUseCase — reparent_preview', () => {
  it('ignora tabelas com 0 linhas (array vazio)', async () => {
    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_rr' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.reparent_preview).toEqual([]);
  });

  it('captura tabelas arbitrárias com entity = nome da tabela', async () => {
    mockDiscoverFks.mockResolvedValue([
      { table: 'worker_job_applications', fk_column: 'worker_id', strategy: 'upsert_delete', unique_cols: [] },
      { table: 'some_other_table',        fk_column: 'worker_id', strategy: 'update',        unique_cols: [] },
    ]);

    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_ss' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '3' }] }, // wja
      { rows: [{ cnt: '5' }] }, // some_other_table
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.reparent_preview).toEqual([
      { entity: 'worker_job_applications', count: 3 },
      { entity: 'some_other_table', count: 5 },
    ]);
  });

  it('usa cnt=0 quando COUNT query retorna 0 rows (branch ?? 0) → entrada omitida', async () => {
    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_cnt0' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [] }, // wja: rows[0] undefined → 0 → omitido
      { rows: [] },
      { rows: [] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.reparent_preview).toEqual([]);
  });

  it('ignora erros de tabela (catch interno) sem lançar', async () => {
    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_tt' });

    let callIdx = 0;
    const poolWithError = {
      query: jest.fn().mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) return Promise.resolve({ rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] });
        if (callIdx === 2) return Promise.resolve({ rows: [survivorRow, absorbedRow] });
        return Promise.reject(new Error('relation "worker_job_applications" does not exist'));
      }),
    } as unknown as Pool;

    const useCase = new GetDedupGroupDetailUseCase(poolWithError);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.reparent_preview).toEqual([]);
  });
});

// ── survivor_suggested ────────────────────────────────────────────────────────

describe('GetDedupGroupDetailUseCase — survivor_suggested', () => {
  it('múltiplas contas tier1 → cai no critério de atividade (mais completo)', async () => {
    const ID3 = 'cccccccc-0003-0000-0000-000000000003';
    // Duas contas tier1 (Firebase real); a com mais atividade vence.
    const a = buildWorkerRow({ id: SURVIVOR_ID, auth_uid: 'FirebaseReal_a', wja_count: 1, docs_count: 0, encuadres_count: 0 });
    const b = buildWorkerRow({ id: ABSORBED_ID, email: 'b@e.com', auth_uid: 'FirebaseReal_b', wja_count: 5, docs_count: 2, encuadres_count: 1 });
    const c = buildWorkerRow({ id: ID3, email: 'c@enlite.import', auth_uid: 'base1import_c', wja_count: 0, docs_count: 0, encuadres_count: 0 });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID, ID3] }] },
      { rows: [a, b, c] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.survivor_suggested).toBe(ABSORBED_ID);
  });
});
