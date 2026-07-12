/**
 * WorkerVacancyDeliveryStatusController.test.ts
 *
 * Endpoint READ-ONLY: GET /api/admin/vacancies/:vacancyId/workers/:workerId/delivery-status
 * Usado pelo E2E do funil de WhatsApp pra verificar entrega sem tocar no banco direto.
 *
 * Cenários:
 *  1. 400 quando vacancyId/workerId não são UUID
 *  2. 404 quando não existe WJA (worker_id, job_posting_id)
 *  3. 200 com wjaStage='INVITED' + outbox.deliveryStatus='delivered'
 */

const mockGetStatus = jest.fn();

jest.mock('../workerVacancyDeliveryStatusHelper', () => ({
  getWorkerVacancyDeliveryStatus: (...args: unknown[]) => mockGetStatus(...args),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) },
}));

import { WorkerVacancyDeliveryStatusController } from '../WorkerVacancyDeliveryStatusController';
import { Request, Response } from 'express';

const WORKER_ID = 'aaaa0000-0000-0000-0000-111111111111';
const VACANCY_ID = 'bbbb0000-0000-0000-0000-222222222222';

function mockReqRes(params: Record<string, string>): [Request, Response] {
  const req = { params } as unknown as Request;
  const res = {
    json: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

describe('WorkerVacancyDeliveryStatusController', () => {
  let controller: WorkerVacancyDeliveryStatusController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new WorkerVacancyDeliveryStatusController();
  });

  it('400 quando vacancyId/workerId não são UUID', async () => {
    const [req, res] = mockReqRes({ vacancyId: 'not-a-uuid', workerId: WORKER_ID });
    await controller.getDeliveryStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mockGetStatus).not.toHaveBeenCalled();
  });

  it('404 quando não existe WJA', async () => {
    mockGetStatus.mockResolvedValueOnce({ kind: 'not_found' });
    const [req, res] = mockReqRes({ vacancyId: VACANCY_ID, workerId: WORKER_ID });

    await controller.getDeliveryStatus(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('200 com wjaStage=INVITED e outbox.deliveryStatus=delivered', async () => {
    mockGetStatus.mockResolvedValueOnce({
      kind: 'ok',
      wjaStage: 'INVITED',
      outbox: {
        status: 'sent',
        deliveryStatus: 'delivered',
        twilioSid: 'MM123',
        channel: 'twilio',
        templateSlug: 'vacancy_invite',
      },
    });
    const [req, res] = mockReqRes({ vacancyId: VACANCY_ID, workerId: WORKER_ID });

    await controller.getDeliveryStatus(req, res);

    expect(mockGetStatus).toHaveBeenCalledWith(expect.anything(), WORKER_ID, VACANCY_ID);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      data: {
        wjaStage: 'INVITED',
        outbox: {
          status: 'sent',
          deliveryStatus: 'delivered',
          twilioSid: 'MM123',
          channel: 'twilio',
          templateSlug: 'vacancy_invite',
        },
      },
    });
  });
});
