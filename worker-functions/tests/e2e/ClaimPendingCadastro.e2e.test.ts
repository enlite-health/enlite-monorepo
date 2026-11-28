/**
 * D797 (spec 077, caso T-13 no cadastro): o app só conhece o celular MASCARADO.
 *  (a) `POST /api/workers/init` de e-mail NÃO verificado de ficha importada com telefone → 200 `code: CLAIM_PENDING`, `challengeId`
 *      (o id do desafio) e `phoneMasked`; o telefone inteiro nunca sai.
 *  (b) `phone/confirm` sem `phone` quando o desafio é de claim: o servidor lê o número do desafio (`otp_challenges.phone_e164`) ou,
 *      no plano B (sem linha), o telefone gravado na ficha. DP-21 segue valendo; `phone_verify` continua exigindo o número.
 * Postgres real como `enlite_app`, controllers e use cases REAIS; o único dublê é o ENVIO do código (nenhum canal real).
 */
import express from 'express';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { novaFicha, novoTelefone } from './helpers/phoneVerificationFixtures';
import { startPhoneVerificationHarness, PhoneVerificationHarness } from './helpers/phoneVerificationHarness';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const mockSent: Array<{ toE164: string; code: string }> = [];

// O init monta o port de OTP por env (Twilio real): aqui entra o adapter próprio com o envio em memória.
jest.mock('../../src/bootstrap/createOtpChallengePort', () => ({
  createOtpChallengePort: () => {
    const { PgOtpChallengeService, DEFAULT_OTP_SEND_LIMITS } = require('../../src/modules/auth/infrastructure/PgOtpChallengeService');
    const { DatabaseConnection } = require('@shared/database/DatabaseConnection');
    const sender = { send: async ({ toE164, code }: { toE164: string; code: string }) => { mockSent.push({ toE164, code }); return { twilioSid: 'SM_FAKE', suppressed: false }; } };
    const semLimite = { ...DEFAULT_OTP_SEND_LIMITS, perPhoneInWindow: 1e6, perWorkerInWindow: 1e6, perPhonePerDay: 1e6, perWorkerPerDay: 1e6 };
    return new PgOtpChallengeService(DatabaseConnection.getInstance().getPool(), sender, () => 'p'.repeat(40), undefined, semLimite);
  },
}));

const digits = (p: string) => p.replace(/\D/g, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('D797: CLAIM_PENDING no init e phone/confirm sem phone', () => {
  let h: PhoneVerificationHarness;
  let pool: Pool;
  let server: Server;
  let url = '';
  const envAntes: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string) => { if (!(k in envAntes)) envAntes[k] = process.env[k]; process.env[k] = v; };

  const importada = async (phone: string, email = `d797-${randomUUID()}@anacareimport.invalid`) =>
    (await h.pool.query<{ id: string; email: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id, email`,
      [`anacareimport_d797-${randomUUID()}`, email, phone],
    )).rows[0];
  const proof = async (id: string) =>
    (await h.pool.query(
      `SELECT phone, merged_into_id, phone_verified_normalized AS vn, phone_verified_method AS vm, phone_verified_otp_challenge_id AS vch,
              fn_worker_phone_verification_state(id) AS state FROM workers WHERE id = $1`, [id])).rows[0];
  const bearer = (uid: string, email: string) => 'Bearer mock_' + Buffer.from(JSON.stringify({ uid, email, email_verified: false })).toString('base64');

  beforeAll(async () => {
    setEnv('TWILIO_WHATSAPP_NUMBER', '+5491100009999');
    h = await startPhoneVerificationHarness();
    pool = h.pool;
    setEnv('USE_MOCK_AUTH', 'true');
    const { WorkerControllerV2 } = await import('../../src/modules/worker/interfaces/controllers/WorkerControllerV2');
    const controller = new WorkerControllerV2();
    const app = express();
    app.use(express.json());
    app.post('/api/workers/init', (req: any, res: any) => {
      const m = /^Bearer mock_(.+)$/.exec(req.headers.authorization ?? '');
      req.user = JSON.parse(Buffer.from(m![1], 'base64').toString());
      req.user.emailVerified = req.user.email_verified === true;
      return controller.initWorker(req, res);
    });
    server = app.listen(0);
    await new Promise<void>((r) => server.once('listening', () => r()));
    url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of Object.entries(envAntes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await h.close();
  });

  it('(a) init de e-mail não verificado de ficha importada com telefone → CLAIM_PENDING + challengeId (uuid do desafio) + phoneMasked, sem o telefone inteiro', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const res = await fetch(url + '/api/workers/init', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: bearer(`uid-d797-${randomUUID()}`, imp.email) }, body: '{}',
    });
    const text = await res.text();
    const body = JSON.parse(text);
    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ status: 'claim_pending', code: 'CLAIM_PENDING' });
    expect(body.data).not.toHaveProperty('candidateWorkerId'); // B4: o id interno da ficha não sai
    expect(body.data.challengeId).toMatch(UUID);
    expect(typeof body.data.phoneMasked).toBe('string');
    expect(text).not.toContain(digits(P));
    expect(text).not.toContain(P);
    const row = (await pool.query(`SELECT worker_id, purpose, phone_e164 FROM otp_challenges WHERE id = $1`, [body.data.challengeId])).rows[0];
    expect(row).toMatchObject({ worker_id: imp.id, purpose: 'claim' });
    expect(digits(row.phone_e164)).toBe(digits(P));
    expect(mockSent.some((s) => digits(s.toE164) === digits(P))).toBe(true);
  });

  it('(b) phone/confirm SEM phone, desafio de claim: usa o telefone do desafio, une e grava a prova; resposta sem telefone inteiro', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const own = await novaFicha(pool, { phone: null });
    const { challengeId, code } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    const r = await h.as(own.id).confirm({ challengeId, code });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'VERIFIED' });
    expect(JSON.stringify(r.json)).not.toContain(digits(P));
    expect(await proof(imp.id)).toMatchObject({ merged_into_id: own.id });
    expect(await proof(own.id)).toMatchObject({ state: 'verified', vn: digits(P), vm: 'otp_whatsapp_template', vch: challengeId });
  });

  it('(b) DP-21 sem phone: telefone da ficha mudou depois do desafio → o código não vale e nada é gravado', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const own = await novaFicha(pool, { phone: null });
    const { challengeId, code } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    await pool.query(`UPDATE workers SET phone = $2 WHERE id = $1`, [imp.id, novoTelefone()]);
    const r = await h.as(own.id).confirm({ challengeId, code });
    expect(r.status).toBe(400);
    expect(await proof(own.id)).toMatchObject({ state: 'no_phone', vn: null });
    expect(await proof(imp.id)).toMatchObject({ merged_into_id: null });
  });

  it('(b) phone_verify SEM phone continua recusado (INVALID_PHONE) e o desafio não é consumido', async () => {
    const own = await novaFicha(pool, { phone: null });
    const Q = novoTelefone();
    const { challengeId, code } = await h.openChallenge(own.id, 'phone_verify', `+${digits(Q)}`);
    const r = await h.as(own.id).confirm({ challengeId, code });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('INVALID_PHONE');
    expect((await pool.query(`SELECT status FROM otp_challenges WHERE id = $1`, [challengeId])).rows[0].status).toBe('pending');
    expect(await proof(own.id)).toMatchObject({ state: 'no_phone' });
  });

  it('(b) phone_verify COM phone segue verificando (regressão)', async () => {
    const own = await novaFicha(pool, { phone: null });
    const Q = novoTelefone();
    const { challengeId, code } = await h.openChallenge(own.id, 'phone_verify', `+${digits(Q)}`);
    const r = await h.as(own.id).confirm({ phone: Q, challengeId, code });
    expect(r.status).toBe(200);
    expect(await proof(own.id)).toMatchObject({ state: 'verified', vn: digits(Q) });
  });

  it('(b) sem challengeId ou sem code → 400 de campo faltando', async () => {
    const own = await novaFicha(pool, { phone: null });
    expect((await h.as(own.id).confirm({ code: '123456' })).status).toBe(400);
    expect((await h.as(own.id).confirm({ challengeId: randomUUID() })).status).toBe(400);
  });

  it('(b) plano B (id sem linha em otp_challenges), sem phone: o port recebe o telefone GRAVADO na ficha do e-mail do token', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const own = await novaFicha(pool, { phone: null });
    const seen: Array<{ phoneOnRecord: string; workerId: string }> = [];
    const otp = { check: async (i: { phoneOnRecord: string; workerId: string }) => { seen.push(i); return { ok: true as const }; } };
    const { WorkerRepository } = await import('../../src/modules/worker/infrastructure/WorkerRepository');
    const { PgPhoneVerificationRepository } = await import('../../src/modules/worker/infrastructure/PgPhoneVerificationRepository');
    const { ConfirmClaimUseCase } = await import('../../src/modules/auth/application/ConfirmClaimUseCase');
    const { ClaimShellAbsorber } = await import('../../src/modules/auth/application/ClaimShellAbsorber');
    const { ConfirmPhoneVerificationUseCase } = await import('../../src/modules/auth/application/ConfirmPhoneVerificationUseCase');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const appPool = DatabaseConnection.getInstance().getPool();
    const workers = new WorkerRepository();
    const uc = new ConfirmPhoneVerificationUseCase(
      workers, new PgPhoneVerificationRepository(appPool), otp as never, new ConfirmClaimUseCase(workers, otp as never, new ClaimShellAbsorber(appPool)), appPool,
    );
    const ownRow = (await pool.query(`SELECT auth_uid FROM workers WHERE id = $1`, [own.id])).rows[0];
    const out = await uc.execute({ authUid: ownRow.auth_uid, email: imp.email, challengeId: 'VE' + randomUUID().replace(/-/g, ''), code: '123456' });
    expect(out.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(digits(seen[0].phoneOnRecord)).toBe(digits(P));
    expect(seen[0].workerId).toBe(imp.id);
    expect(await proof(own.id)).toMatchObject({ state: 'verified', vn: digits(P), vm: 'otp_verify_whatsapp', vch: null });

    // plano B sem ficha para o e-mail do token → CANDIDATE_NOT_FOUND, o port nem é chamado
    const antes = seen.length;
    const semFicha = await uc.execute({ authUid: ownRow.auth_uid, email: `nao-existe-${randomUUID()}@x.test`, challengeId: 'VE' + randomUUID().replace(/-/g, ''), code: '123456' });
    expect(semFicha).toMatchObject({ ok: false, code: 'CANDIDATE_NOT_FOUND' });
    expect(seen.length).toBe(antes);
  });
});
