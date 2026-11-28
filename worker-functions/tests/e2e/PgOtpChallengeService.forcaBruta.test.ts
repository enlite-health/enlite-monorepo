/**
 * Força bruta por concorrência e código fora do banco — PgOtpChallengeService contra POSTGRES REAL (como `enlite_app`).
 * Sender = dublê; dados sintéticos; código e telefone não entram em log.
 */
import { Pool } from 'pg';
import { DEFAULT_OTP_SEND_LIMITS, PgOtpChallengeService } from '../../src/modules/auth/infrastructure/PgOtpChallengeService';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
// Estes testes exercitam OUTRA coisa (conferência/porta) e reusam telefone e ficha: o teto de envio (T-F3c-111) tem teste próprio.
const SEM_LIMITE_DE_ENVIO = { ...DEFAULT_OTP_SEND_LIMITS, perPhoneInWindow: 1e6, perWorkerInWindow: 1e6, perPhonePerDay: 1e6, perWorkerPerDay: 1e6 };
const PEPPER = 'p'.repeat(40);
const PHONE = '+5491100000003';

describe('PgOtpChallengeService — força bruta e código fora do banco', () => {
  let pool: Pool;
  const workers: string[] = [];
  let lastCode = '';
  const sender = { send: jest.fn(async ({ code }: { code: string }) => { lastCode = code; return { twilioSid: 'SM_FAKE', suppressed: false }; }) };
  const service = () => new PgOtpChallengeService(pool, sender, () => PEPPER, undefined, SEM_LIMITE_DE_ENVIO);

  async function novoDesafio() {
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid) VALUES ($1) RETURNING id`, [`otp-bf-${Date.now()}-${Math.random()}`]);
    workers.push(rows[0].id);
    const { challengeId } = await service().start({ workerId: rows[0].id, purpose: 'claim', phoneE164: PHONE, requesterUid: 'uid-teste-1' });
    return { workerId: rows[0].id, challengeId, code: lastCode };
  }

  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL, max: 12 }); });
  afterAll(async () => {
    if (workers.length) await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [workers]);
    await pool.end();
  });

  it('forca-bruta: 10 conferências erradas em paralelo contam no máximo 5; a certa depois também é recusada', async () => {
    const { workerId, challengeId, code } = await novoDesafio();
    const errado = code === '000000' ? '000001' : '000000';

    const results = await Promise.all(
      Array.from({ length: 10 }, () => service().check({ challengeId, workerId, phoneOnRecord: PHONE, code: errado })),
    );

    expect(results.filter((r) => !r.ok && r.code === 'INVALID_OTP')).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.code === 'EXPIRED_OTP')).toHaveLength(5);
    const { rows } = await pool.query<{ attempts: number; status: string }>(`SELECT attempts, status FROM otp_challenges WHERE id = $1`, [challengeId]);
    expect(rows[0].attempts).toBe(5);
    expect(rows[0].status).toBe('canceled');

    expect(await service().check({ challengeId, workerId, phoneOnRecord: PHONE, code })).toEqual({ ok: false, code: 'EXPIRED_OTP' });
  });

  it('forca-bruta: a certa no meio de 10 em paralelo vale no máximo 1 vez', async () => {
    const { workerId, challengeId, code } = await novoDesafio();
    const errado = code === '000000' ? '000001' : '000000';
    const codes = [errado, errado, code, code, errado, errado, errado, code, errado, errado];

    const results = await Promise.all(codes.map((c) => service().check({ challengeId, workerId, phoneOnRecord: PHONE, code: c })));

    expect(results.filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    const { rows } = await pool.query<{ attempts: number }>(`SELECT attempts FROM otp_challenges WHERE id = $1`, [challengeId]);
    expect(rows[0].attempts).toBeLessThanOrEqual(5);
  });

  it('claro: o banco não guarda o código em claro (só o HMAC)', async () => {
    const { challengeId, code } = await novoDesafio();
    // Sem id, worker_id e timestamps: são hex/datas e só podem casar 6 dígitos por acaso.
    const { rows } = await pool.query<{ r: Record<string, unknown> }>(
      `SELECT to_jsonb(o) - 'id' - 'worker_id' - 'created_at' - 'expires_at' AS r FROM otp_challenges o WHERE id = $1`,
      [challengeId],
    );
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(rows[0].r)).not.toContain(code);
    expect(rows[0].r.code_hmac).toMatch(/^[0-9a-f]{64}$/);
  });
});
