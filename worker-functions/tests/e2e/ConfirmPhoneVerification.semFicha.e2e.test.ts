/**
 * D797 adendo 2 (T-13 sem ficha própria): a conta criada pelo app NÃO tem ficha. O `phone/confirm` de claim LIGA a conta à ficha
 * importada (grava o `auth_uid` do token nela) e a prova do celular e o aceite entram NA FICHA RECLAMADA, numa transação só.
 * HTTP real + Postgres real como `enlite_app`; o único dublê é o ENVIO do código (nenhum canal real). Dados sintéticos.
 */
import { randomUUID } from 'crypto';
import { novoTelefone } from './helpers/phoneVerificationFixtures';
import { startPhoneVerificationHarness, PhoneVerificationHarness } from './helpers/phoneVerificationHarness';

describe('phone/confirm de claim com a conta SEM ficha própria', () => {
  let h: PhoneVerificationHarness;
  const digits = (p: string) => p.replace(/\D/g, '');
  beforeAll(async () => { h = await startPhoneVerificationHarness(); });
  afterAll(async () => { await h.close(); });

  const importada = async (phone: string, authUid = `anacareimport_t13-${randomUUID()}`) =>
    (await h.pool.query<{ id: string; email: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone) VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id, email`,
      [authUid, `t13-${randomUUID()}@anacareimport.invalid`, phone],
    )).rows[0];
  const row = async (id: string) =>
    (await h.pool.query(
      `SELECT auth_uid, merged_into_id, phone_verified_normalized AS vn, phone_verified_at AS vat, phone_verified_method AS vm,
              phone_verified_otp_challenge_id AS vch, lgpd_consent_at AS lgpd, terms_accepted_at AS terms, privacy_accepted_at AS priv,
              fn_worker_phone_verification_state(id) AS state FROM workers WHERE id = $1`, [id])).rows[0];
  const donos = async (uid: string) => (await h.pool.query(`SELECT id FROM workers WHERE auth_uid = $1`, [uid])).rows.map((r) => r.id as string);
  /** A linha INTEIRA (todas as colunas, inclusive `updated_at`), para provar "nada mudou". */
  const linha = async (id: string) => (await h.pool.query(`SELECT to_jsonb(w) AS j FROM workers w WHERE id = $1`, [id])).rows[0].j;

  it('T-13 conta sem ficha + código certo: a ficha importada ganha o auth_uid, a prova do celular e o trio de aceite', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const uid = `uid-t13-${randomUUID()}`;
    const email = `conta-app-${randomUUID()}@t13.test`;
    expect(await donos(uid)).toEqual([]); // controle: a conta não tem ficha
    const { challengeId, code } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    const aceite = new Date().toISOString();
    const r = await h.asToken(uid, email).confirm({ challengeId, code, consentAcceptedAt: aceite });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'VERIFIED' });
    expect(JSON.stringify(r.json)).not.toContain(digits(P));
    expect(await donos(uid)).toEqual([imp.id]);
    const after = await row(imp.id);
    expect(after).toMatchObject({ auth_uid: uid, merged_into_id: null, state: 'verified', vn: digits(P), vm: 'otp_whatsapp_template', vch: challengeId });
    expect(after.vat).not.toBeNull();
    expect(after.lgpd).not.toBeNull();
    expect(after.terms).not.toBeNull();
    expect(after.priv).not.toBeNull();
  });

  it('T-13 código errado: nada muda na ficha importada (sem auth_uid novo, sem prova, sem aceite)', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const antes = await row(imp.id);
    const uid = `uid-t13-${randomUUID()}`;
    const { challengeId, code } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    const errado = code === '000000' ? '111111' : '000000';
    const r = await h.asToken(uid, `conta-app-${randomUUID()}@t13.test`).confirm({ challengeId, code: errado, consentAcceptedAt: new Date().toISOString() });
    expect(r.status).toBe(400);
    expect(await row(imp.id)).toEqual(antes);
    expect(antes.vn).toBeNull();
    expect(await donos(uid)).toEqual([]);
  });

  it('T-13 ficha importada que já tem outro login: recusa com NOT_IMPORTABLE (código do claim), nada muda e o desafio não é consumido', async () => {
    const P = novoTelefone();
    const outroLogin = `uid-outro-login-${randomUUID()}`;
    const imp = await importada(P, outroLogin);
    const uid = `uid-t13-${randomUUID()}`;
    const { challengeId, code } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    const antes = await linha(imp.id);
    const r = await h.asToken(uid, `conta-app-${randomUUID()}@t13.test`).confirm({ challengeId, code, consentAcceptedAt: new Date().toISOString() });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('NOT_IMPORTABLE');
    expect(await linha(imp.id)).toEqual(antes); // linha inteira, inclusive updated_at, auth_uid, prova e aceite
    expect(antes.auth_uid).toBe(outroLogin);
    expect(await donos(uid)).toEqual([]);
    expect((await h.pool.query(`SELECT status FROM otp_challenges WHERE id = $1`, [challengeId])).rows[0].status).toBe('pending');
  });

  it('T-13 corrida: outro login pega a ficha DEPOIS das leituras e ANTES do UPDATE → NOT_IMPORTABLE, nada do token gravado', async () => {
    // As leituras do caso de uso (isClaimableWorker, findById) veem a ficha importada; a gravação do outro login fica com a
    // linha travada até a requisição chegar ao UPDATE. Só a condição no próprio UPDATE recusa aqui — as leituras já passaram.
    const P = novoTelefone();
    const imp = await importada(P);
    const uid = `uid-t13-${randomUUID()}`;
    const outroLogin = `uid-outro-login-${randomUUID()}`;
    const { challengeId, code } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
    const outro = await h.pool.connect();
    try {
      await outro.query('BEGIN');
      await outro.query(`UPDATE workers SET auth_uid = $2, updated_at = NOW() WHERE id = $1`, [imp.id, outroLogin]);
      const gravadaPeloOutro = (await outro.query(`SELECT to_jsonb(w) AS j FROM workers w WHERE id = $1`, [imp.id])).rows[0].j;
      const pedido = h.asToken(uid, `conta-app-${randomUUID()}@t13.test`).confirm({ challengeId, code, consentAcceptedAt: new Date().toISOString() });
      // Espera o UPDATE do pedido ficar preso na trava da linha (prova de que as leituras já passaram).
      let preso = false;
      for (let i = 0; i < 200 && !preso; i++) {
        const { rows } = await h.pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE workers%' AND pid <> pg_backend_pid()`,
        );
        preso = rows.length > 0;
        if (!preso) await new Promise((res) => setTimeout(res, 25));
      }
      expect(preso).toBe(true);
      await outro.query('COMMIT');
      const r = await pedido;
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('NOT_IMPORTABLE');
      expect(await linha(imp.id)).toEqual(gravadaPeloOutro); // linha inteira: sem auth_uid do token, sem prova, sem aceite
      expect(await donos(uid)).toEqual([]);
      expect(await donos(outroLogin)).toEqual([imp.id]);
    } finally {
      await outro.query('ROLLBACK').catch(() => undefined);
      outro.release();
    }
  });

  it('T-13 falha ao gravar a prova desfaz a ligação: a ficha importada segue sem o auth_uid do token', async () => {
    const P = novoTelefone();
    const imp = await importada(P);
    const uid = `uid-t13-${randomUUID()}`;
    await h.pool.query(`CREATE OR REPLACE FUNCTION public.fn_t13_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom t13'; END $$`);
    await h.pool.query(`CREATE TRIGGER trg_t13_boom BEFORE UPDATE OF phone_verified_at ON workers FOR EACH ROW WHEN (NEW.id = '${imp.id}') EXECUTE FUNCTION public.fn_t13_boom()`);
    try {
      const { challengeId, code } = await h.openChallenge(imp.id, 'claim', `+${digits(P)}`);
      const r = await h.asToken(uid, `conta-app-${randomUUID()}@t13.test`).confirm({ challengeId, code, consentAcceptedAt: new Date().toISOString() });
      expect(r.status).toBe(500);
      expect(JSON.stringify(r.json)).not.toContain(digits(P));
      expect(await donos(uid)).toEqual([]);
      expect(await row(imp.id)).toMatchObject({ vn: null, lgpd: null });
    } finally {
      await h.pool.query(`DROP TRIGGER IF EXISTS trg_t13_boom ON workers`);
      await h.pool.query(`DROP FUNCTION IF EXISTS public.fn_t13_boom()`);
    }
  });

  it('T-13 sem ficha e sem ficha para reclamar com o número: segue WORKER_NOT_FOUND', async () => {
    const r = await h.asToken(`uid-t13-${randomUUID()}`, `conta-app-${randomUUID()}@t13.test`).confirm({ phone: novoTelefone(), challengeId: randomUUID(), code: '123456' });
    expect(r.status).toBe(404);
    expect(r.json.code).toBe('WORKER_NOT_FOUND');
  });
});
