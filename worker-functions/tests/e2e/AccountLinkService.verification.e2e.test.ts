/**
 * T-F3c-137 — o `finalize` do unir contas grava a verificação na sobrevivente e o merge move as 4 colunas `phone_verified_*` junto
 * com o `phone` e a marca de dispensa (AC-7, AC-21). Postgres real como `enlite_app`; AccountLinkService, PgOtpChallengeService,
 * WorkerPhoneMergeService REAIS; só o ENVIO do código é dublê (nenhum canal real). Fichas de teste (`is_test`): sem e-mail de aviso.
 * Obs.: roda no config e2e (precisa de banco); o config unit não tem Postgres.
 */
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { AccountLinkService } from '../../src/modules/account-link/AccountLinkService';
import { verifyLinkToken } from '../../src/modules/account-link/linkToken';
import { PgOtpChallengeService, DEFAULT_OTP_SEND_LIMITS } from '../../src/modules/auth/infrastructure/PgOtpChallengeService';
import { WorkerPhoneMergeService } from '../../src/infrastructure/services/WorkerPhoneMergeService';
import { novoTelefone, gravarVerificacao } from './helpers/phoneVerificationFixtures';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SEM_LIMITE = { ...DEFAULT_OTP_SEND_LIMITS, perPhoneInWindow: 1e6, perWorkerInWindow: 1e6, perPhonePerDay: 1e6, perWorkerPerDay: 1e6 };

describe('vínculo e merge levam a prova do celular', () => {
  let pool: Pool;
  let lastCode = '';
  const digits = (p: string) => p.replace(/\D/g, '');
  const sender = { send: async ({ code }: { code: string }) => { lastCode = code; return { twilioSid: 'SM_FAKE', suppressed: false }; } };

  const secretAntes = process.env.ACCOUNT_LINK_TOKEN_SECRET;
  beforeAll(() => {
    process.env.ACCOUNT_LINK_TOKEN_SECRET = 'e2e-link-secret-'.padEnd(40, 'x');
    pool = new Pool({ connectionString: DATABASE_URL });
    (DatabaseConnection.getInstance() as unknown as { pool: Pool }).pool = pool;
  });
  afterAll(async () => {
    if (secretAntes === undefined) delete process.env.ACCOUNT_LINK_TOKEN_SECRET; else process.env.ACCOUNT_LINK_TOKEN_SECRET = secretAntes;
    await pool.end();
  });

  const ficha = async (phone: string | null) =>
    (await pool.query<{ id: string; auth_uid: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone, is_test)
       VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires', true) RETURNING id, auth_uid`,
      [`uid-al-${randomUUID()}`, `al-${randomUUID()}@al.test`, phone],
    )).rows[0];
  const view = async (id: string) =>
    (await pool.query(
      `SELECT phone, merged_into_id, phone_verified_normalized AS vn, phone_verified_method AS vm, phone_verified_otp_challenge_id AS vch,
              phone_verification_waived_at AS waived, fn_worker_phone_verification_state(id) AS state FROM workers WHERE id = $1`, [id])).rows[0];
  const mergeAdmin = (survivorId: string, absorbedId: string, phone: string) =>
    new WorkerPhoneMergeService().executeSingleMerge({
      survivorId, absorbedId, phoneNormalized: digits(phone), category: 'ghost', legalFieldExceptions: [], flow: 'TEST_FIXTURE',
      audit: { source: 'claim_shell', executedBy: 'e2e', confirmedSamePerson: true },
    });
  const marcarDispensa = async (id: string) => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('enlite.merge_in_progress', 'on', true)`);
      await c.query(`UPDATE workers SET phone_verification_waived_at = now() WHERE id = $1`, [id]);
      await c.query('COMMIT');
    } finally { c.release(); }
  };

  it('T-F3c-137 depois do finalize a sobrevivente fica verified (número da conta antiga, desafio link consumido)', async () => {
    const P = novoTelefone();
    const me = await ficha(null);
    const old = await ficha(P);
    const service = new AccountLinkService(pool, { otp: new PgOtpChallengeService(pool, sender, () => 'p'.repeat(40), undefined, SEM_LIMITE) });
    const { verificationSid } = await service.start(me.auth_uid, P, 'x@enlite.test');
    const out = await service.confirm(me.auth_uid, P, verificationSid, lastCode, 'x@enlite.test', { preview: true });
    if (out.status !== 'preview') throw new Error(`esperava preview, veio ${out.status}`);
    const payload = verifyLinkToken(out.linkToken, 'finalize');
    expect(payload).not.toBeNull();
    expect((await view(me.id)).state).toBe('no_phone'); // antes do finalize, nada

    const done = await service.finalize(me.auth_uid, payload!, undefined);
    expect(done.status).toBe('merged');
    const after = await view(me.id);
    expect(after).toMatchObject({ state: 'verified', vn: digits(P), vm: 'otp_whatsapp_template', vch: verificationSid });
    expect((await view(old.id)).merged_into_id).toBe(me.id);
  });

  it('T-F3c-137 num merge admin as 4 colunas vão junto com o phone (a absorvida fica sem elas)', async () => {
    const P = novoTelefone();
    const survivor = await ficha(null);
    const absorbed = await ficha(P);
    await gravarVerificacao(pool, absorbed.id);
    await mergeAdmin(survivor.id, absorbed.id, P);
    expect(await view(survivor.id)).toMatchObject({ state: 'verified', vn: digits(P), vm: 'otp_whatsapp_template' });
    expect(digits((await view(survivor.id)).phone)).toBe(digits(P));
    expect(await view(absorbed.id)).toMatchObject({ vn: null, vm: null, phone: null });
  });

  it('T-F3c-137 absorvida com marca de dispensa em sobrevivente sem marca: a sobrevivente fica com a marca', async () => {
    const survivor = await ficha(null);
    const P = novoTelefone();
    const absorbed = await ficha(P);
    await marcarDispensa(absorbed.id);
    expect((await view(survivor.id)).waived).toBeNull();
    await mergeAdmin(survivor.id, absorbed.id, P);
    expect((await view(survivor.id)).waived).not.toBeNull();
  });

  it('T-F3c-137 absorvida SEM as colunas deixa a sobrevivente unverified (nunca verificada por engano)', async () => {
    const P = novoTelefone();
    const survivor = await ficha(null);
    const absorbed = await ficha(P);
    await mergeAdmin(survivor.id, absorbed.id, P);
    const after = await view(survivor.id);
    expect(digits(after.phone)).toBe(digits(P)); // o phone veio
    expect(after).toMatchObject({ state: 'unverified', vn: null });
  });
});
