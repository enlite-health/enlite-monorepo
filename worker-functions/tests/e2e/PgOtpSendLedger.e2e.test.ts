/**
 * PgOtpSendLedger contra POSTGRES REAL (tabela da migration 598). Sem API, sem Firebase, sem canal real.
 * `sentToday` é global: o teste mede a DIFERENÇA, não o valor absoluto.
 */
import { Pool } from 'pg';
import { PgOtpSendLedger } from '../../src/modules/auth/infrastructure/PgOtpSendLedger';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = `e2e-ledger-${Date.now()}`;

describe('PgOtpSendLedger — Postgres real', () => {
  let pool: Pool;
  let ledger: PgOtpSendLedger;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); ledger = new PgOtpSendLedger(pool); });
  afterAll(async () => {
    await pool.query(`DELETE FROM otp_send_events WHERE challenge_id LIKE $1`, [`${TAG}%`]);
    await pool.end();
  });

  const evento = (id: string, suppressed: boolean) => ({
    challengeId: `${TAG}-${id}`, adapter: 'own' as const, purpose: 'claim' as const,
    requesterUid: 'uid-teste-e2e', targetWorkerId: null, suppressed,
  });

  it('envio real conta e o suprimido não conta', async () => {
    const antes = await ledger.sentToday();
    await ledger.record(evento('real', false));
    expect(await ledger.sentToday()).toBe(antes + 1);
    await ledger.record(evento('suprimido', true));
    expect(await ledger.sentToday()).toBe(antes + 1);
  });

  it('linha de ontem em Buenos Aires não conta', async () => {
    const antes = await ledger.sentToday();
    await ledger.record(evento('ontem', false));
    await pool.query(
      `UPDATE otp_send_events
          SET created_at = (date_trunc('day', NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')
                            AT TIME ZONE 'America/Argentina/Buenos_Aires') - INTERVAL '1 minute'
        WHERE challenge_id = $1`,
      [`${TAG}-ontem`],
    );
    expect(await ledger.sentToday()).toBe(antes);
  });

  it('o requester_hash gravado é sha256 hex de 64 e não o uid', async () => {
    await ledger.record(evento('hash', false));
    const { rows } = await pool.query<{ requester_hash: string }>(`SELECT requester_hash FROM otp_send_events WHERE challenge_id = $1`, [`${TAG}-hash`]);
    expect(rows[0].requester_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].requester_hash).not.toBe('uid-teste-e2e');
  });
});
