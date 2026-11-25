/**
 * D797 adendo 3 (caso T-13, "Mandarme otro código" da CT-05): o app só conhece o celular MASCARADO. `phone/start` aceita
 * `{ challengeId }` SEM `phone` quando o desafio é de claim da ficha com o e-mail do token: o servidor emite código novo para o
 * telefone gravado no desafio (ou na ficha, plano B), com os MESMOS limites de emissão do `start` (por telefone e por ficha).
 * HTTP real + Postgres real como `enlite_app`, limites de PRODUÇÃO (DEFAULT_OTP_SEND_LIMITS); o único dublê é o ENVIO do código
 * (nenhum canal real). Dados sintéticos.
 */
import { randomUUID } from 'crypto';
import { novaFicha, novoTelefone } from './helpers/phoneVerificationFixtures';
import { startPhoneVerificationHarness, PhoneVerificationHarness } from './helpers/phoneVerificationHarness';

describe('phone/start com challengeId e sem phone (reenvio do claim, D797 adendo 3)', () => {
  let h: PhoneVerificationHarness;
  const digits = (p: string) => p.replace(/\D/g, '');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  beforeAll(async () => { h = await startPhoneVerificationHarness({ realLimits: true }); });
  afterAll(async () => { await h.close(); });

  const importada = async (phone: string, authUid = `anacareimport_ad3-${randomUUID()}`) =>
    (await h.pool.query<{ id: string; email: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id, email`,
      [authUid, `ad3-${randomUUID()}@anacareimport.invalid`, phone],
    )).rows[0];
  const desafios = async (workerId: string) =>
    (await h.pool.query(`SELECT id, purpose, phone_e164, status FROM otp_challenges WHERE worker_id = $1 ORDER BY created_at`, [workerId])).rows;
  /** Token SEM ficha própria (D734) com o e-mail da ficha importada: o caso T-13. */
  const tokenDa = (email: string) => h.asToken(`uid-ad3-${randomUUID()}`, email);

  it('(a) só challengeId de claim → código NOVO para o telefone do desafio; o telefone inteiro não sai; o código novo confirma', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const { challengeId: antigo } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    const enviadosAntes = h.sent.length;
    const token = tokenDa(imp.email);

    const r = await token.start({ challengeId: antigo });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'SENT', code: 'CLAIM_PENDING', resendAfterSec: 60, expiresInSec: 600 });
    expect(r.json.data.challengeId).toMatch(UUID);
    expect(r.json.data.challengeId).not.toBe(antigo);
    expect(r.json.data.phoneMasked).toEqual(expect.any(String));
    expect(JSON.stringify(r.json)).not.toContain(digits(P));
    expect(h.sent.length).toBe(enviadosAntes + 1);
    expect(h.sent[h.sent.length - 1].toE164).toBe(`+${digits(P)}`);
    expect(await desafios(imp.id)).toEqual([
      { id: antigo, purpose: 'claim', phone_e164: `+${digits(P)}`, status: 'canceled' },
      { id: r.json.data.challengeId, purpose: 'claim', phone_e164: `+${digits(P)}`, status: 'pending' },
    ]);

    const c = await token.confirm({ challengeId: r.json.data.challengeId, code: h.lastCode() });
    expect(c.status).toBe(200);
    expect(c.json.data).toMatchObject({ status: 'VERIFIED' });
  });

  it('(a) desafio VENCIDO também reenvia (é para isso que o reenvio existe)', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const { challengeId } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    await h.pool.query(`UPDATE otp_challenges SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [challengeId]);
    const r = await tokenDa(imp.email).start({ challengeId });
    expect(r.status).toBe(200);
    expect(h.sent[h.sent.length - 1].toE164).toBe(`+${digits(P)}`);
  });

  it('(a) plano B (id `VE…`, sem linha) → código novo para o telefone gravado na ficha do e-mail do token', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const enviadosAntes = h.sent.length;
    const r = await tokenDa(imp.email).start({ challengeId: 'VE' + 'a'.repeat(32) });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'SENT', code: 'CLAIM_PENDING' });
    expect(h.sent.length).toBe(enviadosAntes + 1);
    expect(h.sent[h.sent.length - 1].toE164).toBe(`+${digits(P)}`);
    expect((await desafios(imp.id)).map((d) => d.purpose)).toEqual(['claim']);
  });

  it('(b) challengeId de claim de OUTRA ficha → 400 CANDIDATE_NOT_FOUND, nada emitido em nenhuma das duas', async () => {
    const minha = await importada(novoTelefone());
    const Q = novoTelefone();
    const alheia = await importada(Q);
    const { challengeId } = await h.openChallenge(alheia.id, 'claim', `+${digits(Q)}`);
    const enviadosAntes = h.sent.length;
    const r = await tokenDa(minha.email).start({ challengeId });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('CANDIDATE_NOT_FOUND');
    expect(JSON.stringify(r.json)).not.toContain(digits(Q));
    expect(h.sent.length).toBe(enviadosAntes);
    expect(await desafios(minha.id)).toEqual([]);
    expect((await desafios(alheia.id)).map((d) => d.status)).toEqual(['pending']); // o desafio alheio nem é cancelado
  });

  it('(b) e-mail do token sem ficha importada (outra conta) → CANDIDATE_NOT_FOUND, nada emitido', async () => {
    const Q = novoTelefone();
    const alheia = await importada(Q);
    const { challengeId } = await h.openChallenge(alheia.id, 'claim', `+${digits(Q)}`);
    const enviadosAntes = h.sent.length;
    const r = await tokenDa(`outra-conta-${randomUUID()}@ad3.test`).start({ challengeId });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('CANDIDATE_NOT_FOUND');
    expect(h.sent.length).toBe(enviadosAntes);
    expect((await desafios(alheia.id)).length).toBe(1);
  });

  it('(b) desafio que não é de claim (phone_verify) e id inexistente → CANDIDATE_NOT_FOUND, nada emitido', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const { challengeId: pv } = await h.openChallenge(imp.id, 'phone_verify', `+${digits(P)}`);
    const enviadosAntes = h.sent.length;
    const token = tokenDa(imp.email);
    for (const challengeId of [pv, randomUUID(), 'TWILIO_NOT_CONFIGURED']) {
      const r = await token.start({ challengeId });
      expect([challengeId, r.status, r.json.code]).toEqual([challengeId, 400, 'CANDIDATE_NOT_FOUND']);
    }
    expect(h.sent.length).toBe(enviadosAntes);
    expect((await desafios(imp.id)).map((d) => d.purpose)).toEqual(['phone_verify']);
  });

  it('(b) ficha que já tem login (não reclamável) → NOT_IMPORTABLE, nada emitido', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const { challengeId } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    await h.pool.query(`UPDATE workers SET auth_uid = $2 WHERE id = $1`, [imp.id, `uid-outro-login-${randomUUID()}`]);
    const enviadosAntes = h.sent.length;
    const r = await tokenDa(imp.email).start({ challengeId });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('NOT_IMPORTABLE');
    expect(h.sent.length).toBe(enviadosAntes);
    expect((await desafios(imp.id)).length).toBe(1);
  });

  it('(c) o limite de emissão (3 por telefone/ficha em 15 min) vale por este caminho e conta o envio do init', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    let { challengeId } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`); // 1ª emissão (a do init)
    const token = tokenDa(imp.email);
    for (let i = 0; i < 2; i++) { // 2ª e 3ª
      const ok = await token.start({ challengeId });
      expect(ok.status).toBe(200);
      challengeId = ok.json.data.challengeId;
    }
    const enviadosAntes = h.sent.length;
    const r = await token.start({ challengeId }); // 4ª: estoura
    expect(r.status).toBe(429);
    expect(r.json.code).toBe('RATE_LIMITED');
    expect(h.sent.length).toBe(enviadosAntes);
    expect((await desafios(imp.id)).length).toBe(3);
    expect((await desafios(imp.id)).filter((d) => d.status === 'pending').map((d) => d.id)).toEqual([challengeId]); // nada cancelado
  });

  it('(d) com phone: igual a hoje (phone_verify para o número digitado), e um challengeId junto é ignorado', async () => {
    const own = await novaFicha(h.pool, { phone: null });
    const P = novoTelefone();
    const r = await h.as(own.id).start({ phone: P });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'SENT' });
    expect(r.json.data.code).toBeUndefined();
    expect(h.sent[h.sent.length - 1].toE164).toBe(`+${digits(P)}`);

    const Q = novoTelefone();
    const R = novoTelefone();
    const alheia = await importada(R);
    const { challengeId } = await h.openChallenge(alheia.id, 'claim', `+${digits(R)}`);
    const own2 = await novaFicha(h.pool, { phone: null });
    const r2 = await h.as(own2.id).start({ phone: Q, challengeId });
    expect(r2.status).toBe(200);
    expect(r2.json.data.code).toBeUndefined();
    expect(h.sent[h.sent.length - 1].toE164).toBe(`+${digits(Q)}`);
    expect((await desafios(own2.id)).map((d) => [d.purpose, d.phone_e164])).toEqual([['phone_verify', `+${digits(Q)}`]]);
  });

  it('(d) sem phone e sem challengeId → 400 de campo obrigatório', async () => {
    const own = await novaFicha(h.pool, { phone: null });
    const r = await h.as(own.id).start({});
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('Missing required field: phone or challengeId');
  });
});
