/**
 * POST /api/auth/claim/{start,confirm} com TOKEN REAL (emulador Firebase, API com USE_MOCK_AUTH=false) — H3, D650.
 *
 * Por que aqui além de tests/e2e/claim-uid-do-token.e2e.test.ts: no stack mock (backend-e2e principal) o
 * MockAuthMiddleware devolve 401 a qualquer /api sem token ANTES da rota — o caso "sem token" passa mesmo sem
 * `requireAuth`. Só este stack valida o token de verdade, então só ele prova que a ROTA exige token.
 *
 *  (a) sem Bearer → 401 em start e confirm, e a ficha importada segue intacta
 *  (b) Bearer inválido (lixo) → 401
 *  (c) Bearer de A + body authUid de B → 403 em start e confirm; ficha intacta, sem sid/candidato na resposta
 *
 * Nenhum caso chega ao use case (nada de OTP, nada de canal).
 */
import axios from 'axios';
import { Pool } from 'pg';
import { API_REAL_URL, exigirStackReal, realAccount } from './helpers/realAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5440/enlite_e2e';

describe('claim start/confirm — token REAL obrigatório, uid só do token (H3/D650)', () => {
  let pool: Pool;
  const stamp = `${Date.now()}`;
  const phoneFicha = `54911${stamp.slice(-8)}`;
  const fichaUid = `anacareimport_h3real_${stamp}`;
  const fichaEmail = `ficha-real-${stamp}@exemplo.test`;
  let fichaId = '';
  let n = 0;
  // Rate limit por IP (chave = X-Forwarded-For): um IP por chamada, senão reexecutar dá 429.
  const ip = () => ({ 'X-Forwarded-For': `203.0.113.${(Number(stamp.slice(-6)) + ++n) % 250 + 1}` });
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    axios.post(`${API_REAL_URL}${path}`, body, { headers: { ...ip(), ...headers }, validateStatus: () => true });
  const ficha = async () =>
    (await pool.query('SELECT auth_uid, email FROM workers WHERE id = $1', [fichaId])).rows[0];

  beforeAll(async () => {
    await exigirStackReal();
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

  const startBody = (extra: object = {}) => ({ email: `x-${stamp}@exemplo.test`, phone: `+${phoneFicha}`, ...extra });
  const confirmBody = (extra: object = {}) => ({
    verificationSid: 'TEST_nao-importa', otp: '123456', email: `x-${stamp}@exemplo.test`, candidateWorkerId: fichaId, ...extra,
  });
  const semDado = (data: unknown) => {
    const s = JSON.stringify(data);
    expect(s).not.toContain(fichaId);
    expect(s).not.toContain('verificationSid');
    expect(s).not.toContain('phoneMasked');
  };

  it('(a) sem Bearer → 401 em start e confirm; ficha intacta e nada vaza', async () => {
    const s = await post('/api/auth/claim/start', startBody({ authUid: 'uid-qualquer' }));
    expect(s.status).toBe(401);
    semDado(s.data);
    const c = await post('/api/auth/claim/confirm', confirmBody({ authUid: 'uid-qualquer' }));
    expect(c.status).toBe(401);
    expect(await ficha()).toEqual({ auth_uid: fichaUid, email: fichaEmail });
  });

  it('(b) Bearer inválido → 401 em start e confirm', async () => {
    const h = { Authorization: 'Bearer isto.nao.e-um-token' };
    expect((await post('/api/auth/claim/start', startBody(), h)).status).toBe(401);
    expect((await post('/api/auth/claim/confirm', confirmBody(), h)).status).toBe(401);
    expect(await ficha()).toEqual({ auth_uid: fichaUid, email: fichaEmail });
  });

  it('(c) Bearer REAL de A + body authUid de B → 403 em start e confirm; ficha intacta', async () => {
    const a = await realAccount(`a-real-${stamp}@exemplo.test`, { account_type: 'worker' });
    const h = { Authorization: `Bearer ${a.token}` };
    const s = await post('/api/auth/claim/start', startBody({ authUid: `uid-b-${stamp}` }), h);
    expect(s.status).toBe(403);
    semDado(s.data);
    const c = await post('/api/auth/claim/confirm', confirmBody({ authUid: `uid-b-${stamp}` }), h);
    expect(c.status).toBe(403);
    semDado(c.data);
    expect(await ficha()).toEqual({ auth_uid: fichaUid, email: fichaEmail });
  });
});
