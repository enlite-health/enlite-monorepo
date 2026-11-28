/**
 * PgOtpChallengeService.start — falha fechada do pepper e erro ao registrar o sid DEPOIS de enviar. Pool e sender são dublês:
 * nenhuma rede, nenhum banco.
 */
import { PgOtpChallengeService } from '../PgOtpChallengeService';

const START = { workerId: 'w1', purpose: 'claim' as const, phoneE164: '+5491100000009', requesterUid: 'uid-teste-1' };

function fakes() {
  const clientQuery = jest.fn().mockResolvedValue({ rowCount: 1, rows: [] });
  const pool = {
    connect: jest.fn().mockResolvedValue({ query: clientQuery, release: jest.fn() }),
    query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [] }),
  };
  const send = jest.fn().mockResolvedValue({ twilioSid: 'SM_FAKE', suppressed: false });
  return { pool, clientQuery, send };
}

describe('PgOtpChallengeService — falha fechada e registro do envio', () => {
  it.each([[undefined], [''], ['p'.repeat(31)]])('pepper ausente ou curto (%p): start falha ANTES de qualquer INSERT e nada é enviado', async (pepper) => {
    const { pool, clientQuery, send } = fakes();
    const svc = new PgOtpChallengeService(pool as never, { send }, () => pepper as string | undefined);

    await expect(svc.start(START)).rejects.toThrow('OTP_HMAC_PEPPER not configured');

    expect(pool.connect).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('pepper ausente: check também falha fechada, sem tocar o banco', async () => {
    const { pool, send } = fakes();
    const svc = new PgOtpChallengeService(pool as never, { send }, () => undefined);

    await expect(svc.check({ challengeId: 'c1', workerId: 'w1', purpose: 'claim', phoneOnRecord: START.phoneE164, code: '123456' })).rejects.toThrow('OTP_HMAC_PEPPER not configured');

    expect(pool.query).not.toHaveBeenCalled();
  });

  it('envio deu certo e só o UPDATE do twilio_sid falhou: NÃO cancela, devolve o challengeId', async () => {
    const { pool, send } = fakes();
    pool.query.mockRejectedValueOnce(new Error('db down'));
    const svc = new PgOtpChallengeService(pool as never, { send }, () => 'p'.repeat(40));

    const out = await svc.start(START);

    expect(out.challengeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(send).toHaveBeenCalledTimes(1);
    const sqls = pool.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((q) => q.includes("status = 'canceled'"))).toBe(false);
  });

  it('B11 a validade do código no INSERT é de 10 minutos (6º parâmetro): trocar exige trocar o Verify e o handshake do app', async () => {
    const { pool, clientQuery, send } = fakes();
    const svc = new PgOtpChallengeService(pool as never, { send }, () => 'p'.repeat(40));

    await svc.start(START);

    const insert = clientQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO otp_challenges'));
    expect(insert).toBeDefined();
    expect((insert as unknown[][])[1][5]).toBe(10);
  });

  it('o envio falhou: o desafio é cancelado e o erro sobe', async () => {
    const { pool } = fakes();
    const send = jest.fn().mockRejectedValue(new Error('OTP_CHANNEL_UNAVAILABLE'));
    const svc = new PgOtpChallengeService(pool as never, { send }, () => 'p'.repeat(40));

    await expect(svc.start(START)).rejects.toThrow('OTP_CHANNEL_UNAVAILABLE');

    expect(pool.query.mock.calls.some((c) => String(c[0]).includes("status = 'canceled'"))).toBe(true);
  });
});
