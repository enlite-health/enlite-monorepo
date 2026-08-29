/**
 * WJAFunnelController.branches.test.ts
 *
 * Cobre ramos que os outros arquivos de teste (WJAFunnelController.test.ts,
 * WJAFunnelController.moveEncuadre.test.ts e WJAFunnelController.branches2.test.ts
 * — todos já no teto de 400 linhas, regra do CLAUDE.md) não cobrem:
 *
 * - getEncuadreFunnel: fallback `.catch(() => null)` do decrypt KMS (nome de
 *   WJA e de worker bloqueado), quando o KMS falha para um valor específico;
 *   catch geral com rejeição não-Error
 * - moveEncuadre: papel (role) opcional ao selecionar — válido e inválido;
 *   erro NÃO relacionado a elegibilidade (rethrow → catch geral); mensagem de
 *   erro contendo "not found" → 404 pelo catch geral
 *
 * rejectBlockedApplication / undismissBlockedApplication (ramos extras) vivem
 * em WJAFunnelController.branches2.test.ts.
 */

const mockQuery = jest.fn();
const mockKmsDecrypt = jest.fn();
const mockListByVacancy = jest.fn();
const mockUndismiss = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue(
        (require('@shared/database/poolMockSupport') as typeof import('@shared/database/poolMockSupport')).poolMockWithConnect(mockQuery),
      ),
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
    dismiss: jest.fn(),
    undismiss: mockUndismiss,
  })),
}));

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
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

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    worker_id: 'wid-aaaa-bbbb-cccc-12345678',
    first_name_encrypted: null,
    last_name_encrypted: null,
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

describe('WJAFunnelController — ramos de erro/decrypt do KMS e de negócio', () => {
  let controller: WJAFunnelController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockListByVacancy.mockResolvedValue([]);
    mockUndismiss.mockResolvedValue(true);
    // Decrypt "quebrado" por padrão neste arquivo: só resolve para valores que
    // começam com 'ok:'; qualquer outro valor truthy rejeita (simula ciphertext
    // corrompido/chave errada) — exercita o .catch(() => null) do controller.
    mockKmsDecrypt.mockImplementation((value: string) => {
      if (typeof value === 'string' && value.startsWith('ok:')) {
        return Promise.resolve(value.slice('ok:'.length));
      }
      return Promise.reject(new Error('KMS decrypt failed'));
    });
    controller = new WJAFunnelController();
  });

  // ═══════════════════════════════════════════════════════════════════
  // getEncuadreFunnel — .catch(() => null) do decrypt
  // ═══════════════════════════════════════════════════════════════════

  describe('getEncuadreFunnel — decrypt do KMS falha para um campo específico', () => {
    it('WJA: first_name_encrypted quebrado (decrypt rejeita) → cai no catch(() => null), fallback por UUID', async () => {
      const workerId = 'aaaaaaaa-1111-2222-3333-deadbeef0001';
      mockQuery.mockResolvedValueOnce({
        rows: [
          makeRow({
            id: 'wja-broken',
            worker_id: workerId,
            first_name_encrypted: 'corrupted-cipher',
            last_name_encrypted: 'corrupted-cipher-2',
            funnel_stage: null,
          }),
        ],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      expect(mockKmsDecrypt).toHaveBeenCalledWith('corrupted-cipher');
      expect(mockKmsDecrypt).toHaveBeenCalledWith('corrupted-cipher-2');

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      const item = stages.INVITED.find((e: any) => e.id === 'wja-broken');
      expect(item).toBeDefined();
      // Ambos os decrypts falharam → fullName vazio → fallback por UUID (não crasha).
      expect(item.workerName).toBe(`Worker #${workerId.slice(-8)}`);
    });

    it('bloqueado: nome quebrado no KMS → cai no catch(() => null), workerName null (sem crash)', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // funil vazio
      mockListByVacancy.mockResolvedValue([
        {
          id: 'ba-broken',
          workerId: 'w-broken',
          blockedReason: 'registration_incomplete',
          missingFields: ['profession'],
          attemptCount: 1,
          acquisitionChannel: null,
          lastAttemptedAt: '2026-06-26T10:00:00.000Z',
          contactNotesCount: 0,
        },
      ]);
      // Query do worker bloqueado: nomes com ciphertext corrompido
      mockQuery.mockResolvedValueOnce({
        rows: [{ first_name_encrypted: 'corrupted-a', last_name_encrypted: 'corrupted-b', phone: '+5491199999' }],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      expect(mockKmsDecrypt).toHaveBeenCalledWith('corrupted-a');
      expect(mockKmsDecrypt).toHaveBeenCalledWith('corrupted-b');

      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.BLOQUEADO).toHaveLength(1);
      // Ambos os decrypts falharam → name null (nunca undefined/crash)
      expect(stages.BLOQUEADO[0].workerName).toBeNull();
      expect(stages.BLOQUEADO[0].workerPhone).toBe('+5491199999');
    });

    it('bloqueado: worker referenciado não existe mais em `workers` (0 linhas) → name/phone null, sem chamar KMS', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // funil vazio
      mockListByVacancy.mockResolvedValue([
        {
          id: 'ba-gone',
          workerId: 'w-deleted',
          blockedReason: 'registration_incomplete',
          missingFields: ['profession'],
          attemptCount: 1,
          acquisitionChannel: null,
          lastAttemptedAt: '2026-06-26T10:00:00.000Z',
          contactNotesCount: 0,
        },
      ]);
      // SELECT do worker não encontra ninguém (registro apagado/merge)
      mockQuery.mockResolvedValueOnce({ rows: [] });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      expect(mockKmsDecrypt).not.toHaveBeenCalled();
      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.BLOQUEADO[0].workerName).toBeNull();
      expect(stages.BLOQUEADO[0].workerPhone).toBeNull();
    });

    it('bloqueado: first_name/last_name AUSENTES (não corrompidos, null mesmo) → ternário toma o ramo `null`, sem chamar KMS; phone ausente vira null', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // funil vazio
      mockListByVacancy.mockResolvedValue([
        {
          id: 'ba-noname',
          workerId: 'w-noname',
          blockedReason: 'registration_incomplete',
          missingFields: ['profession'],
          attemptCount: 1,
          acquisitionChannel: null,
          lastAttemptedAt: '2026-06-26T10:00:00.000Z',
          contactNotesCount: 0,
        },
      ]);
      mockQuery.mockResolvedValueOnce({
        rows: [{ first_name_encrypted: null, last_name_encrypted: null, phone: null }],
      });

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      expect(mockKmsDecrypt).not.toHaveBeenCalled();
      const { stages } = (res.json as jest.Mock).mock.calls[0][0].data;
      expect(stages.BLOQUEADO[0].workerName).toBeNull();
      expect(stages.BLOQUEADO[0].workerPhone).toBeNull();
    });

    it('catch geral com rejeição NÃO Error (ex.: listByVacancy rejeita string) → normalizado via new Error(String(error))', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockListByVacancy.mockRejectedValueOnce('plain-string-rejection');

      const [req, res] = mockReqRes({ id: 'jp-001' });
      await controller.getEncuadreFunnel(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
        success: false,
        error: 'plain-string-rejection',
      });
      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'WJAFunnelController:getEncuadreFunnel' }),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // moveEncuadre — papel (role) opcional
  // ═══════════════════════════════════════════════════════════════════

  describe('moveEncuadre — role', () => {
    it('role inválido → 400, sem tocar o banco', async () => {
      const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'SELECTED', role: 'GERENTE' });
      await controller.moveEncuadre(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual(
        expect.objectContaining({ success: false, error: 'role must be one of: TITULAR, RAPID_RESPONSE' }),
      );
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('role=TITULAR válido ao mover para SELECTED → repassado ao UPDATE encuadres (COALESCE)', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
      });
      mockQuery.mockResolvedValueOnce({ rows: [{ status: 'REGISTERED' }] });
      mockQuery.mockResolvedValueOnce({ rows: [] }); // etapa anterior (evento funnel_stage.*, PEND-14)
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // upsert wja
      mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // UPDATE encuadres resultado+role
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'ev-1' }] }); // INSERT domain_events (funnel_stage.selected)
      (controller as unknown as { pubsub: { publish: jest.Mock } }).pubsub = { publish: jest.fn().mockResolvedValue(undefined) };

      const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'SELECTED', role: 'TITULAR' });
      await controller.moveEncuadre(req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { encuadreId: 'e1', targetStage: 'SELECTED' },
      });
      const updateCall = mockQuery.mock.calls[4]; // [3] é o upsert da WJA; a leitura da etapa anterior (PEND-14) entrou em [2]
      expect(updateCall[1]).toEqual(['e1', 'TITULAR']);
    });
  });

  // ═══════════════════════════════════════════════════════════════════
  // moveEncuadre — erro genérico (não WorkerNotEligibleError) no meio do fluxo
  // ═══════════════════════════════════════════════════════════════════

  describe('moveEncuadre — erro não relacionado a elegibilidade', () => {
    it('assertWorkerCanApply lança erro genérico (DB down) → rethrow → catch geral → 500', async () => {
      mockQuery.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ worker_id: 'w-1', job_posting_id: 'jp-1' }],
      });
      // A query de elegibilidade (SELECT status FROM workers) falha com erro genérico —
      // não é o "worker not found" (rows vazias) que gera WorkerNotEligibleError.
      mockQuery.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

      const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'CONFIRMED' });
      await controller.moveEncuadre(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
        success: false,
        error: 'connection terminated unexpectedly',
      });
    });

    it('rejeição NÃO Error (ex.: string) no catch geral → normalizada para "Unknown error", 500', async () => {
      mockQuery.mockRejectedValueOnce('plain-string-rejection');

      const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'CONFIRMED' });
      await controller.moveEncuadre(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
        success: false,
        error: 'Unknown error',
      });
    });

    it('erro cuja mensagem contém "not found" → catch geral responde 404 (não só o retorno explícito de encuadre ausente)', async () => {
      mockQuery.mockRejectedValueOnce(new Error('relation "x" not found in schema'));

      const [req, res] = mockReqRes({ id: 'e1' }, { targetStage: 'CONFIRMED' });
      await controller.moveEncuadre(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
        success: false,
        error: 'relation "x" not found in schema',
      });
    });
  });

});
