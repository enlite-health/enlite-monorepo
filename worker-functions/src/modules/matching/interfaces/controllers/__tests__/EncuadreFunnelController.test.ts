/**
 * EncuadreFunnelController.test.ts
 *
 * Tests the getEncuadreFunnel kanban endpoint — driven by application_funnel_stage
 * as the single source of truth.
 *
 * moveEncuadre tests live in EncuadreFunnelController.moveEncuadre.test.ts (split
 * to keep both files ≤400 lines).
 * Dashboard tests (getCoordinatorCapacity, getAlerts) live here too as they are small.
 */

const mockQuery = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
      }),
    }),
  },
}));

import { EncuadreFunnelController } from '../EncuadreFunnelController';
import { EncuadreDashboardController } from '../EncuadreDashboardController';
import { Request, Response } from 'express';

function mockReqRes(params = {}, body = {}): [Request, Response] {
  const req = { params, body, query: {} } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    worker_name: 'Test Worker',
    worker_phone: '+54911000',
    occupation_raw: 'AT',
    interview_date: null,
    interview_time: null,
    meet_link: null,
    resultado: null,
    attended: null,
    rejection_reason_category: null,
    rejection_reason: null,
    redireccionamiento: null,
    match_score: null,
    acquisition_channel: null,
    funnel_stage: null,
    talentum_status: null,
    work_zone: null,
    ...overrides,
  };
}

describe('EncuadreFunnelController', () => {
  let controller: EncuadreFunnelController;
  let dashboardController: EncuadreDashboardController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new EncuadreFunnelController();
    dashboardController = new EncuadreDashboardController();
  });

  // ═══════════════════════════════════════════════════════════════════
  // getEncuadreFunnel — classificação por application_funnel_stage
  // ═══════════════════════════════════════════════════════════════════

  describe('getEncuadreFunnel', () => {
    it('classifica encuadres nas 7 colunas por funnel_stage', async () => {
      // F3: NOT_QUALIFIED não existe mais em prod (migration 191 backfill → REJECTED)
      // Teste usa apenas stages canônicos pós-migration 191
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'e1', funnel_stage: null }),
          makeRow({ id: 'e2', funnel_stage: 'INITIATED', talentum_status: 'INITIATED' }),
          makeRow({ id: 'e3', funnel_stage: 'IN_PROGRESS', talentum_status: 'IN_PROGRESS' }),
          makeRow({ id: 'e4', funnel_stage: 'COMPLETED', talentum_status: 'COMPLETED' }),
          makeRow({ id: 'e5', funnel_stage: 'QUALIFIED', talentum_status: 'QUALIFIED' }),
          makeRow({ id: 'e6', funnel_stage: 'IN_DOUBT', talentum_status: 'IN_DOUBT' }),
          makeRow({ id: 'e7', funnel_stage: 'CONFIRMED' }),
          makeRow({ id: 'e8', funnel_stage: 'SELECTED' }),
          makeRow({ id: 'e9', funnel_stage: 'REJECTED' }),
          makeRow({ id: 'e10', funnel_stage: 'PLACED' }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.data.totalEncuadres).toBe(10);

      const { stages } = response.data;

      // NULL → INVITED
      expect(stages.INVITED).toHaveLength(1);
      expect(stages.INVITED[0].id).toBe('e1');

      // INITIATED
      expect(stages.INITIATED).toHaveLength(1);
      expect(stages.INITIATED[0].id).toBe('e2');

      // IN_PROGRESS
      expect(stages.IN_PROGRESS).toHaveLength(1);
      expect(stages.IN_PROGRESS[0].id).toBe('e3');

      // COMPLETED agrupa COMPLETED + QUALIFIED + IN_DOUBT + REPROGRAM (F3: NOT_QUALIFIED removido)
      expect(stages.COMPLETED).toHaveLength(3);
      const completedIds = stages.COMPLETED.map((e: any) => e.id);
      expect(completedIds).toContain('e4');
      expect(completedIds).toContain('e5');
      expect(completedIds).toContain('e6');

      // CONFIRMED
      expect(stages.CONFIRMED).toHaveLength(1);
      expect(stages.CONFIRMED[0].id).toBe('e7');

      // SELECTED agrupa SELECTED + PLACED
      expect(stages.SELECTED).toHaveLength(2);
      const selectedIds = stages.SELECTED.map((e: any) => e.id);
      expect(selectedIds).toContain('e8');
      expect(selectedIds).toContain('e10');

      // REJECTED
      expect(stages.REJECTED).toHaveLength(1);
      expect(stages.REJECTED[0].id).toBe('e9');
    });

    it('preserva talentumStatus como tag para diferenciar dentro de COMPLETED', async () => {
      // F3: NOT_QUALIFIED removido do bucket COMPLETED — apenas QUALIFIED e IN_DOUBT agrupados
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'e1', funnel_stage: 'QUALIFIED', talentum_status: 'QUALIFIED' }),
          makeRow({ id: 'e2', funnel_stage: 'IN_DOUBT', talentum_status: 'IN_DOUBT' }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;

      // Ambos vão para COMPLETED
      expect(stages.COMPLETED).toHaveLength(2);

      // Cada um tem sua talentumStatus preservada
      expect(stages.COMPLETED.find((e: any) => e.id === 'e1').talentumStatus).toBe('QUALIFIED');
      expect(stages.COMPLETED.find((e: any) => e.id === 'e2').talentumStatus).toBe('IN_DOUBT');
    });

    it('expõe internalStage igual a funnelStage em cada item do payload', async () => {
      // F4: internalStage é alias explícito de funnelStage — frontend usa pra renderizar badge
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'e1', funnel_stage: 'QUALIFIED' }),
          makeRow({ id: 'e2', funnel_stage: 'IN_PROGRESS' }),
          makeRow({ id: 'e3', funnel_stage: null }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;

      const e1 = stages.COMPLETED.find((e: any) => e.id === 'e1');
      expect(e1).toBeDefined();
      expect(e1.internalStage).toBe('QUALIFIED');
      expect(e1.internalStage).toBe(e1.funnelStage);

      const e2 = stages.IN_PROGRESS.find((e: any) => e.id === 'e2');
      expect(e2).toBeDefined();
      expect(e2.internalStage).toBe('IN_PROGRESS');
      expect(e2.internalStage).toBe(e2.funnelStage);

      // null stage: internalStage deve ser null (não undefined)
      const e3 = stages.INVITED.find((e: any) => e.id === 'e3');
      expect(e3).toBeDefined();
      expect(e3.internalStage).toBeNull();
      expect(e3.internalStage).toBe(e3.funnelStage);
    });

    it('retorna 7 stages vazios quando não há encuadres', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const [req, res] = mockReqRes({ id: 'jp-empty' });
      await controller.getEncuadreFunnel(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.data.totalEncuadres).toBe(0);
      expect(Object.keys(response.data.stages)).toHaveLength(7);
      Object.values(response.data.stages).forEach((stage: any) => {
        expect(stage).toHaveLength(0);
      });
    });

    it('ordena por wja.updated_at DESC — mais recentes primeiro', async () => {
      // Simula 3 encuadres COMPLETED retornados já ordenados pelo banco
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'newest', funnel_stage: 'COMPLETED' }),
          makeRow({ id: 'middle', funnel_stage: 'COMPLETED' }),
          makeRow({ id: 'oldest', funnel_stage: 'COMPLETED' }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      // 1) Verifica que a query SQL usa ORDER BY wja.updated_at DESC
      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toMatch(/ORDER BY\s+wja\.updated_at\s+DESC/i);

      // 2) Verifica que a ordem retornada pelo banco é preservada nas colunas
      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      const ids = stages.COMPLETED.map((e: any) => e.id);
      expect(ids).toEqual(['newest', 'middle', 'oldest']);
    });

    it('retorna acquisitionChannel no item quando preenchido, null quando ausente', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'e1', funnel_stage: 'INITIATED', acquisition_channel: 'facebook' }),
          makeRow({ id: 'e2', funnel_stage: 'INITIATED', acquisition_channel: null }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.INITIATED).toHaveLength(2);
      expect(stages.INITIATED.find((e: any) => e.id === 'e1').acquisitionChannel).toBe('facebook');
      expect(stages.INITIATED.find((e: any) => e.id === 'e2').acquisitionChannel).toBeNull();
    });

    it('retorna 500 em caso de erro no banco', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB down'));

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // getCoordinatorCapacity / getAlerts — inalterados
  // ═══════════════════════════════════════════════════════════════════

  describe('getCoordinatorCapacity', () => {
    it('returns coordinator metrics', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'c1', name: 'Maria', weekly_hours: '20.00',
            active_cases: 3, encuadres_this_week: 12,
            conversion_rate: '0.25', total_cases: 8,
          },
          {
            id: 'c2', name: 'Juan', weekly_hours: null,
            active_cases: 1, encuadres_this_week: 5,
            conversion_rate: null, total_cases: 3,
          },
        ],
      });

      const [req, res] = mockReqRes();
      await dashboardController.getCoordinatorCapacity(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.data).toHaveLength(2);
      expect(response.data[0]).toEqual({
        id: 'c1', name: 'Maria', weeklyHours: 20,
        activeCases: 3, encuadresThisWeek: 12,
        conversionRate: 0.25, totalCases: 8,
      });
    });
  });

  describe('getAlerts', () => {
    it('returns alerts with correct reasons', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 'jp1', case_number: 100, title: 'Caso 100',
            coordinator_name: 'Maria', search_start_date: '2024-01-01',
            is_covered: false, days_open: 450,
            total_encuadres: 250, selected_count: 0, recent_encuadres: 0,
          },
        ],
      });

      const [req, res] = mockReqRes();
      await dashboardController.getAlerts(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.data[0].alertReasons).toContain('MORE_THAN_200_ENCUADRES');
      expect(response.data[0].alertReasons).toContain('OPEN_MORE_THAN_30_DAYS');
      expect(response.data[0].alertReasons).toContain('NO_CANDIDATES_LAST_7_DAYS');
    });
  });
});
