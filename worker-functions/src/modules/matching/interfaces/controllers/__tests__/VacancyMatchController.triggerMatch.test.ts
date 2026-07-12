/**
 * VacancyMatchController.triggerMatch.test.ts
 *
 * Segregação de realm (LIVE/TEST) é responsabilidade do matchmaking
 * (SameRealmSpecification dentro de MatchmakingService.hardFilter), não do
 * controller — o botão manual "Rodar match" delega e confia no resultado
 * já segregado, seja a vaga LIVE ou TEST.
 *
 * Cenários:
 * 1. Vaga encontrada — roda matchmaking normalmente e devolve o resultado
 *    (candidatos já vêm segregados por realm; controller não decide nada)
 * 2. Vaga não encontrada — 404 (não deixa matchWorkersForJob estourar em vão)
 * 3. Erro no matchmaking — 500 (fluxo de erro existente intacto)
 */

const mockQuery = jest.fn();
const mockMatchWorkersForJob = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: mockQuery }),
    }),
  },
}));

jest.mock('../../../infrastructure/MatchmakingService', () => ({
  MatchmakingService: jest.fn().mockImplementation(() => ({
    matchWorkersForJob: mockMatchWorkersForJob,
  })),
}));

jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
}));

import { VacancyMatchController } from '../VacancyMatchController';
import { Request, Response } from 'express';

const JOB_ID = 'aaaabbbb-0000-0000-0000-111111111111';

function makeReqRes(params: Record<string, string> = { id: JOB_ID }, query: Record<string, string> = {}): [Request, Response] {
  const req = { params, query } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('VacancyMatchController — triggerMatch (segregação de realm delegada ao matchmaking)', () => {
  let controller: VacancyMatchController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new VacancyMatchController();
  });

  it('vaga TEST encontrada — controller NÃO bloqueia; roda matchmaking (SameRealmSpecification decide dentro)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: JOB_ID }] });
    mockMatchWorkersForJob.mockResolvedValueOnce({ jobPostingId: JOB_ID, candidates: [] });

    const [req, res] = makeReqRes();
    await controller.triggerMatch(req, res);

    expect(mockMatchWorkersForJob).toHaveBeenCalledWith(JOB_ID, expect.objectContaining({ topN: 20 }));
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
  });

  it('vaga LIVE encontrada — roda matchmaking normalmente (fluxo intacto)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: JOB_ID }] });
    mockMatchWorkersForJob.mockResolvedValueOnce({ jobPostingId: JOB_ID, candidates: [] });

    const [req, res] = makeReqRes();
    await controller.triggerMatch(req, res);

    expect(mockMatchWorkersForJob).toHaveBeenCalledWith(JOB_ID, expect.objectContaining({ topN: 20 }));
    expect(res.status).toHaveBeenCalledWith(200);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(true);
  });

  it('vaga não encontrada — 404, matchmaking não é chamado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const [req, res] = makeReqRes();
    await controller.triggerMatch(req, res);

    expect(mockMatchWorkersForJob).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('erro no matchmaking — 500 (fluxo de erro existente intacto)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: JOB_ID }] });
    mockMatchWorkersForJob.mockRejectedValueOnce(new Error('boom'));

    const [req, res] = makeReqRes();
    await controller.triggerMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(false);
  });
});
