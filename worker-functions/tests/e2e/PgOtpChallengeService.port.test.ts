/**
 * T-F3c-108 — PgOtpChallengeService (start/check/cancel do OtpChallengePort) contra POSTGRES REAL, como `enlite_app`.
 * A independência entre finalidades (um start de `link`/`phone_verify` não cancela o `claim`) é semântica de SQL: só um
 * banco de verdade a prova. Sender = dublê (nenhuma chamada Twilio, nenhuma rede). Dados sintéticos; sem log de código/telefone.
 */
import { Pool } from 'pg';
import { DEFAULT_OTP_SEND_LIMITS, PgOtpChallengeService } from '../../src/modules/auth/infrastructure/PgOtpChallengeService';
import type { OtpPurpose } from '../../src/modules/auth/ports/OtpChallengePort';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
// Estes testes exercitam OUTRA coisa (conferência/porta) e reusam telefone e ficha: o teto de envio (T-F3c-111) tem teste próprio.
const SEM_LIMITE_DE_ENVIO = { ...DEFAULT_OTP_SEND_LIMITS, perPhoneInWindow: 1e6, perWorkerInWindow: 1e6, perPhonePerDay: 1e6, perWorkerPerDay: 1e6 };
const PEPPER = 'p'.repeat(40);
const PHONE = '+5491100000011';

describe('PgOtpChallengeService — port (start/check/cancel)', () => {
  let pool: Pool;
  const workers: string[] = [];
  let lastCode = '';
  const sender = { send: jest.fn(async ({ code }: { code: string }) => { lastCode = code; return { twilioSid: 'SM_FAKE', suppressed: false }; }) };
  const service = () => new PgOtpChallengeService(pool, sender, () => PEPPER, undefined, SEM_LIMITE_DE_ENVIO);

  async function novaFicha(): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid) VALUES ($1) RETURNING id`, [`otp-port-${Date.now()}-${Math.random()}`]);
    workers.push(rows[0].id);
    return rows[0].id;
  }
  const statusOf = async (id: string) => (await pool.query<{ status: string }>(`SELECT status FROM otp_challenges WHERE id = $1`, [id])).rows[0].status;

  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => {
    if (workers.length) await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [workers]);
    await pool.end();
  });

  it('T-F3c-108 start grava só o HMAC: o código nunca aparece em claro em nenhuma coluna', async () => {
    const w = await novaFicha();
    const { challengeId } = await service().start({ workerId: w, purpose: 'claim', phoneE164: PHONE });
    const { rows } = await pool.query<Record<string, unknown>>(`SELECT * FROM otp_challenges WHERE id = $1`, [challengeId]);

    expect(lastCode).toMatch(/^\d{6}$/);
    expect(rows[0].code_hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(rows[0]).map(String)).not.toContain(lastCode);
    expect(rows[0]).toMatchObject({ purpose: 'claim', status: 'pending', attempts: 0, send_status: 'sent', twilio_sid: 'SM_FAKE' });
  });

  it('T-F3c-108 check com o código certo devolve ok', async () => {
    const w = await novaFicha();
    const { challengeId } = await service().start({ workerId: w, purpose: 'claim', phoneE164: PHONE });

    expect(await service().check({ challengeId, workerId: w, phoneOnRecord: PHONE, code: lastCode })).toEqual({ ok: true });
    expect(await statusOf(challengeId)).toBe('consumed');
  });

  it('T-F3c-108 cancel marca canceled e o código deixa de valer', async () => {
    const w = await novaFicha();
    const { challengeId } = await service().start({ workerId: w, purpose: 'claim', phoneE164: PHONE });
    const code = lastCode;

    await service().cancel({ workerId: w, purpose: 'claim' });

    expect(await statusOf(challengeId)).toBe('canceled');
    expect(await service().check({ challengeId, workerId: w, phoneOnRecord: PHONE, code })).toEqual({ ok: false, code: 'EXPIRED_OTP' });
  });

  it('T-F3c-108 start de outra finalidade (link, phone_verify) não cancela o claim; o reenvio da MESMA finalidade cancela só o anterior', async () => {
    const w = await novaFicha();
    const claim = await service().start({ workerId: w, purpose: 'claim', phoneE164: PHONE });
    const outras: OtpPurpose[] = ['link', 'phone_verify'];
    const ids: string[] = [];
    for (const purpose of outras) ids.push((await service().start({ workerId: w, purpose, phoneE164: PHONE })).challengeId);

    expect(await statusOf(claim.challengeId)).toBe('pending');
    expect(await Promise.all(ids.map(statusOf))).toEqual(['pending', 'pending']);

    const reenvio = await service().start({ workerId: w, purpose: 'claim', phoneE164: PHONE });
    expect(await statusOf(claim.challengeId)).toBe('canceled');
    expect(await statusOf(reenvio.challengeId)).toBe('pending');
    expect(await Promise.all(ids.map(statusOf))).toEqual(['pending', 'pending']);
  });
});
