/**
 * MirrorWorkerService.test.ts
 *
 * Cobre os cenários principais de mirrorOne:
 *   1. Cria worker (POST) quando status=REGISTERED + mínimo presente e sem ana_care_id
 *   2. Atualiza worker (PATCH) quando ana_care_id já preenchido e REGISTERED
 *   3. Skip quando campos obrigatórios faltam (firstName/lastName/sex)
 *   4. Skip quando status≠REGISTERED (ex: INCOMPLETE_REGISTER)
 *   5. Deactivate quando ana_care_status='Baja' e tem ana_care_id
 *   6. Worker não encontrado → 'skipped'
 *   7. Erro de API → persistError + rethrow
 */

// ── Mocks (antes dos imports) ─────────────────────────────────────

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

const mockDecrypt = jest.fn();
const mockEncrypt = jest.fn();

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: mockDecrypt,
    encrypt: mockEncrypt,
  })),
}));

jest.mock('@shared/utils/normalizeSexValue', () => ({
  normalizeSexValue: jest.fn((v: string | null) => {
    if (v === 'enc-MALE' || v === 'MALE' || v === 'male') return 'MALE';
    if (v === 'enc-FEMALE' || v === 'FEMALE' || v === 'female') return 'FEMALE';
    return null;
  }),
}));

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  reportError: (...args: unknown[]) => mockReportError(...args),
  loggingAls: { getStore: jest.fn().mockReturnValue(null) },
}));

// ── Imports ───────────────────────────────────────────────────────

import { MirrorWorkerService, isAnaCareIdClaimed } from '../MirrorWorkerService';
import type { WorkerMirrorProvider, WorkerMirrorUpsertResult } from '../../domain/WorkerMirrorProvider';
import type { WorkerMirrorRecord } from '../../domain/WorkerMirrorRecord';

// ── Fake provider ─────────────────────────────────────────────────

function makeFakeProvider(overrides: Partial<WorkerMirrorProvider> = {}): WorkerMirrorProvider {
  return {
    name: 'fake',
    upsert: jest.fn().mockResolvedValue({ externalId: '42' } as WorkerMirrorUpsertResult),
    deactivate: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ── DB row helpers ────────────────────────────────────────────────

interface RowOverrides {
  id?: string;
  email?: string;
  phone?: string | null;
  status?: string;
  profession?: string | null;
  occupation?: string | null;
  ana_care_id?: string | null;
  ana_care_status?: string | null;
  is_test?: boolean;
  first_name_encrypted?: string | null;
  last_name_encrypted?: string | null;
  sex_encrypted?: string | null;
  birth_date_encrypted?: string | null;
  document_number_encrypted?: string | null;
  sa_address_line?: string | null;
  sa_city?: string | null;
  sa_state?: string | null;
  sa_neighborhood?: string | null;
  sa_postal_code?: string | null;
}

function makeRow(overrides: RowOverrides = {}) {
  return {
    id: 'worker-uuid-1',
    email: 'test@example.com',
    phone: '5491100000001',
    status: 'REGISTERED',
    profession: 'AT',
    occupation: 'AT',
    ana_care_id: null,
    ana_care_status: null,
    is_test: false,
    first_name_encrypted: 'enc-fn',
    last_name_encrypted: 'enc-ln',
    sex_encrypted: 'enc-MALE',
    birth_date_encrypted: 'enc-bd',
    document_number_encrypted: 'enc-doc',
    sa_address_line: 'Av Test 123',
    sa_city: 'CABA',
    sa_state: 'BA',
    sa_neighborhood: 'Palermo',
    sa_postal_code: 'C1425',
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function setupDecrypt(
  firstName = 'Juan',
  lastName = 'Pérez',
  sex = 'MALE',
  birthDate = '1990-01-01',
  docNumber = '12345678',
) {
  mockDecrypt.mockImplementation((value: string) => {
    if (value === 'enc-fn') return Promise.resolve(firstName);
    if (value === 'enc-ln') return Promise.resolve(lastName);
    if (value === 'enc-MALE') return Promise.resolve(sex);
    if (value === 'enc-bd') return Promise.resolve(birthDate);
    if (value === 'enc-doc') return Promise.resolve(docNumber);
    return Promise.resolve(null);
  });
}

function setupFetchWorker(row: ReturnType<typeof makeRow> | null) {
  mockQuery.mockImplementation((sql: string) => {
    if (sql.includes('FROM workers w')) {
      return Promise.resolve({ rows: row ? [row] : [] });
    }
    // persistSuccess / persistError UPDATE
    return Promise.resolve({ rows: [] });
  });
}

// ── Suite ─────────────────────────────────────────────────────────

describe('MirrorWorkerService.mirrorOne', () => {
  const WORKER_ID = 'worker-uuid-1';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ─────────────────────────────────────────────
  // 1. Cria worker (POST) — mínimo presente, sem ana_care_id
  // ─────────────────────────────────────────────

  it('retorna "created" e chama upsert(record, null) quando worker sem ana_care_id', async () => {
    const row = makeRow({ ana_care_id: null });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('created');
    expect(provider.upsert).toHaveBeenCalledTimes(1);
    const [passedRecord, passedExternalId] = (provider.upsert as jest.Mock).mock.calls[0] as [WorkerMirrorRecord, string | null];
    expect(passedExternalId).toBeNull();
    expect(passedRecord.firstName).toBe('Juan');
    expect(passedRecord.lastName).toBe('Pérez');
    expect(passedRecord.sex).toBe('MALE');
    expect(passedRecord.email).toBe('test@example.com');
    // persistSuccess deve ser chamado
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET ana_care_id'),
      expect.arrayContaining([WORKER_ID, '42']),
    );
  });

  // ─────────────────────────────────────────────
  // 2. Atualiza worker (PATCH) — ana_care_id já preenchido
  // ─────────────────────────────────────────────

  it('retorna "updated" e chama upsert(record, externalId) quando ana_care_id existe', async () => {
    const row = makeRow({ ana_care_id: '99' });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider({
      upsert: jest.fn().mockResolvedValue({ externalId: '99' }),
    });
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('updated');
    const [, passedExternalId] = (provider.upsert as jest.Mock).mock.calls[0] as [WorkerMirrorRecord, string | null];
    expect(passedExternalId).toBe('99');
  });

  // ─────────────────────────────────────────────
  // 3. Skip — campos obrigatórios ausentes
  // ─────────────────────────────────────────────

  it('retorna "skipped" quando first_name_encrypted é null', async () => {
    const row = makeRow({ first_name_encrypted: null });
    setupFetchWorker(row);
    // Mesmo sem decrypt chamado, sex normalizer retornaria MALE, mas sem firstName → skip
    mockDecrypt.mockResolvedValue(null);

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('skipped');
    expect(provider.upsert).not.toHaveBeenCalled();
    expect(provider.deactivate).not.toHaveBeenCalled();
  });

  it('retorna "skipped" quando sex_encrypted é null e normalizeSexValue retorna null', async () => {
    const row = makeRow({ sex_encrypted: null });
    setupFetchWorker(row);
    // sex_encrypted null → nenhum decrypt → normalizeSexValue(null) → null
    mockDecrypt.mockImplementation((v: string) => {
      if (v === 'enc-fn') return Promise.resolve('Juan');
      if (v === 'enc-ln') return Promise.resolve('Pérez');
      return Promise.resolve(null);
    });

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('skipped');
    expect(provider.upsert).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────
  // 4. Skip quando status ≠ REGISTERED
  // ─────────────────────────────────────────────

  it('retorna "skipped" quando status é INCOMPLETE_REGISTER', async () => {
    const row = makeRow({ status: 'INCOMPLETE_REGISTER' });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('skipped');
    expect(provider.upsert).not.toHaveBeenCalled();
    expect(provider.deactivate).not.toHaveBeenCalled();
  });

  it('retorna "skipped" quando status é DISABLED', async () => {
    const row = makeRow({ status: 'DISABLED' });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('skipped');
    expect(provider.upsert).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────
  // 4b. Skip quando is_test=true (worker de teste NUNCA vai ao AnaCare)
  // ─────────────────────────────────────────────

  it('retorna "skipped" e NÃO chama provider.upsert quando is_test=true e status=REGISTERED', async () => {
    const row = makeRow({ is_test: true, status: 'REGISTERED' });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('skipped');
    expect(provider.upsert).not.toHaveBeenCalled();
    expect(provider.deactivate).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────
  // 5. Deactivate — ana_care_status='Baja' + ana_care_id presente
  // ─────────────────────────────────────────────

  it('retorna "deactivated" e chama provider.deactivate quando Baja + ana_care_id', async () => {
    const row = makeRow({ ana_care_status: 'Baja', ana_care_id: '55' });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('deactivated');
    expect(provider.deactivate).toHaveBeenCalledWith('55');
    expect(provider.upsert).not.toHaveBeenCalled();
  });

  it('retorna "created" quando Baja mas sem ana_care_id (nunca sincronizado, REGISTERED)', async () => {
    // Baja sem ana_care_id → não ativa baja path (sem externalId), cai no upsert normal
    const row = makeRow({ ana_care_status: 'Baja', ana_care_id: null, status: 'REGISTERED' });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne(WORKER_ID);

    expect(result).toBe('created');
    expect(provider.upsert).toHaveBeenCalled();
    expect(provider.deactivate).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────
  // 6. Worker não encontrado
  // ─────────────────────────────────────────────

  it('retorna "skipped" quando worker não existe no banco', async () => {
    setupFetchWorker(null);

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    const result = await service.mirrorOne('nonexistent-id');

    expect(result).toBe('skipped');
    expect(provider.upsert).not.toHaveBeenCalled();
  });

  // ─────────────────────────────────────────────
  // 7. Erro de API → persistError + rethrow
  // ─────────────────────────────────────────────

  it('chama persistError + reportError e rethrows em erro de provider.upsert', async () => {
    const row = makeRow({ ana_care_id: null });
    setupFetchWorker(row);
    setupDecrypt();

    const apiError = new Error('HTTP 500: internal error');
    const provider = makeFakeProvider({
      upsert: jest.fn().mockRejectedValue(apiError),
    });
    const service = new MirrorWorkerService(provider);

    await expect(service.mirrorOne(WORKER_ID)).rejects.toThrow('HTTP 500: internal error');

    // persistError deve ser chamado com o workerId e truncated message
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET ana_care_sync_error'),
      expect.arrayContaining([WORKER_ID]),
    );
    expect(mockReportError).toHaveBeenCalledWith(
      apiError,
      expect.objectContaining({ source: expect.stringContaining('mirrorOne') }),
    );
  });

  // ─────────────────────────────────────────────
  // 8. Provider sem deactivate → baja não quebra
  // ─────────────────────────────────────────────

  it('retorna "skipped" quando last_name_encrypted está ausente (buildRecord → null)', async () => {
    setupFetchWorker(makeRow({ ana_care_id: null, last_name_encrypted: null }));
    setupDecrypt();

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    await expect(service.mirrorOne(WORKER_ID)).resolves.toBe('skipped');
    expect(provider.upsert).not.toHaveBeenCalled();
  });

  it('erro não-Error do provider vira Error antes de persistError + rethrow', async () => {
    const row = makeRow({ ana_care_id: null });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider({ upsert: jest.fn().mockRejectedValue('socket hang up') });
    const service = new MirrorWorkerService(provider);

    await expect(service.mirrorOne(WORKER_ID)).rejects.toThrow('socket hang up');
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('SET ana_care_sync_error'),
      [WORKER_ID, 'socket hang up'],
    );
  });

  it('campos opcionais ausentes viram null no record (endereço/telefone/doc/nascimento)', async () => {
    const row = makeRow({
      ana_care_id: null,
      phone: null,
      profession: null,
      occupation: null,
      birth_date_encrypted: null,
      document_number_encrypted: null,
      sa_address_line: null,
      sa_city: null,
      sa_state: null,
      sa_neighborhood: null,
      sa_postal_code: null,
    });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider();
    const service = new MirrorWorkerService(provider);

    await expect(service.mirrorOne(WORKER_ID)).resolves.toBe('created');

    const [record] = (provider.upsert as jest.Mock).mock.calls[0] as [WorkerMirrorRecord];
    expect(record.phone).toBeNull();
    expect(record.birthDate).toBeNull();
    expect(record.documentNumber).toBeNull();
    expect(record.profession).toBeNull();
    expect(record.occupation).toBeNull();
    expect(record.address).toEqual({ line: null, city: null, state: null, neighborhood: null, postalCode: null });
  });

  it('retorna "deactivated" sem chamar nada quando o provider não suporta deactivate', async () => {
    const row = makeRow({ ana_care_status: 'Baja', ana_care_id: '55' });
    setupFetchWorker(row);
    setupDecrypt();

    const provider = makeFakeProvider({ deactivate: undefined });
    const service = new MirrorWorkerService(provider);

    await expect(service.mirrorOne(WORKER_ID)).resolves.toBe('deactivated');
    expect(provider.upsert).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────
// isAnaCareIdClaimed — o guard que decide se o link pode acontecer
//
// ⚠️ Aqui o `pool.query` é MOCKADO: estes testes provam a leitura do resultado
// (linha encontrada → true, nenhuma → false) e o SQL/params emitidos, NÃO que a
// SQL roda no Postgres. A execução real da SQL é provada no e2e com banco de
// verdade (tests/e2e/anacare-continuous-sync.e2e.test.ts, "SELECT real contra
// Postgres").
// ─────────────────────────────────────────────────────────────────

describe('isAnaCareIdClaimed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('true quando existe worker nosso com esse ana_care_id', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });

    await expect(isAnaCareIdClaimed('999')).resolves.toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      'SELECT 1 FROM workers WHERE ana_care_id = $1 LIMIT 1',
      ['999'],
    );
  });

  it('false quando nenhum worker nosso tem esse ana_care_id', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    await expect(isAnaCareIdClaimed('999')).resolves.toBe(false);
  });

  it('propaga a falha do banco (o provider é quem decide o fail-closed)', async () => {
    mockQuery.mockRejectedValue(new Error('connection terminated unexpectedly'));

    await expect(isAnaCareIdClaimed('999')).rejects.toThrow('connection terminated unexpectedly');
  });
});
