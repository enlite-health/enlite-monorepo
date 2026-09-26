/**
 * WJAFunnelController.test.ts
 *
 * Tests the getEncuadreFunnel kanban endpoint — driven by application_funnel_stage
 * as the single source of truth.
 *
 * moveEncuadre tests live in WJAFunnelController.moveEncuadre.test.ts (split
 * to keep both files ≤400 lines).
 * Dashboard tests (getCoordinatorCapacity, getAlerts) live here too as they are small.
 *
 * Renamed from EncuadreFunnelController.test.ts in F7.a (migration 194).
 * Migration 230 (2026-06-26): INITIATED → PRE_SCREENING + INICIADO column added.
 * Feature BLOQUEADO (2026-07-03): worker_blocked_applications cards moved out of
 * INICIADO into their own BLOQUEADO column — INICIADO is now real WJAs only.
 */

const mockQuery = jest.fn();
const mockKmsDecrypt = jest.fn();
const mockListByVacancy = jest.fn();
const mockDismiss = jest.fn();
const mockUndismiss = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockQuery,
      }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: mockKmsDecrypt,
  })),
}));

jest.mock('../../../infrastructure/BlockedApplicationQueryRepository', () => ({
  BlockedApplicationQueryRepository: jest.fn().mockImplementation(() => ({
    listByVacancy: mockListByVacancy,
  })),
}));

jest.mock('../../../infrastructure/BlockedApplicationRepository', () => ({
  BlockedApplicationRepository: jest.fn().mockImplementation(() => ({
    dismiss: mockDismiss,
    undismiss: mockUndismiss,
  })),
}));

import { WJAFunnelController } from '../WJAFunnelController';
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
    worker_id: 'wid-aaaa-bbbb-cccc-12345678',
    first_name_encrypted: 'encrypted:first',
    last_name_encrypted: 'encrypted:last',
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
    source: null,
    talentum_status: null,
    work_zone: null,
    ...overrides,
  };
}

describe('WJAFunnelController', () => {
  let controller: WJAFunnelController;
  let dashboardController: EncuadreDashboardController;

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no blocked attempts (most tests don't test that path)
    mockListByVacancy.mockResolvedValue([]);
    // Default: dismiss/undismiss succeed (row found)
    mockDismiss.mockResolvedValue(true);
    mockUndismiss.mockResolvedValue(true);
    // Default KMS mock: decrypta prefixo 'encrypted:' → resto. Permite asserts diretos.
    mockKmsDecrypt.mockImplementation((value: string) => {
      if (typeof value === 'string' && value.startsWith('encrypted:')) {
        return Promise.resolve(value.slice('encrypted:'.length));
      }
      return Promise.reject(new Error('KMS decrypt failed'));
    });
    controller = new WJAFunnelController();
    dashboardController = new EncuadreDashboardController();
  });

  // ═══════════════════════════════════════════════════════════════════
  // getEncuadreFunnel — classificação por application_funnel_stage
  // Migration 230 + D433: 8 colunas (INVITED, INICIADO, PRE_SCREENING,
  //                        IN_PROGRESS, COMPLETED, CONFIRMED, SELECTED, REJECTED)
  // ═══════════════════════════════════════════════════════════════════

  describe('getEncuadreFunnel', () => {
    it('classifica encuadres nas 8 colunas por funnel_stage (migration 230 + D433)', async () => {
      // Migration 230: INITIATED renomeado para PRE_SCREENING; INICIADO adicionado.
      // F3: NOT_QUALIFIED não existe mais em prod (migration 191 backfill → REJECTED)
      // F7.a: PLACED removido (migration 194 — 0 linhas em prod, sync F6 morta)
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'e1', funnel_stage: null }),
          // system+INVITED counts only when actually messaged (real invite) — AC2 86ajb48v1
          makeRow({ id: 'e2', funnel_stage: 'INVITED', source: 'system', messaged_at: '2026-07-09T10:00:00Z' }),
          makeRow({ id: 'e-manual', funnel_stage: 'INVITED', source: 'manual', messaged_at: '2026-08-28T10:00:00Z', resend_blocked_until: '2026-08-29T10:00:00Z' }),
          makeRow({ id: 'e3', funnel_stage: 'PRE_SCREENING', talentum_status: 'PRE_SCREENING' }),
          makeRow({ id: 'e4', funnel_stage: 'IN_PROGRESS', talentum_status: 'IN_PROGRESS' }),
          makeRow({ id: 'e5', funnel_stage: 'COMPLETED', talentum_status: 'COMPLETED' }),
          makeRow({ id: 'e6', funnel_stage: 'QUALIFIED', talentum_status: 'QUALIFIED' }),
          makeRow({ id: 'e7', funnel_stage: 'IN_DOUBT', talentum_status: 'IN_DOUBT' }),
          makeRow({ id: 'e8', funnel_stage: 'CONFIRMED' }),
          makeRow({ id: 'e9', funnel_stage: 'SELECTED' }),
          makeRow({ id: 'e10', funnel_stage: 'REJECTED' }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.data.totalEncuadres).toBe(11);

      const { stages } = response.data;

      // 8 colunas no kanban (migration 230 + D433)
      expect(Object.keys(stages)).toHaveLength(8);

      // NULL → INVITED (coluna de auto-invite / sem source)
      expect(stages.INVITED).toHaveLength(2); // e1 (null stage) + e2 (INVITED+system)
      const invitedIds = (stages.INVITED as Array<{ id: string }>).map(e => e.id);
      expect(invitedIds).toContain('e1');
      expect(invitedIds).toContain('e2');
      // REQ-08: o card carrega o último envio (messaged_at) em ISO — é o que o
      // botão "Reenviar" mostra como "Último envío"; sem envio → null.
      const e2 = (stages.INVITED as Array<{ id: string; lastMessagedAt: string | null; resendBlockedReason: unknown }>).find(e => e.id === 'e2');
      expect(e2?.lastMessagedAt).toBe('2026-07-09T10:00:00.000Z');
      const e1 = (stages.INVITED as Array<{ id: string; lastMessagedAt: string | null }>).find(e => e.id === 'e1');
      expect(e1?.lastMessagedAt).toBeNull();
      // D200.1: sem envio na janela → botão livre (null); dentro da janela → motivo + quando abre.
      expect(e2?.resendBlockedReason).toBeNull();
      const manual = (stages.INICIADO as Array<{ id: string; resendBlockedReason: unknown }>).find(e => e.id === 'e-manual');
      expect(manual?.resendBlockedReason).toEqual({ code: 'RESEND_COOLDOWN', until: '2026-08-29T10:00:00.000Z' });
      // A janela (horas) vai como parâmetro da MESMA query do funil — fonte única com o guard.
      const [funnelSql, funnelParams] = mockQuery.mock.calls[0];
      expect(funnelSql).toMatch(/AS resend_blocked_until/);
      expect(funnelParams).toEqual(['jp-001', 24]);

      // INVITED+source='manual' → INICIADO
      expect(stages.INICIADO).toHaveLength(1);
      expect(stages.INICIADO[0].id).toBe('e-manual');

      // PRE_SCREENING (antigo INITIATED — migration 230)
      expect(stages.PRE_SCREENING).toHaveLength(1);
      expect(stages.PRE_SCREENING[0].id).toBe('e3');

      // IN_PROGRESS
      expect(stages.IN_PROGRESS).toHaveLength(1);
      expect(stages.IN_PROGRESS[0].id).toBe('e4');

      // COMPLETED agrupa COMPLETED + QUALIFIED + IN_DOUBT
      expect(stages.COMPLETED).toHaveLength(3);
      const completedIds = (stages.COMPLETED as Array<{ id: string }>).map(e => e.id);
      expect(completedIds).toContain('e5');
      expect(completedIds).toContain('e6');
      expect(completedIds).toContain('e7');

      // CONFIRMED
      expect(stages.CONFIRMED).toHaveLength(1);
      expect(stages.CONFIRMED[0].id).toBe('e8');

      // SELECTED
      expect(stages.SELECTED).toHaveLength(1);
      expect(stages.SELECTED[0].id).toBe('e9');

      // REJECTED
      expect(stages.REJECTED).toHaveLength(1);
      expect(stages.REJECTED[0].id).toBe('e10');
    });

    it('AC2 (86ajb48v1): system match never messaged NÃO conta em Invitados (métrica falsa)', async () => {
      // Rodar o match persiste TODOS os top-N como INVITED/system. Só um envio
      // real (messaged_at) vira convite. Aqui: 3 matches system, só 1 enviado.
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'm1', funnel_stage: 'INVITED', source: 'system', messaged_at: null }),
          makeRow({ id: 'm2', funnel_stage: 'INVITED', source: 'system', messaged_at: null }),
          makeRow({ id: 'sent', funnel_stage: 'INVITED', source: 'system', messaged_at: '2026-07-09T10:00:00Z' }),
          makeRow({ id: 'manual', funnel_stage: 'INVITED', source: 'manual', messaged_at: null }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-002' });
      await controller.getEncuadreFunnel(req, res);

      const { data } = (res.json as jest.Mock).mock.calls[0][0];
      const invitedIds = (data.stages.INVITED as Array<{ id: string }>).map(e => e.id);

      // Só o realmente enviado aparece em Invitados — não os 2 match candidates.
      expect(data.stages.INVITED).toHaveLength(1);
      expect(invitedIds).toEqual(['sent']);
      // manual continua indo pra INICIADO (não é system, não é filtrado)
      expect((data.stages.INICIADO as unknown[]).length).toBe(1);
      // totalEncuadres reflete só os cards visíveis (exclui os 2 match candidates)
      expect(data.totalEncuadres).toBe(2);
    });

    it('cards bloqueados aparecem em REJECTED (não INICIADO) com isBlocked=true, workerPhone e contactNotesCount (D433)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockListByVacancy.mockResolvedValue([
        {
          id: 'ba-1',
          workerId: 'w-blocked-001',
          blockedReason: 'registration_incomplete',
          missingFields: ['profession', 'phone'],
          attemptCount: 3,
          acquisitionChannel: 'facebook',
          lastAttemptedAt: '2026-06-26T10:00:00.000Z',
          contactNotesCount: 2,
        },
      ]);
      // blocked repo busca nome + phone (plaintext) do worker
      mockQuery.mockResolvedValue({
        rows: [{ first_name_encrypted: 'encrypted:Ana', last_name_encrypted: 'encrypted:Blocked', phone: '+5491100000' }],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.REJECTED).toHaveLength(1);
      expect(stages.INICIADO).toHaveLength(0);

      const card = stages.REJECTED[0] as Record<string, unknown>;
      expect(card.id).toBe('ba-1');
      expect(card.isBlocked).toBe(true);
      expect(card.blockedReason).toBe('registration_incomplete');
      expect(card.missingFields).toEqual(['profession', 'phone']);
      expect(card.attemptCount).toBe(3);
      expect(card.acquisitionChannel).toBe('facebook');
      expect(card.encuadreId).toBeNull();
      expect(card.workerName).toBe('Ana Blocked');
      // migration 235: contactNotesCount vem do blockedRepo (não mais hardcoded 0)
      expect(card.contactNotesCount).toBe(2);
      // workerPhone passa a ser preenchido (plaintext — workers.phone, sem KMS)
      expect(card.workerPhone).toBe('+5491100000');
    });

    it('card bloqueado com worker_not_found → workerName null, sem crash (coluna REJECTED)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockListByVacancy.mockResolvedValue([
        {
          id: 'ba-2',
          workerId: null,
          blockedReason: 'registration_incomplete',
          missingFields: ['profession'],
          attemptCount: 1,
          acquisitionChannel: null,
          lastAttemptedAt: '2026-06-26T10:00:00.000Z',
          contactNotesCount: 0,
        },
      ]);

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.REJECTED).toHaveLength(1);
      expect(stages.REJECTED[0].workerName).toBeNull();
      expect(stages.REJECTED[0].workerPhone).toBeNull();
      expect(stages.REJECTED[0].isBlocked).toBe(true);
    });

    it('bloqueado RECHAZADO (dismissedAt setado) vai para REJECTED como card de bloqueado, com motivo e isDismissed', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockListByVacancy.mockResolvedValue([
        {
          id: 'ba-dismissed',
          workerId: 'w-x',
          blockedReason: 'registration_incomplete',
          missingFields: ['profession'],
          attemptCount: 2,
          acquisitionChannel: null,
          lastAttemptedAt: '2026-06-26T10:00:00.000Z',
          contactNotesCount: 0,
          dismissedAt: '2026-07-22T10:00:00.000Z',
          dismissedReason: 'WORKER_DECLINED',
        },
      ]);
      mockQuery.mockResolvedValue({
        rows: [{ first_name_encrypted: 'encrypted:Ana', last_name_encrypted: 'encrypted:X', phone: '+549110' }],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.REJECTED).toHaveLength(1);
      const card = stages.REJECTED[0] as Record<string, unknown>;
      expect(card.id).toBe('ba-dismissed');
      expect(card.isBlocked).toBe(true);
      expect(card.isDismissed).toBe(true);
      expect(card.encuadreId).toBeNull(); // não-arrastável
      expect(card.rejectionReasonCategory).toBe('WORKER_DECLINED'); // badge de motivo
    });

    it('dedup: bloqueado promovido some de REJECTED e aparece como WJA real em INICIADO (NOT EXISTS no SQL)', async () => {
      // O dedup é implementado no SQL de listByVacancy via NOT EXISTS: uma linha
      // promovida (worker completou cadastro) já tem WJA real, então listByVacancy
      // não a retorna mais — sai de REJECTED e o card real aparece em INICIADO.
      mockQuery.mockResolvedValueOnce({
        rows: [makeRow({ id: 'e-wja', funnel_stage: 'INVITED', source: 'manual' })],
      });
      mockListByVacancy.mockResolvedValue([]); // dedup: bloqueado não retorna pois WJA existe (promovida)

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.REJECTED).toHaveLength(0);
      // Só o WJA manual aparece em INICIADO
      expect(stages.INICIADO).toHaveLength(1);
      expect(stages.INICIADO[0].id).toBe('e-wja');
      expect(stages.INICIADO[0].isBlocked).toBeUndefined();
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

    it('expõe internalStage em cada item do payload (F7.c: funnelStage removido)', async () => {
      // F7.c (ADR-004): funnelStage era alias 100% redundante de internalStage — removido.
      // Frontend usa apenas internalStage para renderizar badge.
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
      expect(e1.funnelStage).toBeUndefined(); // F7.c: removido

      const e2 = stages.IN_PROGRESS.find((e: any) => e.id === 'e2');
      expect(e2).toBeDefined();
      expect(e2.internalStage).toBe('IN_PROGRESS');
      expect(e2.funnelStage).toBeUndefined(); // F7.c: removido

      // null stage: internalStage deve ser null (não undefined)
      const e3 = stages.INVITED.find((e: any) => e.id === 'e3');
      expect(e3).toBeDefined();
      expect(e3.internalStage).toBeNull();
      expect(e3.funnelStage).toBeUndefined(); // F7.c: removido
    });

    it('decrypta workerName via KMS; fallback Worker #<uuid-tail> quando sem nome (LGPD: sem email)', async () => {
      // Cenários: (1) decrypt OK, (2) só firstName, (3) sem first/last → fallback UUID parcial, (4) sem worker_id → "sem identificação"
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({
            id: 'wja-1',
            worker_id: 'aaaaaaaa-1111-2222-3333-444455556666',
            first_name_encrypted: 'encrypted:Ana',
            last_name_encrypted: 'encrypted:Lima',
            funnel_stage: null,
          }),
          makeRow({
            id: 'wja-2',
            worker_id: 'bbbbbbbb-1111-2222-3333-777788889999',
            first_name_encrypted: 'encrypted:Carlos',
            last_name_encrypted: null,
            funnel_stage: null,
          }),
          makeRow({
            id: 'wja-3',
            worker_id: 'cccccccc-aaaa-bbbb-cccc-deadbeef1234',
            first_name_encrypted: null,
            last_name_encrypted: null,
            funnel_stage: null,
          }),
          makeRow({
            id: 'wja-4',
            worker_id: null,
            first_name_encrypted: null,
            last_name_encrypted: null,
            funnel_stage: null,
          }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      const items = stages.INVITED as Array<{ id: string; workerName: string }>;
      expect(items.find(c => c.id === 'wja-1')!.workerName).toBe('Ana Lima');
      expect(items.find(c => c.id === 'wja-2')!.workerName).toBe('Carlos');
      // LGPD: sem email; fallback é UUID parcial dos últimos 8 chars (Worker #beef1234)
      expect(items.find(c => c.id === 'wja-3')!.workerName).toBe('Worker #beef1234');
      expect(items.find(c => c.id === 'wja-4')!.workerName).toBe('Worker sem identificação');
    });

    it('retorna 8 stages vazios quando não há encuadres nem bloqueados (migration 230 + D433)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const [req, res] = mockReqRes({ id: 'jp-empty' });
      await controller.getEncuadreFunnel(req, res);

      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.data.totalEncuadres).toBe(0);
      // 8 colunas: INVITED, INICIADO, PRE_SCREENING, IN_PROGRESS, COMPLETED, CONFIRMED, SELECTED, REJECTED
      expect(Object.keys(response.data.stages)).toHaveLength(8);
      Object.values(response.data.stages).forEach((stage: any) => {
        expect(stage).toHaveLength(0);
      });
    });

    it('stages não contém BLOQUEADO nem INITIATED (migration 230 + D433)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect('INITIATED' in stages).toBe(false);
      expect('BLOQUEADO' in stages).toBe(false);
      expect('INICIADO' in stages).toBe(true);
      expect('PRE_SCREENING' in stages).toBe(true);
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
          makeRow({ id: 'e1', funnel_stage: 'PRE_SCREENING', acquisition_channel: 'facebook' }),
          makeRow({ id: 'e2', funnel_stage: 'PRE_SCREENING', acquisition_channel: null }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.PRE_SCREENING).toHaveLength(2);
      expect(stages.PRE_SCREENING.find((e: any) => e.id === 'e1').acquisitionChannel).toBe('facebook');
      expect(stages.PRE_SCREENING.find((e: any) => e.id === 'e2').acquisitionChannel).toBeNull();
    });

    it('retorna distanceKm no item a partir de distance_km (DX-3.10); SQL usa a área viva mais próxima', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({ id: 'e1', funnel_stage: 'PRE_SCREENING', distance_km: 3.2 }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.PRE_SCREENING[0].distanceKm).toBe(3.2);

      const sql: string = mockQuery.mock.calls[0][0];
      expect(sql).toContain('worker_service_areas wsa_d');
    });

    it('retorna 500 em caso de erro no banco', async () => {
      mockQuery.mockRejectedValueOnce(new Error('DB down'));

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // rejectBlockedApplication — "Rechazar" (soft-dismiss) de um card BLOQUEADO
  // Marca dismissed_at+motivo → card vai p/ RECHAZADOS (não cria WJA).
  // ═══════════════════════════════════════════════════════════════════

  describe('rejectBlockedApplication', () => {
    const VALID_UUID = 'aaaaaaaa-1111-2222-3333-444455556666';

    it('200 + chama dismiss(blockedId, motivo) quando a entrada é válida', async () => {
      const [req, res] = mockReqRes({ blockedId: VALID_UUID }, { rejectionReasonCategory: 'WORKER_DECLINED' });
      await controller.rejectBlockedApplication(req, res);

      expect(mockDismiss).toHaveBeenCalledWith(VALID_UUID, 'WORKER_DECLINED');
      const response = (res.json as jest.Mock).mock.calls[0][0];
      expect(response.success).toBe(true);
      expect(response.data.blockedId).toBe(VALID_UUID);
      expect(response.data.dismissedReason).toBe('WORKER_DECLINED');
    });

    it('404 quando a tentativa não existe (dismiss retorna false)', async () => {
      mockDismiss.mockResolvedValue(false);

      const [req, res] = mockReqRes({ blockedId: VALID_UUID }, { rejectionReasonCategory: 'OTHER' });
      await controller.rejectBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('400 quando o blockedId não é um UUID (sem tocar o repo)', async () => {
      const [req, res] = mockReqRes({ blockedId: 'not-a-uuid' }, { rejectionReasonCategory: 'OTHER' });
      await controller.rejectBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockDismiss).not.toHaveBeenCalled();
    });

    it('400 quando o motivo é inválido/ausente (sem tocar o repo)', async () => {
      const [req, res] = mockReqRes({ blockedId: VALID_UUID }, { rejectionReasonCategory: 'NOPE' });
      await controller.rejectBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockDismiss).not.toHaveBeenCalled();

      const [req2, res2] = mockReqRes({ blockedId: VALID_UUID }, {});
      await controller.rejectBlockedApplication(req2, res2);
      expect(res2.status).toHaveBeenCalledWith(400);
    });

    it('500 quando o repo lança', async () => {
      mockDismiss.mockRejectedValue(new Error('DB down'));

      const [req, res] = mockReqRes({ blockedId: VALID_UUID }, { rejectionReasonCategory: 'OTHER' });
      await controller.rejectBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // undismissBlockedApplication — "Voltar a bloqueados"
  // ═══════════════════════════════════════════════════════════════════

  describe('undismissBlockedApplication', () => {
    const VALID_UUID = 'bbbbbbbb-1111-2222-3333-444455556666';

    it('200 + chama undismiss(blockedId)', async () => {
      const [req, res] = mockReqRes({ blockedId: VALID_UUID });
      await controller.undismissBlockedApplication(req, res);

      expect(mockUndismiss).toHaveBeenCalledWith(VALID_UUID);
      expect((res.json as jest.Mock).mock.calls[0][0].success).toBe(true);
    });

    it('404 quando não existe (undismiss retorna false)', async () => {
      mockUndismiss.mockResolvedValue(false);

      const [req, res] = mockReqRes({ blockedId: VALID_UUID });
      await controller.undismissBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('400 quando o blockedId não é um UUID', async () => {
      const [req, res] = mockReqRes({ blockedId: 'nope' });
      await controller.undismissBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(mockUndismiss).not.toHaveBeenCalled();
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
