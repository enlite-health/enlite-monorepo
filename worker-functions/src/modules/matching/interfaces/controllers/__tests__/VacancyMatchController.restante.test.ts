/**
 * VacancyMatchController — `getMatchResults` e `updateEncuadreResult`.
 *
 * O PR #249 tocou este arquivo (removeu o parsing de `use_scoring` do
 * `triggerMatch`), e o critério 3 do `revisao-pr` é per-FILE: 100% em cada
 * arquivo de PRODUÇÃO tocado. O `triggerMatch` já tinha suíte própria; estes
 * dois métodos estavam em 0% e derrubavam o arquivo para 37%.
 *
 * A exceção que o critério permite é TÉCNICA (ramo irreproduzível em unit), não
 * de escopo — "não fui eu que mexi nesse método" não é justificativa aceita.
 * Daí este arquivo.
 *
 * Cobre também a guarda de vazamento: `getMatchResults` devolve nome e telefone
 * descriptografados por KMS, e é rota de staff.
 */

const mockQuery = jest.fn();
const mockDecrypt = jest.fn();
const mockExecuteEncuadre = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockDecrypt })),
}));
jest.mock('../../../infrastructure/MatchmakingService', () => ({
  MatchmakingService: jest.fn().mockImplementation(() => ({ matchWorkersForJob: jest.fn() })),
}));
jest.mock('../../../application/UpdateEncuadreResultUseCase', () => ({
  UpdateEncuadreResultUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecuteEncuadre })),
}));

import { Request, Response } from 'express';
import { VacancyMatchController } from '../VacancyMatchController';
import { esperaSqlSemDadoClinico } from '../../../__tests__/guardaVazamentoClinico';

function makeRes(): Response & { statusCode: number; payload: unknown } {
  const res = {
    statusCode: 200,
    payload: undefined as unknown,
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.payload = p; return res; },
  };
  return res as unknown as Response & { statusCode: number; payload: unknown };
}
function makeReq(over: Record<string, unknown> = {}): Request {
  return { params: { id: 'jp-1' }, query: {}, body: {}, ...over } as unknown as Request;
}

const LINHA = {
  worker_id: 'w-1',
  first_name_encrypted: 'enc:Ana',
  last_name_encrypted: 'enc:Silva',
  phone: '+5491100000000',
  occupation: 'AT',
  work_zone: 'Palermo',
  worker_address: 'Av. Santa Fe 1000',
  distance_km: 3.2,
  active_cases_count: 1,
  worker_status: 'REGISTERED',
  documents_status: 'OK',
  match_score: '80',
  internal_notes: null,
  source: 'system',
  messaged_at: null,
  application_funnel_stage: 'INVITED',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockDecrypt.mockImplementation(async (v: string | null) => (v ? String(v).replace(/^enc:/, '') : null));
  mockQuery
    .mockResolvedValueOnce({ rows: [{ total: '1', last_match_at: new Date('2026-08-23T10:00:00Z') }] })
    .mockResolvedValueOnce({ rows: [LINHA] });
});

describe('getMatchResults', () => {
  it('devolve total, lastMatchAt e o candidato com nome descriptografado', async () => {
    const res = makeRes();

    await new VacancyMatchController().getMatchResults(makeReq(), res);

    expect(res.statusCode).toBe(200);
    const d = (res.payload as { data: { totalCandidates: number; candidates: Array<Record<string, unknown>> } }).data;
    expect(d.totalCandidates).toBe(1);
    expect(d.candidates[0]).toMatchObject({ workerId: 'w-1', workerName: 'Ana Silva', matchScore: 80 });
  });

  it('nenhuma query pede dado clínico de paciente', async () => {
    await new VacancyMatchController().getMatchResults(makeReq(), makeRes());

    esperaSqlSemDadoClinico(mockQuery.mock.calls);
  });

  it('limit é limitado a 200 e offset é lido da query', async () => {
    await new VacancyMatchController().getMatchResults(
      makeReq({ query: { limit: '9999', offset: '40' } }), makeRes(),
    );

    const params = mockQuery.mock.calls[1][1] as unknown[];
    expect(params).toContain(200);
    expect(params).toContain(40);
  });

  it.each([
    ['source diferente de system', { source: 'manual' }, true],
    ['já foi contatado', { messaged_at: new Date() }, true],
    ['avançou no funil', { application_funnel_stage: 'INTERVIEWED' }, true],
    ['convidado pelo match e intocado', {}, false],
  ])('alreadyApplied — %s', async (_n, over, esperado) => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '1', last_match_at: null }] })
      .mockResolvedValueOnce({ rows: [{ ...LINHA, ...over }] });
    const res = makeRes();

    await new VacancyMatchController().getMatchResults(makeReq(), res);

    const c = (res.payload as { data: { candidates: Array<{ alreadyApplied: boolean }> } }).data.candidates[0];
    expect(c.alreadyApplied).toBe(esperado);
  });

  it('matchScore nulo continua nulo — "não avaliado" ≠ "avaliado zero"', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '1', last_match_at: null }] })
      .mockResolvedValueOnce({ rows: [{ ...LINHA, match_score: null }] });
    const res = makeRes();

    await new VacancyMatchController().getMatchResults(makeReq(), res);

    expect((res.payload as { data: { candidates: Array<{ matchScore: number | null }> } }).data.candidates[0].matchScore).toBeNull();
  });

  // KMS fora do ar não pode virar página em branco nem vazar exceção: o
  // controller cai para 'Nome não disponível'. Ramo real de produção.
  it('KMS falhando → nome vira "Nome não disponível", sem estourar', async () => {
    mockDecrypt.mockRejectedValue(new Error('kms indisponível'));
    const res = makeRes();

    await new VacancyMatchController().getMatchResults(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: { candidates: Array<{ workerName: string }> } }).data.candidates[0].workerName)
      .toBe('Nome não disponível');
  });

  // MEDIDO, não suposto: aqui `workZone` é `row.work_zone` puro — não há
  // fallback para o endereço (ao contrário do `MatchmakingHardFilterPath`).
  it('workZone nula permanece nula — este controller não cai para o endereço', async () => {
    mockQuery.mockReset();
    mockQuery
      .mockResolvedValueOnce({ rows: [{ total: '1', last_match_at: null }] })
      .mockResolvedValueOnce({ rows: [{ ...LINHA, work_zone: null }] });
    const res = makeRes();

    await new VacancyMatchController().getMatchResults(makeReq(), res);

    expect((res.payload as { data: { candidates: Array<{ workZone: string | null }> } }).data.candidates[0].workZone)
      .toBeNull();
  });

  it('banco fora do ar → 500 com a mensagem', async () => {
    mockQuery.mockReset();
    mockQuery.mockRejectedValue(new Error('connection refused'));
    const res = makeRes();

    await new VacancyMatchController().getMatchResults(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect((res.payload as { details: string }).details).toBe('connection refused');
  });
});

describe('updateEncuadreResult', () => {
  it('sem resultado → 400', async () => {
    const res = makeRes();
    await new VacancyMatchController().updateEncuadreResult(makeReq(), res);
    expect(res.statusCode).toBe(400);
  });

  it('resultado fora do enum → 400 e não chama o use case', async () => {
    const res = makeRes();
    await new VacancyMatchController().updateEncuadreResult(makeReq({ body: { resultado: 'TALVEZ' } }), res);
    expect(res.statusCode).toBe(400);
    expect(mockExecuteEncuadre).not.toHaveBeenCalled();
  });

  it('categoria de rejeição inválida → 400', async () => {
    const res = makeRes();
    await new VacancyMatchController().updateEncuadreResult(
      makeReq({ body: { resultado: 'RECHAZADO', rejectionReasonCategory: 'PORQUE_SIM' } }), res,
    );
    expect(res.statusCode).toBe(400);
  });

  it('resultado válido → chama o use case com null nos opcionais ausentes', async () => {
    mockExecuteEncuadre.mockResolvedValue({ id: 'e-1', resultado: 'SELECCIONADO' });
    const res = makeRes();

    await new VacancyMatchController().updateEncuadreResult(
      makeReq({ body: { resultado: 'SELECCIONADO' } }), res,
    );

    expect(mockExecuteEncuadre).toHaveBeenCalledWith({
      encuadreId: 'jp-1', resultado: 'SELECCIONADO',
      rejectionReasonCategory: null, rejectionReason: null,
    });
    expect((res.payload as { success: boolean }).success).toBe(true);
  });

  it('categoria válida é repassada', async () => {
    mockExecuteEncuadre.mockResolvedValue({ id: 'e-1' });

    await new VacancyMatchController().updateEncuadreResult(
      makeReq({ body: { resultado: 'RECHAZADO', rejectionReasonCategory: 'DISTANCE', rejectionReason: 'lejos' } }),
      makeRes(),
    );

    expect(mockExecuteEncuadre).toHaveBeenCalledWith(expect.objectContaining({
      rejectionReasonCategory: 'DISTANCE', rejectionReason: 'lejos',
    }));
  });

  it('erro "not found" do use case → 404, outros erros → 500', async () => {
    mockExecuteEncuadre.mockRejectedValueOnce(new Error('encuadre not found'));
    const res404 = makeRes();
    await new VacancyMatchController().updateEncuadreResult(makeReq({ body: { resultado: 'PENDIENTE' } }), res404);
    expect(res404.statusCode).toBe(404);

    mockExecuteEncuadre.mockRejectedValueOnce(new Error('deadlock'));
    const res500 = makeRes();
    await new VacancyMatchController().updateEncuadreResult(makeReq({ body: { resultado: 'PENDIENTE' } }), res500);
    expect(res500.statusCode).toBe(500);
  });

  it('erro não-Error vira "Unknown error" com 500', async () => {
    mockExecuteEncuadre.mockRejectedValueOnce('string solta');
    const res = makeRes();

    await new VacancyMatchController().updateEncuadreResult(makeReq({ body: { resultado: 'PENDIENTE' } }), res);

    expect(res.statusCode).toBe(500);
    expect((res.payload as { error: string }).error).toBe('Unknown error');
  });
});
