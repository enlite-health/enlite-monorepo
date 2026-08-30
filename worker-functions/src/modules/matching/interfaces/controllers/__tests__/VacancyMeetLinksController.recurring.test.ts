/**
 * VacancyMeetLinksController.recurring.test.ts — o slot RECORRENTE no PUT meet-links (mig 291).
 * Merge Patch: `recurring` ausente = não mexe; `null` = limpa; objeto = grava (link normalizado).
 */
const mockQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });
const mockLogEventSafe = jest.fn();
const mockResolveDateTime = jest.fn();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery, connect: mockConnect }) }) },
}));
jest.mock('@shared/logging', () => ({ loggingAls: { getStore: () => ({ traceId: 'trace-1' }) }, reportError: jest.fn() }));
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
import { VacancyMeetLinksController, RecurringSlotSchema } from '../VacancyMeetLinksController';

const ID = '11111111-1111-1111-1111-111111111111';
const LINK = 'https://meet.google.com/abc-defg-hij';

function makeRes(): Response & { statusCode: number; payload: unknown } {
  const res = { statusCode: 0, payload: undefined as unknown } as Response & { statusCode: number; payload: unknown };
  res.status = ((c: number) => { res.statusCode = c; return res; }) as never;
  res.json = ((p: unknown) => { res.payload = p; return res; }) as never;
  return res;
}
const req = (body: unknown) => ({ params: { id: ID }, body, user: { uid: 'staff-1' } }) as unknown as Request;
const updateCall = () => mockClientQuery.mock.calls.find((c) => (c[0] as string).includes('UPDATE job_postings')) as [string, unknown[]];

describe('RecurringSlotSchema', () => {
  it('aceita weekday 0..6, HH:MM e link; rejeita o resto (strict)', () => {
    expect(RecurringSlotSchema.safeParse({ weekday: 1, time: '08:30', link: LINK }).success).toBe(true);
    expect(RecurringSlotSchema.safeParse({ weekday: 7, time: '08:30', link: LINK }).success).toBe(false);
    expect(RecurringSlotSchema.safeParse({ weekday: 1, time: '8:30', link: LINK }).success).toBe(false);
    expect(RecurringSlotSchema.safeParse({ weekday: 1, time: '24:00', link: LINK }).success).toBe(false);
    expect(RecurringSlotSchema.safeParse({ weekday: 1, time: '08:30', link: LINK, extra: 1 }).success).toBe(false);
  });
});

describe('VacancyMeetLinksController.updateMeetLinks — recurring', () => {
  let controller: VacancyMeetLinksController;
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue({ rows: [{ id: ID }] });
    mockClientQuery.mockResolvedValue({ rows: [] });
    mockResolveDateTime.mockResolvedValue(null);
    controller = new VacancyMeetLinksController();
  });

  it('recurring ausente → o UPDATE não toca as colunas do recorrente e a resposta não as menciona', async () => {
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: [null, null, null] }), res);
    expect(res.statusCode).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).not.toContain('meet_recurring');
    expect(params).toHaveLength(7);
    expect((res.payload as { data: Record<string, unknown> }).data).not.toHaveProperty('meet_recurring');
  });

  it('recurring objeto → grava weekday/time/link normalizado ($8..$10), audita e devolve', async () => {
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: [null, null, null], recurring: { weekday: 1, time: '08:30', link: 'meet.google.com/ABC-DEFG-HIJ' } }), res);
    expect(res.statusCode).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).toMatch(/meet_recurring_weekday = \$8/);
    expect(sql).toMatch(/meet_recurring_time\s+= \$9::time/);
    expect(sql).toMatch(/meet_recurring_link\s+= \$10/);
    expect(params.slice(7)).toEqual([1, '08:30', LINK]);
    expect((res.payload as { data: { meet_recurring: unknown } }).data.meet_recurring).toEqual({ weekday: 1, time: '08:30', link: LINK });
    expect(mockLogEventSafe).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      changes: { before: null, after: expect.objectContaining({ meet_recurring: { weekday: 1, time: '08:30', link: LINK } }) },
    }));
    expect(mockClientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('recurring null → limpa as três colunas', async () => {
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: [null, null, null], recurring: null }), res);
    expect(res.statusCode).toBe(200);
    const [sql, params] = updateCall();
    expect(sql).toContain('meet_recurring_weekday = $8');
    expect(params.slice(7)).toEqual([null, null, null]);
    expect((res.payload as { data: { meet_recurring: unknown } }).data.meet_recurring).toBeNull();
  });

  it('sala inválida → 400 sem tocar no banco', async () => {
    const res = makeRes();
    await controller.updateMeetLinks(req({ meet_links: [null, null, null], recurring: { weekday: 1, time: '08:30', link: 'https://zoom.us/j/1' } }), res);
    expect(res.statusCode).toBe(400);
    expect((res.payload as { error: string }).error).toBe('Invalid recurring meet link format');
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('corpo com chave desconhecida ou recurring malformado → 400', async () => {
    for (const body of [{ meet_links: [null, null, null], foo: 1 }, { meet_links: [null, null, null], recurring: { weekday: 9, time: '08:30', link: LINK } }]) {
      const res = makeRes();
      await controller.updateMeetLinks(req(body), res);
      expect(res.statusCode).toBe(400);
    }
  });
});
