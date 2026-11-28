/** PgPhoneVerificationRepository.markPhoneVerified — tradução do 23505 nos índices de telefone. Pool dublê: nenhum banco. */
import { PgPhoneVerificationRepository } from '../PgPhoneVerificationRepository';

const INPUT = { workerId: 'w1', challengeId: null, method: 'otp_verify_whatsapp' as const };
const pgError = (code: string, constraint?: string) => Object.assign(new Error('detalhe com linha'), { code, constraint });
const repo = () => new PgPhoneVerificationRepository({} as never);

describe('PgPhoneVerificationRepository.markPhoneVerified', () => {
  it('UPDATE de uma linha → ok', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) };
    expect(await repo().markPhoneVerified(db, INPUT)).toBe('ok');
  });

  it.each(['idx_workers_phone_unique', 'uq_workers_phone_verified_now', 'uq_workers_phone_verified_otp_challenge'])(
    '23505 no índice %s → PHONE_IN_USE',
    async (constraint) => {
      const db = { query: jest.fn().mockRejectedValue(pgError('23505', constraint)) };
      expect(await repo().markPhoneVerified(db, INPUT)).toBe('PHONE_IN_USE');
    },
  );

  it('23505 em outro índice sobe', async () => {
    const db = { query: jest.fn().mockRejectedValue(pgError('23505', 'workers_auth_uid_key')) };
    await expect(repo().markPhoneVerified(db, INPUT)).rejects.toThrow('detalhe com linha');
  });

  it('outro erro sobe', async () => {
    const db = { query: jest.fn().mockRejectedValue(pgError('40001')) };
    await expect(repo().markPhoneVerified(db, INPUT)).rejects.toThrow();
  });

  it('nenhuma linha atualizada sobe PHONE_VERIFICATION_NOT_WRITTEN', async () => {
    const db = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    await expect(repo().markPhoneVerified(db, INPUT)).rejects.toThrow('PHONE_VERIFICATION_NOT_WRITTEN');
  });
});
