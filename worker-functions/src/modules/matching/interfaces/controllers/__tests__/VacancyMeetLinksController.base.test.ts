/**
 * VacancyMeetLinksController.base.test.ts — os caminhos PRÉ-EXISTENTES do
 * controller (links fixos + lookup), que não tinham teste. Complementa o
 * `.recurring.test.ts` para o arquivo tocado fechar em 100% (D200.12).
 */
const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn();
const mockLogEventSafe = jest.fn();
const mockResolveDateTime = jest.fn();
const mockReportError = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery, connect: mockConnect }) }) },
}));
jest.mock('@shared/logging', () => ({ loggingAls: { getStore: () => undefined }, reportError: (...a: unknown[]) => mockReportError(...a) }));
jest.mock('../../../infrastructure/JobPostingAuditRepository', () => ({
  JobPostingAuditRepository: jest.fn().mockImplementation(() => ({ logEventSafe: mockLogEventSafe })),
}));
jest.mock('../../../infrastructure/GoogleCalendarService', () => ({
  googleCalendarService: {
    isValidMeetLink: (l: string) => /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(l),
    resolveDateTime: (...a: unknown[]) => mockResolveDateTime(...a),
  },
}));

import { Request, Response } from 'express';
import { VacancyMeetLinksController } from '../VacancyMeetLinksController';

const ID = '11111111-1111-1111-1111-111111111111';
const L1 = 'https://meet.google.com/abc-defg-hij';
const L2 = 'https://meet.google.com/klm-nopq-rst';
const L3 = 'https://meet.google.com/uvw-xyzab-cde'.replace('xyzab','xyza');

function makeRes(): Response & { statusCode: number; payload: unknown } {
  const res = { statusCode: 0, payload: undefined as unknown } as Response & { statusCode: number; payload: unknown };
  res.status = ((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = ((p: unknown) => { res.payload = p; return res; }) as never;
  return res;
}
const req = (body: unknown, params: Record<string, string> = { id: ID }) => ({ params, body }) as unknown as Request;

describe('VacancyMeetLinksController.updateMeetLinks — links fixos', () => {
  let controller: VacancyMeetLinksController;
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockResolvedValue({ query: mockClientQuery, release: mockRelease });
    mockQuery.mockResolvedValue({ rows: [{ id: ID }] });
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockResolveDateTime.mockImplementation(async (l: string) => (l === L1 ? '2027-04-05T11:30:00.000Z' : null));
    controller = new VacancyMeetLinksController();
  });

  it('body inválido → 400', async () => {
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: ['a'] }), res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: string }).error).toBe('Invalid request body');
  });

  it('link com formato inválido → 400 com o slot', async () => {
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: ['https://zoom.us/j/1', null, null] }), res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: string }).error).toBe('meet_links[0] has an invalid Google Meet URL format');
  });

  it('vaga inexistente → 404', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: [L1, null, null] }), res);
    expect(res.statusCode).toBe(404);
  });

  it('happy path: resolve datetime por link, grava os 6 campos numa transação e audita (sem ator, sem trace)', async () => {
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: [L1, L2, L3] }), res);
    expect(res.statusCode).toBe(200);
    expect(mockResolveDateTime).toHaveBeenCalledTimes(3);
    const update = mockClientQuery.mock.calls.find((c) => (c[0] as string).includes('UPDATE job_postings')) as [string, unknown[]];
    expect(update[1]).toEqual([L1, '2027-04-05T11:30:00.000Z', L2, null, L3, null, ID]);
    expect(mockClientQuery).toHaveBeenCalledWith('BEGIN');
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalled();
    expect(mockLogEventSafe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: null, traceId: null, fieldName: 'meet_links' }));
    expect((res.payload as { data: Record<string, unknown> }).data).toEqual({
      meet_link_1: L1, meet_datetime_1: '2027-04-05T11:30:00.000Z', meet_link_2: L2, meet_datetime_2: null, meet_link_3: L3, meet_datetime_3: null,
    });
  });

  it('erro na transação → ROLLBACK, release e 500 com reportError', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => { if (sql.includes('UPDATE')) throw new Error('db down'); return { rows: [] }; });
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: [L1, null, null] }), res);
    expect(res.statusCode).toBe(500);
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'VacancyMeetLinksController:updateMeetLinks' });
    expect((res.payload as { details: string }).details).toBe('db down');
  });

  it('erro não-Error → 500 com "Unknown error"', async () => {
    mockQuery.mockRejectedValueOnce('boom');
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: [L1, null, null] }), res);
    expect(res.statusCode).toBe(500);
    expect((res.payload as { details: string }).details).toBe('Unknown error');
  });
});

describe('VacancyMeetLinksController.lookupMeetDatetime', () => {
  let controller: VacancyMeetLinksController;
  beforeEach(() => { jest.clearAllMocks(); controller = new VacancyMeetLinksController(); });

  it('body inválido → 400', async () => {
    const res = makeRes();
    await controller.lookupMeetDatetime(req({}), res);
    expect(res.statusCode).toBe(400);
  });

  it('link inválido → 400 com normalized e datetime null', async () => {
    const res = makeRes();
    await controller.lookupMeetDatetime(req({ link: 'https://zoom.us/j/1' }), res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { data: { datetime: null } }).data.datetime).toBeNull();
  });

  it('link válido → 200 com normalized + datetime resolvido', async () => {
    mockResolveDateTime.mockResolvedValueOnce('2027-04-05T11:30:00.000Z');
    const res = makeRes();
    await controller.lookupMeetDatetime(req({ link: 'meet.google.com/ABC-DEFG-HIJ' }), res);
    expect(res.statusCode).toBe(200);
    expect((res.payload as { data: unknown }).data).toEqual({ normalized: L1, datetime: '2027-04-05T11:30:00.000Z' });
  });

  it('falha do Calendar → 500', async () => {
    mockResolveDateTime.mockRejectedValueOnce(new Error('calendar down'));
    const res = makeRes();
    await controller.lookupMeetDatetime(req({ link: L1 }), res);
    expect(res.statusCode).toBe(500);
    mockResolveDateTime.mockRejectedValueOnce('x');
    const res2 = makeRes();
    await controller.lookupMeetDatetime(req({ link: L1 }), res2);
    expect(res2.statusCode).toBe(500);
  });
});
