/**
 * Spec 084 (P4/R6) — o vazamento medido: vaga DE_BAJA aparecia no Kanban, no Match e na Luz e seguia recebendo
 * movimento. Aqui cada PONTO que a spec nomeia (F7-F10) é provado com a vaga em DE_BAJA: o Kanban abre em leitura,
 * nada nele se move, o Match não roda.
 */
const mockQuery = jest.fn();
const mockMatchWorkersForJob = jest.fn();

jest.mock('@modules/matching/infrastructure/BlockedApplicationQueryRepository', () => ({
  ...jest.requireActual('@modules/matching/infrastructure/BlockedApplicationQueryRepository'),
  BlockedApplicationQueryRepository: jest.fn().mockImplementation(() => ({ listByVacancy: jest.fn().mockResolvedValue([]) })),
}));
jest.mock('@shared/logging', () => ({ ...jest.requireActual('@shared/logging'), reportError: jest.fn() }));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue((require('@shared/database/poolMockSupport') as typeof import('@shared/database/poolMockSupport')).poolMockWithConnect(mockQuery)),
    }),
  },
}));
jest.mock('../../../infrastructure/MatchmakingService', () => ({
  MatchmakingService: jest.fn().mockImplementation(() => ({ matchWorkersForJob: mockMatchWorkersForJob })),
}));

import { WJAFunnelController } from '../WJAFunnelController';
import { VacancyMatchController } from '../VacancyMatchController';
import { REJECTION_REASON_CATEGORIES } from '../../../domain/Encuadre';
import type { Request, Response } from 'express';

function reqRes(params = {}, body = {}): [Request, Response] {
  const req = { params, body, query: {} } as unknown as Request;
  const res = { json: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis() } as unknown as Response;
  return [req, res];
}

describe('vaga DE_BAJA é só consulta', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockMatchWorkersForJob.mockReset();
  });

  it('Match: não roda em vaga DE_BAJA — 409 com código e es/pt-BR; o MatchmakingService nem é chamado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'jp-1', status: 'DE_BAJA' }] });
    const [req, res] = reqRes({ id: 'jp-1' });
    await new VacancyMatchController().triggerMatch(req, res);
    expect(mockMatchWorkersForJob).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'VACANCY_DE_BAJA_READ_ONLY',
      messages: { es: expect.stringMatching(/solo consulta/), 'pt-BR': expect.stringMatching(/só consulta/) },
    }));
  });

  it('Match: vaga SEARCHING segue rodando (controle: o 409 não é geral)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'jp-1', status: 'SEARCHING' }] });
    mockMatchWorkersForJob.mockResolvedValueOnce({ candidates: [] });
    const [req, res] = reqRes({ id: 'jp-1' });
    await new VacancyMatchController().triggerMatch(req, res);
    expect(mockMatchWorkersForJob).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('Kanban: mover candidato em vaga DE_BAJA → 409, nada é escrito', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1', job_posting_status: 'DE_BAJA' }] });
    const [req, res] = reqRes({ id: 'e1' }, { targetStage: 'PRE_SCREENING' });
    await new WJAFunnelController().moveEncuadre(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VACANCY_DE_BAJA_READ_ONLY' }));
    // só a leitura do encuadre aconteceu — nenhum UPDATE/INSERT
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('Kanban: rechazar e voltar um card BLOQUEADO de vaga DE_BAJA → 409 nos dois', async () => {
    const ctrl = new WJAFunnelController();
    const BLOCKED = '11111111-1111-4111-8111-111111111111';
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'DE_BAJA' }] });
    const [r1, s1] = reqRes({ blockedId: BLOCKED }, { rejectionReasonCategory: REJECTION_REASON_CATEGORIES[0] });
    await ctrl.rejectBlockedApplication(r1, s1);
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'DE_BAJA' }] });
    const [r2, s2] = reqRes({ blockedId: BLOCKED });
    await ctrl.undismissBlockedApplication(r2, s2);
    expect(s1.status).toHaveBeenCalledWith(409);
    expect(s2.status).toHaveBeenCalledWith(409);
  });
});
