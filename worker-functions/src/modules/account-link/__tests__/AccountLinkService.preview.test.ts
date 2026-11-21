/** T-F3c-28 — C-46/DT-50/FR-90: confirm com preview:true devolve linkToken e NÃO faz o merge. Dublês, sem rede. */
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));
jest.mock('../accountLinkNotice', () => ({ sendLinkedNoticeEmail: jest.fn().mockResolvedValue(undefined) }));

import type { Pool } from 'pg';
import { AccountLinkService } from '../AccountLinkService';

const LOGGED = 'aaaaaaaa-0000-0000-0000-000000000001';
const OWNER = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeService() {
  const query = jest.fn().mockImplementation((sql: string) => {
    if (sql.includes('WHERE auth_uid')) return Promise.resolve({ rows: [{ id: LOGGED, email: 'nueva@x.com', auth_uid: 'FirebaseNew', phone: null, updated_at: new Date('2026-08-01'), merged_into_id: null }] });
    if (sql.includes('phone = ANY')) return Promise.resolve({ rows: [{ id: OWNER, email: 'vieja@x.com', auth_uid: 'FirebaseOld', phone: '5491133336012', updated_at: new Date('2026-07-01'), is_test: false }] });
    if (sql.includes('worker_job_applications')) return Promise.resolve({ rows: [{ high: false }] });
    if (sql.includes('SELECT id, updated_at')) return Promise.resolve({ rows: [] });
    if (sql.includes('rows_reparented')) return Promise.resolve({ rows: [{ rows_reparented: {} }] });
    if (sql.includes('SELECT status FROM workers')) return Promise.resolve({ rows: [{ status: 'REGISTERED' }] });
    if (sql.includes('SELECT is_test FROM workers')) return Promise.resolve({ rows: [{ is_test: false }] });
    return Promise.resolve({ rows: [] });
  });
  const twilio = {
    startVerification: jest.fn(),
    checkVerification: jest.fn().mockResolvedValue({ valid: true, status: 'approved', to: '+5491133336012' }),
  };
  const adminMerge = { execute: jest.fn().mockResolvedValue({ audit_ids: [77], survivor_id: LOGGED, absorbed_ids: [OWNER] }) };
  const service = new AccountLinkService({ query } as unknown as Pool, { twilio: twilio as never, adminMerge: adminMerge as never, encryption: { decrypt: jest.fn().mockResolvedValue('') } as never });
  return { service, query, adminMerge };
}

beforeAll(() => { process.env.ACCOUNT_LINK_TOKEN_SECRET = 'unit-test-secret'; });

describe('AccountLinkService.confirm — prévia (preview:true)', () => {
  it('T-F3c-28 preview:true devolve linkToken e não grava nada em worker_merge_audit', async () => {
    const { service, query, adminMerge } = makeService();

    const out = await service.confirm('FirebaseNew', '1133336012', 'VE', '123456', undefined, { preview: true });

    expect(out).toMatchObject({ status: 'preview', accounts: { current: LOGGED, other: OWNER } });
    expect((out as { linkToken: string }).linkToken).toEqual(expect.any(String));
    expect((out as { linkToken: string }).linkToken.length).toBeGreaterThan(10);
    expect(adminMerge.execute).not.toHaveBeenCalled();
    const touchedAudit = query.mock.calls.filter(([sql]) => String(sql).includes('worker_merge_audit'));
    expect(touchedAudit).toHaveLength(0);
  });

  it('T-F3c-28 sem preview: o comportamento de hoje (merge e linha de auditoria)', async () => {
    const { service, query, adminMerge } = makeService();

    const out = await service.confirm('FirebaseNew', '1133336012', 'VE', '123456');

    expect(out).toMatchObject({ status: 'merged' });
    expect(adminMerge.execute).toHaveBeenCalledTimes(1);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('rows_reparented FROM worker_merge_audit'))).toBe(true);
  });
});
