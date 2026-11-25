/**
 * T-F3c-135 — `confirm` da finalidade `phone_verify` (AC-14), HTTP real + Postgres real como `enlite_app`. Só o ENVIO do código é
 * dublê. A troca de um número já gravado só acontece nesta rota; o `init` segue PHONE_LOCKED (#902 intacto).
 */
import { novaFicha, novoTelefone, gravarVerificacao } from './helpers/phoneVerificationFixtures';
import { startPhoneVerificationHarness, PhoneVerificationHarness } from './helpers/phoneVerificationHarness';

describe('confirm phone_verify: a única rota que troca um número já gravado', () => {
  let h: PhoneVerificationHarness;
  beforeAll(async () => { h = await startPhoneVerificationHarness(); });
  afterAll(async () => { await h.close(); });

  const row = async (id: string) =>
    (await h.pool.query(
      `SELECT phone, phone_verified_normalized AS vn, phone_verified_otp_challenge_id AS ch, fn_worker_phone_verification_state(id) AS state
         FROM workers WHERE id = $1`, [id])).rows[0];
  const digits = (p: string) => p.replace(/\D/g, '');

  it('T-F3c-135 ficha verificada em P troca para Q só pelo confirm com o código de Q: o estado vira verified em Q', async () => {
    const P = novoTelefone();
    const Q = novoTelefone();
    const a = await novaFicha(h.pool, { phone: P });
    await gravarVerificacao(h.pool, a.id);
    expect((await row(a.id)).state).toBe('verified'); // verificada em P

    const caller = h.as(a.id);
    const started = await caller.start({ phone: Q });
    expect(started.status).toBe(200);
    expect(started.json.data).toMatchObject({ status: 'SENT' });
    expect(h.sent[h.sent.length - 1].toE164).toBe(`+${digits(Q)}`); // o código foi para Q, não para P

    // código ERRADO não troca nada: o número só muda com a posse de Q provada
    const wrong = String((Number(h.lastCode()) + 1) % 1_000_000).padStart(6, '0');
    const bad = await caller.confirm({ phone: Q, challengeId: started.json.data.challengeId, code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ code: 'INVALID_OTP' });
    expect(digits((await row(a.id)).phone)).toBe(digits(P));

    const done = await caller.confirm({ phone: Q, challengeId: started.json.data.challengeId, code: h.lastCode() });
    expect(done.status).toBe(200);
    expect(done.json.data).toMatchObject({ status: 'VERIFIED' });
    expect(done.json.data.phoneMasked).not.toContain(digits(Q));
    const after = await row(a.id);
    expect(after).toMatchObject({ state: 'verified', vn: digits(Q), ch: started.json.data.challengeId });
    expect(digits(after.phone)).toBe(digits(Q));
  });

  it('T-F3c-135 o init com Q continua PHONE_LOCKED e o telefone não muda', async () => {
    const P = novoTelefone();
    const Q = novoTelefone();
    const a = await novaFicha(h.pool, { phone: P });
    const { rows } = await h.pool.query(`SELECT auth_uid, email FROM workers WHERE id = $1`, [a.id]);
    const { InitWorkerUseCase } = await import('../../src/modules/worker/application/InitWorkerUseCase');
    const { WorkerRepository } = await import('../../src/modules/worker/infrastructure/WorkerRepository');
    const out = await new InitWorkerUseCase(new WorkerRepository()).execute({
      authUid: rows[0].auth_uid, email: rows[0].email, phone: Q, lgpdOptIn: false, country: 'AR',
    } as never);
    expect(out.getValue()).toMatchObject({ code: 'PHONE_LOCKED' });
    expect(digits((await row(a.id)).phone)).toBe(digits(P));
  });

  it('T-F3c-135 número de outra ficha viva já verificada: PHONE_IN_USE sem gravar e sem consumir o desafio', async () => {
    const Q = novoTelefone();
    const dona = await novaFicha(h.pool, { phone: Q });
    await gravarVerificacao(h.pool, dona.id);
    const P = novoTelefone();
    const a = await novaFicha(h.pool, { phone: P });
    const antes = await row(a.id);
    const { challengeId, code } = await h.openChallenge(a.id, 'phone_verify', `+${digits(Q)}`);

    const r = await h.as(a.id).confirm({ phone: Q, challengeId, code });
    expect(r.status).toBe(409);
    expect(r.json).toMatchObject({ code: 'PHONE_IN_USE' });
    expect(JSON.stringify(r.json)).not.toMatch(/duplicate key|idx_workers|uq_workers/);
    expect(await row(a.id)).toEqual(antes);
    const st = await h.pool.query(`SELECT status FROM otp_challenges WHERE id = $1`, [challengeId]);
    expect(st.rows[0].status).toBe('pending');
    expect((await row(dona.id)).state).toBe('verified');
  });
});
