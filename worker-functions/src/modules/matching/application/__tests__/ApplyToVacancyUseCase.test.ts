import { ApplyToVacancyUseCase } from '../ApplyToVacancyUseCase';

describe('ApplyToVacancyUseCase', () => {
  let mockQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let mockRecordBlocked: { execute: jest.Mock };
  let mockCreateWja: { execute: jest.Mock };
  let useCase: ApplyToVacancyUseCase;

  const PARAMS = {
    workerId: 'w-1',
    jobPostingId: 'jp-1',
    acquisitionChannel: 'luz_whatsapp',
    workerName: 'María García',
    workerPhone: '+5491155001122',
  };

  beforeEach(() => {
    mockQuery = jest.fn();
    mockDb = { query: mockQuery };
    mockRecordBlocked = { execute: jest.fn().mockResolvedValue(['doc_dni_front']) };
    mockCreateWja = { execute: jest.fn().mockResolvedValue({ wjaId: 'wja-1' }) };
    useCase = new ApplyToVacancyUseCase(mockRecordBlocked as any, mockCreateWja as any);
  });

  afterEach(() => jest.clearAllMocks());

  it('worker REGISTERED → cria WJA+encuadre com os MESMOS params do app e retorna wjaId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }); // assertWorkerCanApply

    const result = await useCase.execute(mockDb as any, PARAMS);

    expect(result).toEqual({ ok: true, wjaId: 'wja-1' });
    expect(mockCreateWja.execute).toHaveBeenCalledWith(mockDb, {
      workerId: 'w-1',
      jobPostingId: 'jp-1',
      acquisitionChannel: 'luz_whatsapp',
      workerName: 'María García',
      workerPhone: '+5491155001122',
    });
    expect(mockRecordBlocked.execute).not.toHaveBeenCalled();
  });

  it('worker INCOMPLETE_REGISTER → ok:false 403 registration_incomplete + tentativa bloqueada instrumentada', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'INCOMPLETE_REGISTER' }] });

    const result = await useCase.execute(mockDb as any, PARAMS);

    expect(result).toEqual({
      ok: false,
      code: 'WORKER_NOT_ELIGIBLE',
      httpStatus: 403,
      reason: 'registration_incomplete',
      workerStatus: 'INCOMPLETE_REGISTER',
      missingFields: ['doc_dni_front'],
    });
    expect(mockRecordBlocked.execute).toHaveBeenCalledWith({
      workerId: 'w-1',
      jobPostingId: 'jp-1',
      reason: 'registration_incomplete',
      acquisitionChannel: 'luz_whatsapp',
    });
    expect(mockCreateWja.execute).not.toHaveBeenCalled();
  });

  it('worker DISABLED → ok:false reason=worker_disabled, sem escrita', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'DISABLED' }] });

    const result = await useCase.execute(mockDb as any, PARAMS);

    expect(result).toMatchObject({ ok: false, reason: 'worker_disabled', workerStatus: 'DISABLED' });
    expect(mockCreateWja.execute).not.toHaveBeenCalled();
  });

  it('worker inexistente (merge/deletado) → ok:false reason=worker_not_found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await useCase.execute(mockDb as any, PARAMS);

    expect(result).toMatchObject({ ok: false, reason: 'worker_not_found', workerStatus: null });
  });

  it('idempotência delega ao ON CONFLICT do CreateManualWjaWithEncuadre (repete → mesma chamada, sem erro)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ status: 'REGISTERED' }] });

    const first = await useCase.execute(mockDb as any, PARAMS);
    const second = await useCase.execute(mockDb as any, PARAMS);

    expect(first).toEqual({ ok: true, wjaId: 'wja-1' });
    expect(second).toEqual({ ok: true, wjaId: 'wja-1' });
    expect(mockCreateWja.execute).toHaveBeenCalledTimes(2);
  });

  it('erro de infraestrutura NÃO vira ok:false — propaga', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    await expect(useCase.execute(mockDb as any, PARAMS)).rejects.toThrow('connection refused');
    expect(mockRecordBlocked.execute).not.toHaveBeenCalled();
  });
});
