/**
 * PublicJobsController.test.ts
 *
 * Scenarios:
 *   1. 200 — returns data array with Cache-Control header
 *   2. 200 — returns empty array when no matching vacancies
 *   3. 500 — returns error when use case throws
 *   4. Response shape includes success + data fields
 */

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({ query: jest.fn() }),
    }),
  },
}));

jest.mock('../../../application/ListActivePublicJobsUseCase');

import { PublicJobsController } from '../PublicJobsController';
import { ListActivePublicJobsUseCase } from '../../../application/ListActivePublicJobsUseCase';
import { Request, Response } from 'express';

const MockedUseCase = ListActivePublicJobsUseCase as jest.MockedClass<typeof ListActivePublicJobsUseCase>;

function mockReqRes(): [Request, Response] {
  const req = { ip: '127.0.0.1' } as unknown as Request;
  const res = {
    setHeader: jest.fn().mockReturnThis(),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
  return [req, res];
}

const SAMPLE_JOB = {
  id: 'uuid-1',
  case_number: 10,
  vacancy_number: 1,
  title: 'CASO 10-1',
  status: 'SEARCHING',
  description: 'Real description',
  schedule_days_hours: null,
  worker_profile_sought: null,
  service: 'DOMICILIO',
  pathologies: 'TEA',
  state: 'Buenos Aires',
  city: 'Palermo',
  detail_link: 'https://srt.io/abc',
  worker_type: ['AT'],
  worker_sex: null,
  job_zone: 'NORTE',
  neighborhood: 'Palermo',
  state_city: 'Buenos Aires / CABA',
};

describe('PublicJobsController.listActiveJobs', () => {
  let controller: PublicJobsController;
  let mockExecute: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute = jest.fn();
    MockedUseCase.mockImplementation(() => ({
      execute: mockExecute,
    }) as unknown as ListActivePublicJobsUseCase);
    controller = new PublicJobsController();
  });

  it('returns 200 with data array and Cache-Control header', async () => {
    mockExecute.mockResolvedValueOnce([SAMPLE_JOB]);

    const [req, res] = mockReqRes();
    await controller.listActiveJobs(req, res);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'public, max-age=300, s-maxage=600',
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [SAMPLE_JOB] });
  });

  it('returns 200 with empty array when no matching vacancies', async () => {
    mockExecute.mockResolvedValueOnce([]);

    const [req, res] = mockReqRes();
    await controller.listActiveJobs(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  it('returns 500 with error message when use case throws', async () => {
    mockExecute.mockRejectedValueOnce(new Error('DB connection lost'));

    const [req, res] = mockReqRes();
    await controller.listActiveJobs(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Failed to fetch public jobs',
    });
  });

  it('returns 500 with generic message for non-Error throws', async () => {
    mockExecute.mockRejectedValueOnce('string error');

    const [req, res] = mockReqRes();
    await controller.listActiveJobs(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Failed to fetch public jobs',
    });
  });

  it('returns multiple jobs in the data array', async () => {
    const jobs = [SAMPLE_JOB, { ...SAMPLE_JOB, id: 'uuid-2', case_number: 11, title: 'CASO 11-1' }];
    mockExecute.mockResolvedValueOnce(jobs);

    const [req, res] = mockReqRes();
    await controller.listActiveJobs(req, res);

    const response = (res.json as jest.Mock).mock.calls[0][0];
    expect(response.data).toHaveLength(2);
  });
});
