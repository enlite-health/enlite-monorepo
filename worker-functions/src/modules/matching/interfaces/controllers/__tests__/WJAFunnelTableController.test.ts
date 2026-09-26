/**
 * WJAFunnelTableController.test.ts
 *
 * P9 — a rota GET /api/admin/vacancies/:id/funnel-table aceita `?columns=`
 * (filtro por coluna do Kanban, DX-2.6). Sem teste próprio até aqui; o único
 * exercitado era o de rotas (adminVacanciesRoutes.test.ts), com um dublê do
 * use case.
 */

const mockExecute = jest.fn();

jest.mock('../../../application/GetFunnelTableUseCase', () => ({
  GetFunnelTableUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })),
}));

import { Request, Response } from 'express';
import { WJAFunnelTableController } from '../WJAFunnelTableController';

function reqRes(query: Record<string, string> = {}): [Request, Response] {
  const req = { params: { id: 'jp-1' }, query, body: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('WJAFunnelTableController.getEncuadreFunnelTable — ?columns=', () => {
  let controller: WJAFunnelTableController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ rows: [], counts: {} });
    controller = new WJAFunnelTableController();
  });

  it('?columns=PRE_SCREENING,IN_PROGRESS chega ao use case como array', async () => {
    const [req, res] = reqRes({ columns: 'PRE_SCREENING,IN_PROGRESS' });

    await controller.getEncuadreFunnelTable(req, res);

    expect(mockExecute).toHaveBeenCalledWith('jp-1', 'ALL', null, ['PRE_SCREENING', 'IN_PROGRESS']);
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it('?columns=BLOQUEADO → 400 (D433: coluna não existe mais)', async () => {
    const [req, res] = reqRes({ columns: 'BLOQUEADO' });

    await controller.getEncuadreFunnelTable(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Invalid column "BLOQUEADO"' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('sem `columns` → o use case recebe null', async () => {
    const [req, res] = reqRes({});

    await controller.getEncuadreFunnelTable(req, res);

    expect(mockExecute).toHaveBeenCalledWith('jp-1', 'ALL', null, null);
  });
});
