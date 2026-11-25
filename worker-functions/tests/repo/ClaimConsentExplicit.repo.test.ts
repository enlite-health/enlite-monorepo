/**
 * ClaimConsentExplicit.repo.test.ts — Postgres REAL como `enlite_app` (papel de runtime), SEM mock de dado.
 * O OTP do claim prova a posse do telefone, NÃO o aceite da política (spec 077, CT-13): o trio
 * `lgpd_consent_at`/`terms_accepted_at`/`privacy_accepted_at` só é gravado quando o pedido traz o aceite explícito.
 * ConfirmClaimUseCase + ClaimShellAbsorber + WorkerPhoneMergeService + WorkerRepository REAIS; só o Twilio é dublê.
 * MORRE se o claim voltar a presumir aceite (trio preenchido sem `consentAt`) ou deixar de gravar quando há aceite.
 *
 *   DATABASE_URL=postgresql://postgres:<senha>@127.0.0.1:<porta>/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand ClaimConsentExplicit
 */
import { Pool } from 'pg';

const BASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5611/enlite_e2e';
const APP_URL = BASE_URL + (BASE_URL.includes('?') ? '&' : '?') + 'options=' + encodeURIComponent('-c role=enlite_app');
const stamp = String(Date.now());
const uid = (n: string) => `repo-claimconsent-${n}-${stamp}`;
const phone = (n: number) => `549${String(Number(stamp.slice(-7)) * 10 + n).padStart(10, '0').slice(-10)}`;
const AT = new Date('2026-11-24T10:00:00.000Z');

const owner = new Pool({ connectionString: BASE_URL });
let app: Pool;
let useCase: import('../../src/modules/auth/application/ConfirmClaimUseCase').ConfirmClaimUseCase;
let twilioTo = '';
const envAntes: Record<string, string | undefined> = {};

const insert = async (auth: string, n: string, tel: string | null) =>
  (await owner.query(
    `INSERT INTO workers (auth_uid, email, phone, status, country, is_test) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', true) RETURNING id`,
    [auth, `${auth}-${n}@e2e.local`, tel],
  )).rows[0].id as string;
const importada = (n: string, tel: string) => insert(`anacareimport_${uid(n)}`, n, tel);
const propria = (n: string) => insert(uid(n), n, null);
const trio = async (id: string) =>
  (await owner.query(`SELECT lgpd_consent_at a, terms_accepted_at b, privacy_accepted_at c, merged_into_id m, auth_uid u FROM workers WHERE id=$1`, [id])).rows[0];

beforeAll(async () => {
  for (const [k, v] of Object.entries({ USE_MOCK_AUTH: 'true', GCP_PROJECT_ID: 'enlite-e2e', DATABASE_URL: APP_URL })) { envAntes[k] = process.env[k]; process.env[k] = v; }
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  const { ConfirmClaimUseCase } = await import('../../src/modules/auth/application/ConfirmClaimUseCase');
  const { ClaimShellAbsorber } = await import('../../src/modules/auth/application/ClaimShellAbsorber');
  const { TwilioVerifyOtpAdapter } = await import('../../src/modules/auth/infrastructure/TwilioVerifyOtpAdapter');
  const { WorkerRepository } = await import('../../src/modules/worker/infrastructure/WorkerRepository');
  app = DatabaseConnection.getInstance().getPool();
  const twilio = { startVerification: async () => ({ verificationSid: 'VE_STUB' }), checkVerification: async () => ({ valid: true, status: 'approved', to: twilioTo }) };
  useCase = new ConfirmClaimUseCase(new WorkerRepository(), new TwilioVerifyOtpAdapter(twilio as never), new ClaimShellAbsorber(app));
});

afterAll(async () => {
  const ids = (await owner.query('SELECT id FROM workers WHERE auth_uid LIKE $1 OR auth_uid LIKE $2', [`repo-claimconsent-%-${stamp}`, `anacareimport_repo-claimconsent-%-${stamp}`])).rows.map((r) => r.id);
  await owner.query('DELETE FROM worker_merge_audit WHERE survivor_id = ANY($1::uuid[]) OR absorbed_id = ANY($1::uuid[])', [ids]).catch(() => {});
  await owner.query('UPDATE workers SET merged_into_id = NULL WHERE id = ANY($1::uuid[])', [ids]).catch(() => {});
  await owner.query('DELETE FROM workers WHERE id = ANY($1::uuid[])', [ids]).catch(() => {});
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().close();
  await owner.end();
  for (const [k, v] of Object.entries(envAntes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const claim = (n: string, candidate: string, tel: string, consentAt?: Date) => {
  twilioTo = `+${tel}`;
  return useCase.execute({ verificationSid: 'VE_STUB', otp: '123456', authUid: uid(n), email: `${uid(n)}-${n}@e2e.local`, candidateWorkerId: candidate, consentAt });
};

describe('claim por OTP: aceite só se explícito (enlite_app, banco real)', () => {
  it('o pool roda como enlite_app', async () => {
    expect((await app.query('SELECT current_user u')).rows[0].u).toBe('enlite_app');
  });

  it('conta COM ficha (absorção): sem aceite o trio continua NULL e a união fecha', async () => {
    const x = await propria('abs0');
    const imp = await importada('abs0', phone(1));
    const r = await claim('abs0', imp, phone(1));
    expect(r.isSuccess).toBe(true);
    expect(await trio(imp)).toMatchObject({ m: x });
    expect(await trio(x)).toMatchObject({ a: null, b: null, c: null, u: uid('abs0') });
  });

  it('conta COM ficha (absorção): com aceite o trio é gravado com a hora do aceite', async () => {
    const x = await propria('abs1');
    const imp = await importada('abs1', phone(2));
    const r = await claim('abs1', imp, phone(2), AT);
    expect(r.isSuccess).toBe(true);
    expect(await trio(x)).toMatchObject({ a: AT, b: AT, c: AT });
  });

  it('conta SEM ficha (transferência da importada): sem aceite o trio continua NULL', async () => {
    const imp = await importada('upd0', phone(3));
    const r = await claim('upd0', imp, phone(3));
    expect(r.isSuccess).toBe(true);
    expect(await trio(imp)).toMatchObject({ a: null, b: null, c: null, u: uid('upd0') });
  });

  it('conta SEM ficha (transferência da importada): com aceite o trio é gravado', async () => {
    const imp = await importada('upd1', phone(4));
    const r = await claim('upd1', imp, phone(4), AT);
    expect(r.isSuccess).toBe(true);
    expect(await trio(imp)).toMatchObject({ a: AT, b: AT, c: AT, u: uid('upd1') });
  });
});
