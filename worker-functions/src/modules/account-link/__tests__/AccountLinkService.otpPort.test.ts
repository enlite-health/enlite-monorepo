/**
 * AccountLinkService pelo OtpChallengePort (D758): `start` envia com finalidade `link` para o telefone GRAVADO na conta antiga
 * (E.164) e devolve o id do desafio; o limite do port vira `RATE_LIMITED`; `confirm` confere contra o telefone gravado (nunca o digitado)
 * e mapeia as falhas do port. Port = dublê; nenhum canal real.
 */
jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn(), getStore: jest.fn().mockReturnValue(undefined) },
}));

import type { Pool } from 'pg';
import { AccountLinkService } from '../AccountLinkService';
import { AccountLinkError } from '../AccountLinkTypes';
import { OTP_RATE_LIMITED } from '../../auth/ports/OtpChallengePort';

const LOGGED = 'aaaaaaaa-0000-0000-0000-000000000001';
const OWNER = 'bbbbbbbb-0000-0000-0000-000000000002';

function build(otp: { start: jest.Mock; check: jest.Mock }) {
  const pool = {
    query: jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('WHERE auth_uid')) return Promise.resolve({ rows: [{ id: LOGGED, email: 'nueva@x.com', auth_uid: 'FirebaseNew', phone: null, updated_at: new Date('2026-08-01'), merged_into_id: null }] });
      if (sql.includes('phone = ANY')) return Promise.resolve({ rows: [{ id: OWNER, email: 'vieja@x.com', auth_uid: 'FirebaseOld', phone: '5491133336012', updated_at: new Date('2026-07-01'), is_test: false }] });
      if (sql.includes('worker_job_applications')) return Promise.resolve({ rows: [{ high: true }] }); // alto valor: o confirm para antes do merge
      return Promise.resolve({ rows: [] });
    }),
  } as unknown as Pool;
  return new AccountLinkService(pool, { otp: { ...otp, cancel: jest.fn() } as never, adminMerge: { execute: jest.fn() } as never, encryption: { decrypt: jest.fn() } as never });
}

beforeAll(() => { process.env.ACCOUNT_LINK_TOKEN_SECRET = 'unit-test-secret'; });

describe('AccountLinkService sobre o port', () => {
  it('start: finalidade link, telefone da conta ANTIGA em E.164, id do desafio vira o verificationSid', async () => {
    const otp = { start: jest.fn().mockResolvedValue({ challengeId: 'ch-9' }), check: jest.fn() };
    const out = await build(otp).start('FirebaseNew', '1133336012', 'x@enlite.test');
    expect(out.verificationSid).toBe('ch-9');
    expect(otp.start).toHaveBeenCalledWith(expect.objectContaining({ workerId: OWNER, purpose: 'link', phoneE164: '+5491133336012' }));
  });

  it('start: o RATE_LIMITED do port sai como AccountLinkError RATE_LIMITED (nunca 500 genérico)', async () => {
    const otp = { start: jest.fn().mockRejectedValue(new Error(OTP_RATE_LIMITED)), check: jest.fn() };
    await expect(build(otp).start('FirebaseNew', '1133336012')).rejects.toMatchObject({ name: 'AccountLinkError', code: 'RATE_LIMITED' });
  });

  it('start: outro erro do port NÃO é mascarado como RATE_LIMITED', async () => {
    const otp = { start: jest.fn().mockRejectedValue(new Error('OTP_CHANNEL_UNAVAILABLE')), check: jest.fn() };
    const err = await build(otp).start('FirebaseNew', '1133336012').catch((e) => e);
    expect(err).not.toBeInstanceOf(AccountLinkError);
    expect((err as Error).message).toBe('OTP_CHANNEL_UNAVAILABLE');
  });

  it('confirm: confere contra o telefone GRAVADO da antiga (E.164), com o id do desafio e o código', async () => {
    const otp = { start: jest.fn(), check: jest.fn().mockResolvedValue({ ok: true }) };
    const out = await build(otp).confirm('FirebaseNew', '(11) 3333-6012', 'ch-9', '123456', 'x@enlite.test');
    expect(out).toMatchObject({ status: 'REQUIRES_REVIEW' }); // passou do OTP (alto valor para antes do merge)
    expect(otp.check).toHaveBeenCalledWith(expect.objectContaining({ challengeId: 'ch-9', workerId: OWNER, phoneOnRecord: '+5491133336012', code: '123456' }));
  });

  it.each([
    ['EXPIRED_OTP', 'EXPIRED_OTP'],
    ['INVALID_OTP', 'INVALID_OTP'],
    ['OTP_ALREADY_USED', 'INVALID_OTP'],
  ])('confirm: a falha %s do port vira AccountLinkError %s', async (portCode, linkCode) => {
    const otp = { start: jest.fn(), check: jest.fn().mockResolvedValue({ ok: false, code: portCode }) };
    await expect(build(otp).confirm('FirebaseNew', '1133336012', 'ch-9', '000000')).rejects.toMatchObject({ code: linkCode });
  });
});
