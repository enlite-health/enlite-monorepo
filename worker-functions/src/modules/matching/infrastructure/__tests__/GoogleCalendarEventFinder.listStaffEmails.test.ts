/**
 * listStaffEmails — staff é `account_type = 'staff'` (D294), e a falha da consulta
 * é REPORTADA, não engolida (gate de 07/09: "0 staff" por erro não pode parecer
 * "0 staff" de verdade).
 */
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import type { Pool } from 'pg';
import { listStaffEmails } from '../GoogleCalendarEventFinder';

function poolWith(rows: { email: string }[]): { pool: Pool; query: jest.Mock } {
  const query = jest.fn().mockResolvedValue({ rows });
  return { pool: { query } as unknown as Pool, query };
}

describe('listStaffEmails', () => {
  beforeEach(() => {
    mockReportError.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('filtra por domínio do e-mail impersonado E por account_type = staff (não por papel)', async () => {
    const { pool, query } = poolWith([{ email: 'a@enlite.health' }, { email: 'b@enlite.health' }]);
    const emails = await listStaffEmails(pool, 'admissao@enlite.health');
    expect(emails).toEqual(['a@enlite.health', 'b@enlite.health']);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/account_type = 'staff'/);
    expect(sql).not.toMatch(/role/);
    expect(params).toEqual(['%@enlite.health']);
  });

  it('e-mail impersonado sem domínio → [] sem consultar', async () => {
    const { pool, query } = poolWith([]);
    expect(await listStaffEmails(pool, 'sem-arroba')).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('falha da consulta (ex.: coluna ausente) → [] E reportError com a origem — nunca silêncio', async () => {
    const query = jest.fn().mockRejectedValue(new Error('column "account_type" does not exist'));
    const emails = await listStaffEmails({ query } as unknown as Pool, 'x@enlite.health');
    expect(emails).toEqual([]);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    expect((mockReportError.mock.calls[0][0] as Error).message).toContain('account_type');
    expect(mockReportError.mock.calls[0][1]).toEqual({ source: 'GoogleCalendarEventFinder:listStaffEmails' });
  });

  it('erro que não é Error é normalizado antes de reportar', async () => {
    const query = jest.fn().mockRejectedValue('string crua');
    await listStaffEmails({ query } as unknown as Pool, 'x@enlite.health');
    expect(mockReportError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
