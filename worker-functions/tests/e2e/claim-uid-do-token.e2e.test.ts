/**
 * POST /api/auth/claim/start e /confirm — token obrigatório, uid/email SÓ do token (H3, D650).
 *
 * Antes: as duas rotas eram públicas e liam authUid/email do BODY. O `start` disparava OTP ao
 * telefone da ficha por requisição anônima (e o corpo da resposta revelava se o telefone existe);
 * o `confirm` gravava `auth_uid`/`email` do body na ficha. Estes casos batem na API real e conferem
 * o BANCO, não só a resposta.
 *
 * CANAL: nenhum OTP real. O stack de teste sobe a API com E2E_OTP_BYPASS=true (sid sintético
 * `TEST_<uuid>`, código E2E_OTP_CODE) e `api.twilio.com` resolvendo para 127.0.0.1 (extra_hosts) —
 * TwilioVerifyService nunca fala com o Twilio. O caso feliz afirma o prefixo `TEST_` do sid.
 *
 *  (a) sem Bearer → 401 nas duas, e a ficha importada segue intacta
 *  (b) Bearer + telefone sem ficha → 200 { noCandidate: true }
 *  (c) Bearer de A + body authUid de B → 403 nas duas; ficha intacta
 *  (d) feliz: start → sid TEST_ → confirm grava uid/email do TOKEN (e-mail forjado no body é ignorado)
 */
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const OTP = process.env.E2E_OTP_CODE ?? '123456';
const EMULATOR = process.env.USE_FIREBASE_EMULATOR === 'true';

describe('POST /api/auth/claim/{start,confirm} — token obrigatório, uid/email só do token (H3/D650)', () => {
  const api = createApiClient();
  let pool: Pool;
  const stamp = `${Date.now()}`;
  const digits8 = stamp.slice(-8);
  const phoneFicha = `54911${digits8}`; // sintético; guardado só em dígitos, como a importação faz
  const phoneSemFicha = `54912${digits8}`;
  const fichaUid = `anacareimport_h3_${stamp}`;
  const fichaEmail = `ficha-${stamp}@exemplo.test`;
  const uidA = `uid-a-${stamp}`;
  const emailA = `a-${stamp}@exemplo.test`;
  const uidB = `uid-b-${stamp}`;
  let fichaId = '';

  // Rate limit por IP (start 3/15min, confirm 5/15min, em memória): cada chamada usa um X-Forwarded-For próprio
  // (a chave do limitador lê esse header), senão reexecutar a suíte no mesmo stack bateria em 429.
  let n = 0;
  const ip = () => ({ 'X-Forwarded-For': `198.51.100.${(Number(digits8) + ++n) % 250 + 1}` });
  const anon = () => ({ headers: ip() });
  const bearer = async (uid: string, email: string) => ({
    headers: { ...ip(), Authorization: `Bearer ${await getMockToken(api, { uid, email, role: 'worker' })}` },
  });
  const ficha = async () =>
    (await pool.query('SELECT auth_uid, email FROM workers WHERE id = $1', [fichaId])).rows[0] as {
      auth_uid: string;
      email: string;
    };
  // No emulador o uid do token é o que o emulador atribui; no mock é o pedido. O body só leva authUid no mock.
  const bodyUid = (uid: string) => (EMULATOR ? {} : { authUid: uid });

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    const r = await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW()) RETURNING id`,
      [fichaUid, fichaEmail, phoneFicha],
    );
    fichaId = r.rows[0].id;
  });

  afterAll(async () => {
    if (fichaId) await pool.query('DELETE FROM workers WHERE id = $1', [fichaId]).catch(() => {});
    await pool.end();
  });

  it('(a) sem Bearer → 401 em start e confirm, e a ficha importada segue intacta', async () => {
    const start = await api.post('/api/auth/claim/start', {
      authUid: uidA, email: emailA, phone: `+${phoneFicha}`,
    }, anon());
    expect(start.status).toBe(401);
    // não revela se o telefone existe: o corpo não carrega candidato/sid/máscara
    expect(JSON.stringify(start.data)).not.toContain(fichaId);
    expect(JSON.stringify(start.data)).not.toContain('verificationSid');

    const confirm = await api.post('/api/auth/claim/confirm', {
      verificationSid: 'TEST_nao-importa', otp: OTP, authUid: uidA, email: emailA, candidateWorkerId: fichaId,
    }, anon());
    expect(confirm.status).toBe(401);
    expect(await ficha()).toEqual({ auth_uid: fichaUid, email: fichaEmail });
  });

  it('(b) com Bearer, telefone SEM ficha → 200 noCandidate (nenhum OTP)', async () => {
    const res = await api.post(
      '/api/auth/claim/start',
      { phone: `+${phoneSemFicha}` },
      await bearer(uidA, emailA),
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ success: true, data: { noCandidate: true } });
  });

  it('(c) Bearer de A + body authUid de B → 403 em start e confirm; ficha intacta e sem sid na resposta', async () => {
    const start = await api.post(
      '/api/auth/claim/start',
      { authUid: uidB, email: emailA, phone: `+${phoneFicha}` },
      await bearer(uidA, emailA),
    );
    expect(start.status).toBe(403);
    expect(JSON.stringify(start.data)).not.toContain('verificationSid');
    expect(JSON.stringify(start.data)).not.toContain(fichaId);

    const confirm = await api.post(
      '/api/auth/claim/confirm',
      { verificationSid: 'TEST_nao-importa', otp: OTP, authUid: uidB, email: emailA, candidateWorkerId: fichaId },
      await bearer(uidA, emailA),
    );
    expect(confirm.status).toBe(403);
    expect(await ficha()).toEqual({ auth_uid: fichaUid, email: fichaEmail });
  });

  it('(d) feliz: start (sid TEST_, sem canal real) → confirm grava o uid/email do TOKEN; e-mail forjado do body é ignorado', async () => {
    const start = await api.post('/api/auth/claim/start', { ...bodyUid(uidA), email: emailA, phone: `+${phoneFicha}` }, await bearer(uidA, emailA));
    expect(start.status).toBe(200);
    const { candidateWorkerId, verificationSid } = start.data.data as {
      candidateWorkerId: string; verificationSid: string; phoneMasked: string;
    };
    expect(candidateWorkerId).toBe(fichaId);
    // PROVA de canal: sid sintético do bypass. Um sid real do Twilio começa com "VE".
    expect(verificationSid).toMatch(/^TEST_/);

    const confirm = await api.post(
      '/api/auth/claim/confirm',
      { ...bodyUid(uidA), verificationSid, otp: OTP, email: `forjado-${stamp}@exemplo.test`, candidateWorkerId: fichaId },
      await bearer(uidA, emailA),
    );
    expect(confirm.status).toBe(200);
    const row = await ficha();
    expect(row.email).toBe(emailA); // do token, não do body
    expect(row.auth_uid).not.toBe(fichaUid);
    if (!EMULATOR) expect(row.auth_uid).toBe(uidA);
  });
});
