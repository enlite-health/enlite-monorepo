/**
 * VacancyMatchController.triggerMatch.test.ts
 *
 * Guarda: vaga is_test NUNCA convida ATs — também no caminho MANUAL
 * (botão "Rodar match"). Espelha a guarda já existente no caminho
 * automático (VacancyAutoInviteHandler).
 *
 * Cenários:
 * 1. Vaga is_test=true — NÃO chama matchmaking, responde 409 com skipped info
 * 2. Vaga is_test=false — chama matchmaking normalmente (fluxo intacto)
 * 3. Vaga não encontrada — 404 (não deixa matchWorkersForJob estourar em vão)
 * 4. Erro no matchmaking — 500 (fluxo de erro existente intacto)
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

describe('VacancyMatchController — triggerMatch (is_test guard)', () => {
  let controller: VacancyMatchController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new VacancyMatchController();
  });

  it('vaga is_test=true — NÃO chama matchmaking e responde 409 skipped', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ is_test: true }] });

    const [req, res] = makeReqRes();
    await controller.triggerMatch(req, res);

    expect(mockMatchWorkersForJob).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/test vacancy/i);
  });

  it('vaga is_test=false — roda matchmaking normalmente (fluxo intacto)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ is_test: false }] });
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

  it('erro no matchmaking (vaga real) — 500 (fluxo de erro existente intacto)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ is_test: false }] });
    mockMatchWorkersForJob.mockRejectedValueOnce(new Error('boom'));

    const [req, res] = makeReqRes();
    await controller.triggerMatch(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.success).toBe(false);
  });
});
