/**
 * WJAFunnelController.branches2.test.ts
 *
 * Continuação de WJAFunnelController.branches.test.ts — extraído para manter
 * ambos os arquivos ≤400 linhas (regra do CLAUDE.md):
 * - rejectBlockedApplication: `req.body ?? {}` e catch com valor NÃO Error
 * - undismissBlockedApplication: repo lança (Error e valor NÃO Error) → catch
 *   geral → 500 + reportError
 */

const mockUndismiss = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    decrypt: jest.fn(),
  })),
}));

jest.mock('../../../infrastructure/BlockedApplicationQueryRepository', () => ({
  BlockedApplicationQueryRepository: jest.fn().mockImplementation(() => ({
    listByVacancy: jest.fn().mockResolvedValue([]),
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

describe('WJAFunnelController — rejectBlockedApplication / undismissBlockedApplication (ramos extras)', () => {
  let controller: WJAFunnelController;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUndismiss.mockResolvedValue(true);
    controller = new WJAFunnelController();
  });

  describe('rejectBlockedApplication — ramos extras', () => {
    const VALID_UUID = 'dddddddd-1111-2222-3333-444455556666';

    it('req.body ausente (undefined) → cai no `?? {}`, trata como motivo faltando → 400', async () => {
      const req = { params: { blockedId: VALID_UUID }, body: undefined, query: {} } as unknown as Request;
      const res = {
        json: jest.fn().mockReturnThis(),
        status: jest.fn().mockReturnThis(),
      } as unknown as Response;

      await controller.rejectBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('repo.dismiss lança valor NÃO Error → catch normaliza e responde 500', async () => {
      ((controller as any).blockedWriteRepo.dismiss as jest.Mock).mockRejectedValueOnce('plain-string-rejection');

      const [req, res] = mockReqRes({ blockedId: VALID_UUID }, { rejectionReasonCategory: 'WORKER_DECLINED' });
      await controller.rejectBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({
        success: false,
        error: 'Unknown error',
      });
      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'WJAFunnelController.rejectBlockedApplication' }),
      );
    });
  });

  describe('undismissBlockedApplication — repo lança', () => {
    const VALID_UUID = 'cccccccc-1111-2222-3333-444455556666';

    it('500 + reportError quando undismiss lança', async () => {
      mockUndismiss.mockRejectedValueOnce(new Error('DB down'));

      const [req, res] = mockReqRes({ blockedId: VALID_UUID });
      await controller.undismissBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: false, error: 'DB down' });
      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'WJAFunnelController.undismissBlockedApplication' }),
      );
    });

    it('undismiss lança valor NÃO Error → catch normaliza para "Unknown error", 500', async () => {
      mockUndismiss.mockRejectedValueOnce('plain-string-rejection');

      const [req, res] = mockReqRes({ blockedId: VALID_UUID });
      await controller.undismissBlockedApplication(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect((res.json as jest.Mock).mock.calls[0][0]).toEqual({ success: false, error: 'Unknown error' });
      expect(mockReportError).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ source: 'WJAFunnelController.undismissBlockedApplication' }),
      );
    });
  });
});
