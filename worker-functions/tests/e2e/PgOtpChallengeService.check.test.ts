/**
 * T-F3c-110 — PgOtpChallengeService.check contra POSTGRES REAL (como `enlite_app`). O consumo é UM UPDATE condicional:
 * só um banco de verdade prova que duas conferências simultâneas dão 1 ok e que a amarra ao telefone da ficha (DP-21) está no SQL.
 * Sender = dublê (nenhuma chamada Twilio, nenhuma rede). Dados sintéticos; código e telefone não entram em log.
 */
import { Pool } from 'pg';
import { DEFAULT_OTP_SEND_LIMITS, PgOtpChallengeService } from '../../src/modules/auth/infrastructure/PgOtpChallengeService';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
// Estes testes exercitam OUTRA coisa (conferência/porta) e reusam telefone e ficha: o teto de envio (T-F3c-111) tem teste próprio.
const SEM_LIMITE_DE_ENVIO = { ...DEFAULT_OTP_SEND_LIMITS, perPhoneInWindow: 1e6, perWorkerInWindow: 1e6, perPhonePerDay: 1e6, perWorkerPerDay: 1e6 };
const PEPPER = 'p'.repeat(40);
const PHONE_A = '+5491100000001';
const PHONE_B = '+5491100000002';

describe('PgOtpChallengeService.check', () => {
  let pool: Pool;
  const workers: string[] = [];
  let lastCode = '';
  const sender = { send: jest.fn(async ({ code }: { code: string }) => { lastCode = code; return { twilioSid: 'SM_FAKE', suppressed: false }; }) };
  const service = () => new PgOtpChallengeService(pool, sender, () => PEPPER, undefined, SEM_LIMITE_DE_ENVIO);

  async function novaFicha(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid) VALUES ($1) RETURNING id`, [`otp-test-${Date.now()}-${Math.random()}`]);
    workers.push(rows[0].id);
    return rows[0].id;
  }
  async function emitir(workerId: string, phone = PHONE_A) {
    const { challengeId } = await service().start({ workerId, purpose: 'claim', phoneE164: phone, requesterUid: 'uid-teste-1' });
    return { challengeId, code: lastCode };
  }

  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => {
    if (workers.length) await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [workers]);
    await pool.end();
  });

  it('T-F3c-110 o código certo vale 1 vez: duas conferências simultâneas dão 1 ok', async () => {
    const w = await novaFicha();
    const { challengeId, code } = await emitir(w);
    const input = { challengeId, workerId: w, phoneOnRecord: PHONE_A, code };

    const results = await Promise.all([service().check(input), service().check(input)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, code: 'OTP_ALREADY_USED' }]);
  });

  it('T-F3c-110 o segundo uso do mesmo código é OTP_ALREADY_USED', async () => {
    const w = await novaFicha();
    const { challengeId, code } = await emitir(w);
    const input = { challengeId, workerId: w, phoneOnRecord: PHONE_A, code };

    expect(await service().check(input)).toEqual({ ok: true });
    expect(await service().check(input)).toEqual({ ok: false, code: 'OTP_ALREADY_USED' });
  });

  it('T-F3c-110 código vencido é EXPIRED_OTP', async () => {
    const w = await novaFicha();
    const { challengeId, code } = await emitir(w);
    await pool.query(`UPDATE otp_challenges SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [challengeId]);

    expect(await service().check({ challengeId, workerId: w, phoneOnRecord: PHONE_A, code })).toEqual({ ok: false, code: 'EXPIRED_OTP' });
  });

  it('T-F3c-110 código errado é INVALID_OTP e conta a tentativa; o certo ainda vale depois', async () => {
    const w = await novaFicha();
    const { challengeId, code } = await emitir(w);
    const errado = code === '000000' ? '000001' : '000000';

    expect(await service().check({ challengeId, workerId: w, phoneOnRecord: PHONE_A, code: errado })).toEqual({ ok: false, code: 'INVALID_OTP' });
    const { rows } = await pool.query<{ attempts: number }>(`SELECT attempts FROM otp_challenges WHERE id = $1`, [challengeId]);
    expect(rows[0].attempts).toBe(1);
    expect(await service().check({ challengeId, workerId: w, phoneOnRecord: PHONE_A, code })).toEqual({ ok: true });
  });

  it('T-F3c-110 DP-21: o código emitido para o telefone A não vale para a ficha cujo telefone é B', async () => {
    const w = await novaFicha();
    const { challengeId, code } = await emitir(w, PHONE_A);

    expect(await service().check({ challengeId, workerId: w, phoneOnRecord: PHONE_B, code })).toEqual({ ok: false, code: 'INVALID_OTP' });
    const { rows } = await pool.query<{ status: string }>(`SELECT status FROM otp_challenges WHERE id = $1`, [challengeId]);
    expect(rows[0].status).toBe('pending');
  });
});
