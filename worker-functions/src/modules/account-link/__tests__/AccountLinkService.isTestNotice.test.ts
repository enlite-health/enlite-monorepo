jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));
// Dublê do envio real do aviso: o espião que prova 0 chamadas para absorvida de teste.
jest.mock('../accountLinkNotice', () => ({ sendLinkedNoticeEmail: jest.fn().mockResolvedValue(undefined) }));

import type { Pool } from 'pg';
import { AccountLinkService } from '../AccountLinkService';
import { sendLinkedNoticeEmail } from '../accountLinkNotice';
import { TwilioVerifyOtpAdapter } from '../../auth/infrastructure/TwilioVerifyOtpAdapter';
import { IsTestOtpGuardedVerify } from '../../auth/infrastructure/IsTestOtpGuardedVerify';

const LOGGED = 'aaaaaaaa-0000-0000-0000-000000000001';
const OWNER = 'bbbbbbbb-0000-0000-0000-000000000002';

function makeService(absorbedIsTest: boolean) {
  const pool = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('WHERE auth_uid')) return Promise.resolve({ rows: [{ id: LOGGED, email: 'nueva@x.com', auth_uid: 'FirebaseNew', phone: null, updated_at: new Date('2026-08-01'), merged_into_id: null }] });
      if (sql.includes('phone = ANY')) return Promise.resolve({ rows: [{ id: OWNER, email: 'vieja@x.com', auth_uid: 'FirebaseOld', phone: '5491133336012', updated_at: new Date('2026-07-01'), is_test: absorbedIsTest }] });
      if (sql.includes('worker_job_applications')) return Promise.resolve({ rows: [{ high: false }] });
      if (sql.includes('SELECT id, updated_at')) return Promise.resolve({ rows: [] });
      if (sql.includes('rows_reparented')) return Promise.resolve({ rows: [{ rows_reparented: {} }] });
      if (sql.includes('SELECT status FROM workers')) return Promise.resolve({ rows: [{ status: 'REGISTERED' }] });
      if (sql.includes('SELECT is_test FROM workers')) return Promise.resolve({ rows: [{ is_test: absorbedIsTest }] });
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
  const twilio = {
    startVerification: jest.fn(),
    checkVerification: jest.fn().mockResolvedValue({ valid: true, status: 'approved', to: '+5491133336012' }),
  };
  const adminMerge = { execute: jest.fn().mockResolvedValue({ audit_ids: [77], survivor_id: LOGGED, absorbed_ids: [OWNER] }) };
  return new AccountLinkService(pool, { otp: new TwilioVerifyOtpAdapter(new IsTestOtpGuardedVerify(twilio as never)), adminMerge: adminMerge as never, encryption: { decrypt: jest.fn().mockResolvedValue('') } as never });
}

beforeAll(() => { process.env.ACCOUNT_LINK_TOKEN_SECRET = 'unit-test-secret'; });
beforeEach(() => { (sendLinkedNoticeEmail as jest.Mock).mockClear(); });

describe('AccountLinkService — aviso de união e ficha absorvida is_test (FR-95/DP-23)', () => {
  it('T-F3c-24 absorvida is_test: o merge acontece e sendLinkedNoticeEmail NÃO é chamado', async () => {
    const out = await makeService(true).confirm('FirebaseNew', '1133336012', 'VE', '123456');
    expect(out).toMatchObject({ status: 'merged' });
    expect(sendLinkedNoticeEmail).toHaveBeenCalledTimes(0);
  });

  it('T-F3c-24 absorvida real: sendLinkedNoticeEmail chamado 1 vez', async () => {
    const out = await makeService(false).confirm('FirebaseNew', '1133336012', 'VE', '123456');
    expect(out).toMatchObject({ status: 'merged' });
    expect(sendLinkedNoticeEmail).toHaveBeenCalledTimes(1);
  });
});
