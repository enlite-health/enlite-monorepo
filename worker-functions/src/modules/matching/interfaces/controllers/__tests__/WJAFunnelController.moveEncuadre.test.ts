/**
 * WJAFunnelController.moveEncuadre.test.ts
 *
 * Tests for the moveEncuadre endpoint only.
 * Split from WJAFunnelController.test.ts to keep both files ≤400 lines.
 *
 * Renamed from EncuadreFunnelController.moveEncuadre.test.ts in F7.a (migration 194).
 * Migration 230 (2026-06-26): INITIATED → PRE_SCREENING in validStages.
 *
 * - PUT /api/admin/encuadres/:id/move
 */

const mockQuery = jest.fn();

jest.mock('@modules/matching/infrastructure/BlockedApplicationQueryRepository', () => ({
  BlockedApplicationQueryRepository: jest.fn().mockImplementation(() => ({
    listByVacancy: jest.fn().mockResolvedValue([]),
  })),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
      }),
    }),
  },
}));

import { WJAFunnelController } from '../WJAFunnelController';
import { Request, Response } from 'express';

function mockReqRes(params = {}, body = {}): [Request, Response] {
  const req = { params, body, query: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('WJAFunnelController — moveEncuadre', () => {
  let controller: WJAFunnelController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new WJAFunnelController();
  });

  it('retorna 400 quando targetStage está ausente', async () => {
    const [req, res] = mockReqRes({ id: 'e1' }, {});
    await controller.moveEncuadre(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('retorna 400 para targetStage inválido', async () => {
    const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'INVALID_STAGE' });
    await controller.moveEncuadre(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('retorna 400 para INITIATED (migration 230: aposentado, use PRE_SCREENING)', async () => {
    // INITIATED foi renomeado para PRE_SCREENING — não é mais aceito pelo moveEncuadre
    const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'INITIATED' });
    await controller.moveEncuadre(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('aceita PRE_SCREENING como targetStage (migration 230: substitui INITIATED)', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'PRE_SCREENING' });
    await controller.moveEncuadre(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true, data: expect.objectContaining({ targetStage: 'PRE_SCREENING' }) }),
    );
  });

  it('retorna 404 quando encuadre não existe', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const [req, res] = mockReqRes({ id: 'e-nonexistent' }, { targetStage: 'CONFIRMED' });
    await controller.moveEncuadre(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('retorna 400 quando encuadre não tem worker_id', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ worker_id: null, job_posting_id: 'jp-1' }],
    });

    const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'CONFIRMED' });
    await controller.moveEncuadre(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('move para CONFIRMED — atualiza application_funnel_stage sem tocar resultado', async () => {
    // Query 1: SELECT encuadre
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
    });
    // Query 2: SELECT status FROM workers (eligibility check)
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    // Query 3: INSERT/UPDATE worker_job_applications
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'CONFIRMED' });
    await controller.moveEncuadre(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { encuadreId: 'e1', targetStage: 'CONFIRMED' },
    });

    // Deve ter feito exatamente 3 queries (SELECT + eligibility + upsert wja)
    expect(mockQuery).toHaveBeenCalledTimes(3);

    // Terceira query: upsert em worker_job_applications com stage CONFIRMED
    const upsertCall = mockQuery.mock.calls[2];
    expect(upsertCall[0]).toContain('worker_job_applications');
    expect(upsertCall[1]).toEqual(['w-1', 'jp-1', 'CONFIRMED']);
  });

  it('retorna 403 quando worker.status = INCOMPLETE_REGISTER', async () => {
    // Query 1: SELECT encuadre
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
    });
    // Query 2: SELECT status — INCOMPLETE
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'INCOMPLETE_REGISTER' }] });

    const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'CONFIRMED' });
    await controller.moveEncuadre(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.code).toBe('WORKER_NOT_ELIGIBLE');
    expect(body.reason).toBe('registration_incomplete');
    // Não deve ter chamado upsert
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('retorna 403 quando worker.status = DISABLED', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'DISABLED' }] });

    const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'SELECTED' });
    await controller.moveEncuadre(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.reason).toBe('worker_disabled');
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('move para SELECTED — atualiza funnel_stage E resultado do encuadre', async () => {
    // Query 1: SELECT encuadre
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
    });
    // Query 2: eligibility check
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    // Query 3: upsert wja
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    // Query 4: UPDATE encuadre resultado = SELECCIONADO
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'SELECTED' });
    await controller.moveEncuadre(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { encuadreId: 'e1', targetStage: 'SELECTED' },
    });

    // 4 queries: SELECT + eligibility + upsert wja + UPDATE encuadre
    expect(mockQuery).toHaveBeenCalledTimes(4);

    // Quarta query: UPDATE resultado = SELECCIONADO
    const updateCall = mockQuery.mock.calls[3];
    expect(updateCall[0]).toContain('SELECCIONADO');
  });

  it('move para REJECTED — atualiza funnel_stage, resultado E rejection_reason_category', async () => {
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
    });
    // eligibility
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
    // upsert wja
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    // UPDATE encuadre resultado = RECHAZADO
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const [req, res] = mockReqRes(
      { id: 'e1' },
      { targetStage: 'REJECTED', rejectionReasonCategory: 'DISTANCE' },
    );
    await controller.moveEncuadre(req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: { encuadreId: 'e1', targetStage: 'REJECTED' },
    });

    // Quarta query: UPDATE resultado = RECHAZADO com category
    const updateCall = mockQuery.mock.calls[3];
    expect(updateCall[0]).toContain('RECHAZADO');
    expect(updateCall[1]).toContain('DISTANCE');
  });

  it('aceita todos os targetStage válidos (migration 230: INITIATED→PRE_SCREENING; F3: NOT_QUALIFIED removido; F7.a: PLACED removido)', async () => {
    // INITIATED removido em migration 230 — renomeado para PRE_SCREENING
    // NOT_QUALIFIED removido em F3 — operador admin não pode mover manualmente para esse stage
    // PLACED removido em F7.a (migration 194 — 0 linhas em prod, sync F6 morta)
    const validStages = [
      'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'QUALIFIED', 'IN_DOUBT',
      'CONFIRMED', 'SELECTED', 'REJECTED',
    ];

    for (const stage of validStages) {
      jest.clearAllMocks();

      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
      });
      // eligibility OK
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
      mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

      const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: stage });
      await controller.moveEncuadre(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: true }),
      );
    }
  });
});
