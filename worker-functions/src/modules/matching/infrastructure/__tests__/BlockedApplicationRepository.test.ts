/**
 * BlockedApplicationRepository.test.ts
 *
 * Testes unitários do repositório de escrita de tentativas bloqueadas.
 *
 * Cenários:
 * 1. Upsert (insertion) — reason=registration_incomplete: chama fn_worker_missing_fields + INSERT
 * 2. Upsert — reason=worker_not_found: também chama fn_worker_missing_fields
 * 3. Upsert — reason=worker_disabled: NÃO chama fn_worker_missing_fields, missing_fields=[]
 * 4. Falha no SELECT da função SQL — loga warn mas não re-lança
 * 5. Falha no INSERT — propaga erro
 * 6. missingFields = array retornado pela função SQL é serializado corretamente
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

const mockLoggerChild = jest.fn().mockReturnValue({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});
const mockLoggerWarn = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: {
    child: mockLoggerChild,
    warn: mockLoggerWarn,
    info: jest.fn(),
    error: jest.fn(),
  },
}));

import { BlockedApplicationRepository } from '../BlockedApplicationRepository';

const WORKER_ID = 'aabbccdd-0000-0000-0000-111111111111';
const JOB_ID    = 'bbccddee-0000-0000-0000-222222222222';

describe('BlockedApplicationRepository', () => {
  let repo: BlockedApplicationRepository;

  beforeEach(() => {
    jest.clearAllMocks();
    repo = new BlockedApplicationRepository();
  });

  it('chama fn_worker_missing_fields e depois INSERT para reason=registration_incomplete', async () => {
    // Primeira query: fn_worker_missing_fields retorna JSON string
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["first_name","phone"]' }] });
    // Segunda query: INSERT ... ON CONFLICT
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: 'facebook',
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);

    // Primeira chamada: SELECT fn_worker_missing_fields
    const selectCall = mockQuery.mock.calls[0];
    expect(selectCall[0]).toContain('fn_worker_missing_fields');
    expect(selectCall[1]).toEqual([WORKER_ID]);

    // Segunda chamada: INSERT ... ON CONFLICT
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('INSERT INTO worker_blocked_applications');
    expect(insertCall[0]).toContain('ON CONFLICT (worker_id, job_posting_id)');
    expect(insertCall[1][2]).toBe('registration_incomplete');
    expect(insertCall[1][3]).toBe('["first_name","phone"]');
    expect(insertCall[1][4]).toBe('facebook');
  });

  it('chama fn_worker_missing_fields para reason=worker_not_found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '["worker_not_found"]' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'worker_not_found',
      acquisitionChannel: null,
    });

    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls[0][0]).toContain('fn_worker_missing_fields');
  });

  it('NÃO chama fn_worker_missing_fields para reason=worker_disabled — missing_fields=[]', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'worker_disabled',
      acquisitionChannel: 'instagram',
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const insertCall = mockQuery.mock.calls[0];
    expect(insertCall[0]).toContain('INSERT INTO worker_blocked_applications');
    // missing_fields deve ser array vazio serializado
    expect(insertCall[1][3]).toBe('[]');
  });

  it('missing_fields = [] quando fn_worker_missing_fields retorna resultado inesperado', async () => {
    // Retorna undefined (campo ausente)
    mockQuery.mockResolvedValueOnce({ rows: [{}] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[1][3]).toBe('[]');
  });

  it('loga warn mas não propaga quando fn_worker_missing_fields retorna JSON inválido', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: 'not-json' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      repo.upsert({
        workerId: WORKER_ID,
        jobPostingId: JOB_ID,
        reason: 'registration_incomplete',
        acquisitionChannel: null,
      }),
    ).resolves.toBeUndefined();

    const childLogger = mockLoggerChild.mock.results[0]?.value;
    expect(childLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('failed to parse') }),
    );
  });

  it('propaga erro quando o INSERT falha', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: '[]' }] });
    mockQuery.mockRejectedValueOnce(new Error('DB connection lost'));

    await expect(
      repo.upsert({
        workerId: WORKER_ID,
        jobPostingId: JOB_ID,
        reason: 'registration_incomplete',
        acquisitionChannel: null,
      }),
    ).rejects.toThrow('DB connection lost');
  });

  it('serializa array de missing_fields como JSON string no INSERT', async () => {
    const fields = ['first_name', 'worker_availability', 'worker_documents'];
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: JSON.stringify(fields) }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: 'whatsapp',
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(JSON.parse(insertCall[1][3] as string)).toEqual(fields);
  });

  it('aceita missing quando fn retorna array JS (não string) — branch else if Array.isArray', async () => {
    // Cobre linhas 74-77: `else if (Array.isArray(raw))` — pg pode retornar JSONB já parseado
    const fields = ['first_name', 'phone'];
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: fields }] }); // já é array
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(JSON.parse(insertCall[1][3] as string)).toEqual(fields);
  });

  it('filtra valores não-string do array retornado pela fn', async () => {
    // Cobre o filter dentro do else if Array.isArray: (v) => typeof v === 'string'
    const mixed = ['first_name', 42, null, 'phone'];
    mockQuery.mockResolvedValueOnce({ rows: [{ missing: mixed }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    await repo.upsert({
      workerId: WORKER_ID,
      jobPostingId: JOB_ID,
      reason: 'registration_incomplete',
      acquisitionChannel: null,
    });

    const insertCall = mockQuery.mock.calls[1];
    expect(JSON.parse(insertCall[1][3] as string)).toEqual(['first_name', 'phone']);
  });
});
