/** PgOtpChallengeService.check — id malformado não chega ao Postgres. Pool dublê: nenhuma rede, nenhum banco. */
import { PgOtpChallengeService } from '../PgOtpChallengeService';

const PHONE = '+5491100000000';

function svcWith() {
  const pool = { query: jest.fn().mockResolvedValue({ rowCount: 0, rows: [] }), connect: jest.fn() };
  const svc = new PgOtpChallengeService(pool as never, { send: jest.fn() }, () => 'p'.repeat(32));
  return { pool, svc };
}

describe('PgOtpChallengeService.check — id de desafio malformado (B7)', () => {
  it.each([['VEabc'], ['1; drop'], ['']])('challengeId %p → INVALID_OTP e pool.query NÃO é chamado', async (challengeId) => {
    const { pool, svc } = svcWith();

    const out = await svc.check({ challengeId, workerId: 'w1', phoneOnRecord: PHONE, code: '123456' });

    expect(out).toEqual({ ok: false, code: 'INVALID_OTP' });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('UUID válido segue para o banco', async () => {
    const { pool, svc } = svcWith();

    await svc.check({ challengeId: '123e4567-e89b-12d3-a456-426614174000', workerId: 'w1', phoneOnRecord: PHONE, code: '123456' });

    expect(pool.query).toHaveBeenCalled();
  });
});
