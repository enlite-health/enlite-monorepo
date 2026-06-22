/**
 * get-dedup-group-detail.test.ts
 *
 * Testes unitários de GetDedupGroupDetailUseCase.
 * Cobre: grupo não encontrado, workers inativos removidos,
 * buildFieldComparisons (conflict/no-conflict/encrypted),
 * buildReparentPreview (múltiplas tabelas, tabela sem worker_id ignorada),
 * tier classification, login_real.
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
  // Por padrão, discovery retorna 3 tabelas
  mockDiscoverFks.mockResolvedValue([
    { table: 'worker_job_applications', fk_column: 'worker_id', strategy: 'upsert_delete', unique_cols: ['worker_id', 'job_posting_id'] },
    { table: 'worker_documents',        fk_column: 'worker_id', strategy: 'upsert_delete', unique_cols: ['worker_id'] },
    { table: 'encuadres',               fk_column: 'worker_id', strategy: 'update',        unique_cols: [] },
  ]);
});

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
      // collision exists
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      // workers query retorna vazio (todos merged_into_id != null)
      { rows: [] },
    ]);
    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);
    expect(result).toBeNull();
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('GetDedupGroupDetailUseCase — happy path', () => {
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

  it('retorna preview com accounts, field_comparison, reparent_preview', async () => {
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
      // collision
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      // workers
      { rows: [survivorRow, absorbedRow] },
      // reparent preview: wja
      { rows: [{ cnt: '2' }] },
      // reparent preview: docs
      { rows: [{ cnt: '1' }] },
      // reparent preview: encuadres
      { rows: [{ cnt: '1' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result).not.toBeNull();
    expect(result!.phone_normalized).toBe(PHONE_NORM);
    expect(result!.accounts).toHaveLength(2);
    expect(result!.reparent_preview.wja_total).toBe(2);
    expect(result!.reparent_preview.docs_total).toBe(1);
    expect(result!.reparent_preview.encuadres_total).toBe(1);
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

  it('field_comparison detecta conflito quando ambos têm valor diferente', async () => {
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

    const professionCmp = result!.field_comparison.find(f => f.field === 'profession');
    expect(professionCmp?.conflict).toBe(true);
    expect(professionCmp?.survivor_has_value).toBe(true);
    expect(professionCmp?.absorbed_has_value).toBe(true);
  });

  it('field_comparison sem conflito quando valores são iguais', async () => {
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

    const professionCmp = result!.field_comparison.find(f => f.field === 'profession');
    expect(professionCmp?.conflict).toBe(false);
  });

  it('field_comparison retorna [] quando há menos de 2 workers', async () => {
    // Apenas 1 worker ativo retornado (o outro já foi mergeado e filtrado)
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

    // Com apenas 1 conta, field_comparison fica vazia
    expect(result!.field_comparison).toEqual([]);
  });

  it('reparent_preview ignora tabelas com 0 linhas', async () => {
    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_rr' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      // wja: 0
      { rows: [{ cnt: '0' }] },
      // docs: 0
      { rows: [{ cnt: '0' }] },
      // encuadres: 0
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.reparent_preview.wja_total).toBe(0);
    expect(result!.reparent_preview.docs_total).toBe(0);
    expect(result!.reparent_preview.encuadres_total).toBe(0);
    expect(result!.reparent_preview.other_fk_tables).toEqual([]);
  });

  it('reparent_preview captura tabelas desconhecidas em other_fk_tables', async () => {
    mockDiscoverFks.mockResolvedValue([
      { table: 'worker_job_applications', fk_column: 'worker_id', strategy: 'upsert_delete', unique_cols: [] },
      { table: 'some_other_table',        fk_column: 'worker_id', strategy: 'update',        unique_cols: [] },
    ]);

    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_ss' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      // wja: 3
      { rows: [{ cnt: '3' }] },
      // some_other_table: 5
      { rows: [{ cnt: '5' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.reparent_preview.wja_total).toBe(3);
    expect(result!.reparent_preview.other_fk_tables).toContain('some_other_table:5');
  });

  it('auth_uid null/vazio → tier 3, prefix "null" (branches ?? "" e isSyntheticUid)', async () => {
    // auth_uid null → String(null ?? '') = '' → isSyntheticUid('') retorna true (trim() === '')
    // extractPrefix('') → 'null' (falsy check na linha 192)
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
    expect(sv?.tier).toBe(3);    // auth_uid null → sintético → tier 3
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

  it('field_comparison marca is_encrypted=true para campos encriptados', async () => {
    const survivorRow = buildWorkerRow({ first_name_encrypted: 'cipher1' });
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_enc', first_name_encrypted: 'cipher2' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const encField = result!.field_comparison.find(f => f.field === 'first_name_encrypted');
    expect(encField?.is_encrypted).toBe(true);
  });

  it('extractPrefix retorna "null" quando auth_uid é string vazia (branch linha 192)', async () => {
    // auth_uid vazio após String(null ?? '') → extractPrefix('') → !authUid → 'null'
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

  it('reparent_preview usa cnt=0 quando query retorna 0 rows (branch ?? 0, linha 136)', async () => {
    // Simula COUNT query retornando 0 rows (rows[0] = undefined → ?? 0)
    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_cnt0' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] },
      { rows: [survivorRow, absorbedRow] },
      // COUNT query retorna 0 rows ao invés de [{ cnt: '0' }]
      { rows: [] },  // wja: rows[0] = undefined → cnt ?? 0 = 0
      { rows: [] },  // docs
      { rows: [] },  // encuadres
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.reparent_preview.wja_total).toBe(0);
  });

  it('field_comparison: nonNull.length <= 1 → sem conflito (branch linha 170 false)', async () => {
    // survivor tem valor, absorbed não tem → nonNull = [val1] → length = 1 → sem conflito
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

    const profCmp = result!.field_comparison.find(f => f.field === 'profession');
    // nonNull = ['AT'] → length = 1 → hasConflict = false
    expect(profCmp?.conflict).toBe(false);
    expect(profCmp?.survivor_has_value).toBe(true);
    expect(profCmp?.absorbed_has_value).toBe(false);
  });

  it('field_comparison: 3 workers, 2 com valor igual e 1 null — branch v??"" linha 170', async () => {
    // 3 workers: survivor=AT, absorbed1=AT, absorbed2=null
    // allVals = ['AT', 'AT', null]
    // nonNull = ['AT', 'AT'] → length=2 > 1 → allVals.every invocado com null presente
    // → v ?? '' branch false (null → '') → String('') === String('AT') → false → every=false
    // → hasConflict = true && !false = true... mas wait: allVals[2]='AT' === allVals[0]='AT'? No.
    // Actually: allVals.every(v => String(v??'') === String(firstVal??''))
    // v=null → String(null??'')='' ≠ String('AT') → every=false → hasConflict=true
    const ID4 = 'cccccccc-0004-0000-0000-000000000004';
    const survivorRow = buildWorkerRow({ id: SURVIVOR_ID, auth_uid: 'FirebaseReal_3w', profession: 'AT' });
    const absorbed1Row = buildWorkerRow({ id: ABSORBED_ID, email: 'ab1@e.com', auth_uid: 'FirebaseAbs_3wa', profession: 'AT' });
    const absorbed2Row = buildWorkerRow({ id: ID4, email: 'ab2@e.com', auth_uid: 'base1import_3wb', profession: null });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID, ID4] }] },
      { rows: [survivorRow, absorbed1Row, absorbed2Row] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    expect(result!.accounts).toHaveLength(3);
    const profCmp = result!.field_comparison.find(f => f.field === 'profession');
    // allVals = ['AT', 'AT', null] → every(v=null → v??'' = '' ≠ 'AT') → false → hasConflict=true
    expect(profCmp?.conflict).toBe(true);
  });

  it('field_comparison: 3 workers, todos com mesmo valor não-null — every=true → sem conflito (branch firstVal??"")', async () => {
    // allVals = ['AT', 'AT', 'AT'] — firstVal ?? '' → firstVal='AT' (non-nullish branch)
    const ID5 = 'cccccccc-0005-0000-0000-000000000005';
    const survivorRow = buildWorkerRow({ id: SURVIVOR_ID, auth_uid: 'FirebaseReal_3vs', profession: 'AT' });
    const absorbed1Row = buildWorkerRow({ id: ABSORBED_ID, email: 'ab1s@e.com', auth_uid: 'FirebaseAbs_3vb', profession: 'AT' });
    const absorbed2Row = buildWorkerRow({ id: ID5, email: 'ab2s@e.com', auth_uid: 'base1import_3vc', profession: 'AT' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID, ID5] }] },
      { rows: [survivorRow, absorbed1Row, absorbed2Row] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const profCmp = result!.field_comparison.find(f => f.field === 'profession');
    // allVals = ['AT','AT','AT'] → every → true → hasConflict = true && !true = false
    expect(profCmp?.conflict).toBe(false);
  });

  it('field_comparison: survivor=null, 2 absorbed com valor → firstVal??""="" branch (col 93)', async () => {
    // firstVal=null, absorbed1='AT', absorbed2='CUIDADOR'
    // nonNull = ['AT','CUIDADOR'] → length=2 > 1
    // allVals.every: v='AT' → String('AT')===String(null??'')=''? 'AT'≠'' → false → every=false
    // firstVal??'' hits the '' branch (firstVal is null)
    // hasConflict = true && !false = true
    const ID6 = 'cccccccc-0006-0000-0000-000000000006';
    const survivorRow = buildWorkerRow({ id: SURVIVOR_ID, auth_uid: 'FirebaseReal_sv0', profession: null });
    const absorbed1Row = buildWorkerRow({ id: ABSORBED_ID, email: 'ab1x@e.com', auth_uid: 'FirebaseAbs_ab1', profession: 'AT' });
    const absorbed2Row = buildWorkerRow({ id: ID6, email: 'ab2x@e.com', auth_uid: 'FirebaseAbs_ab2', profession: 'CUIDADOR' });

    const pool = makePool([
      { rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID, ID6] }] },
      { rows: [survivorRow, absorbed1Row, absorbed2Row] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
      { rows: [{ cnt: '0' }] },
    ]);

    const useCase = new GetDedupGroupDetailUseCase(pool as unknown as Pool);
    const result = await useCase.execute(PHONE_NORM);

    const profCmp = result!.field_comparison.find(f => f.field === 'profession');
    // nonNull = ['AT', 'CUIDADOR'], firstVal=null → firstVal??''='' → every fails → hasConflict=true
    expect(profCmp?.conflict).toBe(true);
    expect(profCmp?.survivor_has_value).toBe(false);
    expect(profCmp?.absorbed_has_value).toBe(true);
  });

  it('field_comparison: ambos têm null (String(null ?? "") = "" branch dentro linha 170)', async () => {
    // firstVal = null, otherVals[0] = null
    // allVals.every(v => String(v ?? '') === String(null ?? '')) → String(null ?? '') = '' === ''
    // nonNull = [] → length = 0 → hasConflict = false
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

    const profCmp = result!.field_comparison.find(f => f.field === 'profession');
    expect(profCmp?.conflict).toBe(false);
    expect(profCmp?.survivor_has_value).toBe(false);
    expect(profCmp?.absorbed_has_value).toBe(false);
  });

  it('reparent_preview ignora erros de tabela (catch interno)', async () => {
    // Simula tabela que lança erro ao ser consultada
    const survivorRow = buildWorkerRow();
    const absorbedRow = buildWorkerRow({ id: ABSORBED_ID, email: 'a@e.com', auth_uid: 'FirebaseAbs_tt' });

    let callIdx = 0;
    const poolWithError = {
      query: jest.fn().mockImplementation((sql: string) => {
        callIdx++;
        if (callIdx === 1) {
          // collision
          return Promise.resolve({ rows: [{ worker_ids: [SURVIVOR_ID, ABSORBED_ID] }] });
        }
        if (callIdx === 2) {
          // workers
          return Promise.resolve({ rows: [survivorRow, absorbedRow] });
        }
        // reparent preview — lança para simular tabela não existente
        return Promise.reject(new Error(`relation "worker_job_applications" does not exist`));
      }),
    } as unknown as Pool;

    const useCase = new GetDedupGroupDetailUseCase(poolWithError);
    const result = await useCase.execute(PHONE_NORM);

    // Não deve lançar; reparent_preview fica zerado
    expect(result!.reparent_preview.wja_total).toBe(0);
  });
});
