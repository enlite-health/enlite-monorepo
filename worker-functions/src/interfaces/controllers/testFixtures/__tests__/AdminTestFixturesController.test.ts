/**
 * AdminTestFixturesController.test.ts
 *
 * Teste unitário do controller (fino). Mocka DatabaseConnection, logging e o
 * use case — cobre o caminho feliz (200 + payload) e erro (500 + reportError).
 */

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({}),
    }),
  },
}));

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

jest.mock('../../../../application/testFixtures/CleanupTestFixturesUseCase');

import type { Request, Response } from 'express';
import { AdminTestFixturesController } from '../AdminTestFixturesController';
import { CleanupTestFixturesUseCase } from '../../../../application/testFixtures/CleanupTestFixturesUseCase';
import { reportError } from '@shared/logging';

function makeRes(): jest.Mocked<Pick<Response, 'status' | 'json'>> {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as jest.Mocked<Pick<Response, 'status' | 'json'>>;
}

function makeReq(): Request {
  return { params: {}, query: {}, body: {}, user: {} } as unknown as Request;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('AdminTestFixturesController', () => {
  describe('POST /cleanup', () => {
    it('200 + retorna { success: true, data: { deleted } } no caminho feliz', async () => {
      const deleted = {
        messaging_outbox: 2,
        worker_job_applications: 2,
        encuadres: 1,
        worker_service_areas: 1,
        worker_documents: 0,
        worker_availability: 0,
        worker_blocked_applications: 1,
        job_postings: 1,
        workers: 1,
      };
      (CleanupTestFixturesUseCase.prototype.execute as jest.Mock).mockResolvedValue({ deleted });

      const controller = new AdminTestFixturesController();
      const req = makeReq();
      const res = makeRes();

      await controller.cleanup(req, res as unknown as Response);

      expect(res.json).toHaveBeenCalledWith({ success: true, data: { deleted } });
      expect(res.status).not.toHaveBeenCalled();
    });

    it('500 + reportError quando o use case lança', async () => {
      const err = new Error('db offline');
      (CleanupTestFixturesUseCase.prototype.execute as jest.Mock).mockRejectedValue(err);

      const controller = new AdminTestFixturesController();
      const req = makeReq();
      const res = makeRes();

      await controller.cleanup(req, res as unknown as Response);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Erro interno' });
      expect(reportError).toHaveBeenCalledWith(err, { source: 'AdminTestFixturesController:cleanup' });
    });
  });
});
