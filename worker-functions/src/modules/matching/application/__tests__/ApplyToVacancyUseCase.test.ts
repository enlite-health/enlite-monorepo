import { ApplyToVacancyUseCase } from '../ApplyToVacancyUseCase';
import { poolMockWithConnect } from '@shared/database/poolMockSupport';

/** Linha que o dono de publicável devolve (`vagaPublicavelSql ... AS publicavel`); o resto do SQL do use case cai no `rows` padrão. */
const publicavelRow = (status: string, publicavel: boolean) => ({ rows: [{ status, publicavel }] });
const ehConsultaDePublicavel = (sql: unknown): boolean => String(sql).includes('AS publicavel');

const LINK = 'http://talentum.invalid/public/pre-screening/00000000-0000-4000-8000-000000000067/chat';

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
    mockDb = poolMockWithConnect(mockQuery) as never;
    mockRecordBlocked = { execute: jest.fn().mockResolvedValue(['doc_dni_front']) };
    mockCreateWja = { execute: jest.fn().mockResolvedValue({ wjaId: 'wja-1' }) };
    useCase = new ApplyToVacancyUseCase(mockRecordBlocked as any, mockCreateWja as any);
  });

  afterEach(() => jest.clearAllMocks());

  it('spec 067 FR-16: vaga SEM link → ok:true com prescreeningUrl null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    mockQuery.mockImplementation(async (sql: string) =>
      ehConsultaDePublicavel(sql) ? publicavelRow('SEARCHING', true)
        : String(sql).includes('talentum_whatsapp_url') ? { rows: [{ url: null }] } : { rows: [] });

    const result = await useCase.execute(mockDb as any, PARAMS);

    expect(result).toEqual({ ok: true, wjaId: 'wja-1', prescreeningUrl: null });
  });

  it('spec 084 (P4/R6/F10): vaga DE_BAJA recusa a candidatura (app e Luz) — 409, nada é criado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }); // assertWorkerCanApply
    mockQuery.mockImplementation(async (sql: string) => (ehConsultaDePublicavel(sql) ? publicavelRow('DE_BAJA', false) : { rows: [] }));

    const result = await useCase.execute(mockDb as any, PARAMS);

    expect(result).toEqual({
      ok: false, code: 'VACANCY_DE_BAJA', httpStatus: 409, reason: 'vacancy_de_baja', workerStatus: null, missingFields: [],
    });
    expect(mockCreateWja.execute).not.toHaveBeenCalled();
  });

  it('semaforo-da-vaga F4 (I4): vaga NÃO publicável pelo dono (paciente SUSPENDED, serviço inativo, rascunho...) recusa — 409 VACANCY_NOT_PUBLISHABLE, nada é criado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }); // assertWorkerCanApply
    mockQuery.mockImplementation(async (sql: string) => (ehConsultaDePublicavel(sql) ? publicavelRow('PENDING_ACTIVATION', false) : { rows: [] }));

    const result = await useCase.execute(mockDb as any, PARAMS);

    expect(result).toEqual({
      ok: false, code: 'VACANCY_NOT_PUBLISHABLE', httpStatus: 409, reason: 'vacancy_not_publishable', workerStatus: null, missingFields: [],
    });
    expect(mockCreateWja.execute).not.toHaveBeenCalled();
  });

  it('vaga inexistente/apagada (nenhuma linha) também é não publicável — nada é criado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    mockQuery.mockImplementation(async () => ({ rows: [] }));

    expect(await useCase.execute(mockDb as any, PARAMS)).toMatchObject({ ok: false, code: 'VACANCY_NOT_PUBLISHABLE' });
    expect(mockCreateWja.execute).not.toHaveBeenCalled();
  });

  it('a decisão vem do DONO de publicável, com a opção incluirTeste (a jornada de vaga de teste em prd não quebra): SQL com is_draft/paciente e SEM is_test', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    mockQuery.mockImplementation(async (sql: string) => (ehConsultaDePublicavel(sql) ? publicavelRow('SEARCHING', true) : { rows: [{ url: null }] }));

    await useCase.execute(mockDb as any, PARAMS);

    const sql = String(mockQuery.mock.calls.map((c: unknown[]) => String(c[0])).find(ehConsultaDePublicavel));
    expect(sql).toContain('jp.is_draft = false');
    expect(sql).toMatch(/\bp\.status/);
    expect(sql).not.toContain('is_test');
  });

  it('worker REGISTERED → cria WJA+encuadre com os MESMOS params do app e retorna wjaId', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] }); // assertWorkerCanApply
    mockQuery.mockImplementation(async (sql: string) =>
      ehConsultaDePublicavel(sql) ? publicavelRow('SEARCHING', true)
        : String(sql).includes('talentum_whatsapp_url') ? { rows: [{ url: LINK }] } : { rows: [] }); // link da vaga (spec 067 FR-16)

    const result = await useCase.execute(mockDb as any, PARAMS);

    expect(result).toEqual({ ok: true, wjaId: 'wja-1', prescreeningUrl: LINK });
    // Recebe o CLIENT da transação (não o pool): a criação da candidatura passou
    // a rodar sob `withActorContext` para carimbar quem postulou.
    expect(mockCreateWja.execute).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.any(Function),
      release: expect.any(Function),
    }), {
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

    // Spec 067 FR-16: o ramo ok:false NUNCA carrega o link da Talentum nem chega a lê-lo no banco
    expect(result).not.toHaveProperty('prescreeningUrl');
    expect(mockQuery.mock.calls.some((c: unknown[]) => String(c[0]).includes('talentum_whatsapp_url'))).toBe(false);
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
    mockQuery.mockImplementation(async (sql: string) =>
      ehConsultaDePublicavel(sql) ? publicavelRow('SEARCHING', true)
        : String(sql).includes('talentum_whatsapp_url') ? { rows: [{ url: LINK }] } : { rows: [{ status: 'REGISTERED' }] });

    const first = await useCase.execute(mockDb as any, PARAMS);
    const second = await useCase.execute(mockDb as any, PARAMS);

    expect(first).toEqual({ ok: true, wjaId: 'wja-1', prescreeningUrl: LINK });
    expect(second).toEqual({ ok: true, wjaId: 'wja-1', prescreeningUrl: LINK });
    expect(mockCreateWja.execute).toHaveBeenCalledTimes(2);
  });

  it('erro de infraestrutura NÃO vira ok:false — propaga', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));

    await expect(useCase.execute(mockDb as any, PARAMS)).rejects.toThrow('connection refused');
    expect(mockRecordBlocked.execute).not.toHaveBeenCalled();
  });
});
