/**
 * POST /api/workers/init — identidade SÓ do token (H2, D650).
 *
 * Antes: a rota era pública e lia authUid/email do BODY — qualquer um sem login lia a ficha
 * de um uid, trocava o auth_uid de uma ficha pelo e-mail e disparava OTP. Estes casos batem
 * na API real (mock auth) e conferem o BANCO, não só a resposta.
 *
 *  (a) sem Bearer → 401
 *  (b) cadastro NOVO, uid sem ficha → 201 e a ficha existe com aquele auth_uid
 *      (prova o INSERT sob `worker_self`, que é o contexto que o requireAuth carimba)
 *  (c) Bearer de A + body authUid de B → 403 e nada de B na resposta
(d) Bearer de D (sem ficha) + body email da ficha de C → auth_uid de C intacto
 *  (e) 2ª chamada de A (login de volta) → 200 com a própria ficha
 */
import { Pool } from 'pg';
import { createApiClient, getMockToken, postWorkerInit, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('POST /api/workers/init — uid/email só do token (H2/D650)', () => {
  const api = createApiClient();
  let pool: Pool;
  const stamp = `${Date.now()}`;
  const uidA = `uid-a-${stamp}`;
  const uidB = `uid-b-${stamp}`;
  const uidC = `uid-c-${stamp}`;
  const uidD = `uid-d-${stamp}`;
  const emailA = `a-${stamp}@exemplo.test`;
  const emailB = `b-${stamp}@exemplo.test`;
  const emailC = `c-${stamp}@exemplo.test`;
  const emailD = `d-${stamp}@exemplo.test`;
  const created: string[] = [];

  const authUidOf = async (workerId: string): Promise<string | null> => {
    const r = await pool.query('SELECT auth_uid FROM workers WHERE id = $1', [workerId]);
    return r.rows[0]?.auth_uid ?? null;
  };

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    for (const id of created) await pool.query('DELETE FROM workers WHERE id = $1', [id]).catch(() => {});
    await pool.end();
  });

  it('(a) sem Bearer → 401 e nada é gravado', async () => {
    const res = await api.post('/api/workers/init', { authUid: uidA, email: emailA, country: 'AR' });
    expect(res.status).toBe(401);
    const n = await pool.query('SELECT count(*)::int AS n FROM workers WHERE email = $1', [emailA]);
    expect(n.rows[0].n).toBe(0);
  });

  it('(b) cadastro NOVO com Bearer de uid sem ficha → 201 e a ficha existe com auth_uid do token', async () => {
    const res = await postWorkerInit(api, { authUid: uidA, email: emailA, country: 'AR' });
    expect(res.status).toBe(201);
    const workerId = res.data.data.worker.id as string;
    created.push(workerId);
    expect(await authUidOf(workerId)).toBe(uidA);
    const row = await pool.query('SELECT email, auth_uid FROM workers WHERE id = $1', [workerId]);
    // eslint-disable-next-line no-console
    console.log(`PROVA (b): status=${res.status} workerId=${workerId} row=${JSON.stringify(row.rows[0])}`);
  });

  it('(c) Bearer de A + body authUid de B → 403 e a resposta não traz dado de B', async () => {
    const b = await postWorkerInit(api, { authUid: uidB, email: emailB, country: 'AR' });
    expect(b.status).toBe(201);
    created.push(b.data.data.worker.id);

    const tokenA = await getMockToken(api, { uid: uidA, email: emailA, role: 'worker' });
    const res = await api.post(
      '/api/workers/init',
      { authUid: uidB, email: emailB, country: 'AR' },
      { headers: { Authorization: `Bearer ${tokenA}` } },
    );
    expect(res.status).toBe(403);
    const corpo = JSON.stringify(res.data);
    expect(corpo).not.toContain(b.data.data.worker.id);
    expect(corpo).not.toContain(emailB);
    expect(corpo).not.toContain(uidB);
  });

  it('(d) Bearer de D (ainda sem ficha) + body com o e-mail da ficha de C → auth_uid da ficha de C intacto', async () => {
    const c = await postWorkerInit(api, { authUid: uidC, email: emailC, country: 'AR' });
    expect(c.status).toBe(201);
    const cId = c.data.data.worker.id as string;
    created.push(cId);

    // D SEM ficha: é o único caminho que chega à reconexão por e-mail do use case
    // (quem já tem ficha por uid sai antes, em findByAuthUid).
    const tokenD = await getMockToken(api, { uid: uidD, email: emailD, role: 'worker' });
    const res = await api.post(
      '/api/workers/init',
      { authUid: uidD, email: emailC, country: 'AR' },
      { headers: { Authorization: `Bearer ${tokenD}` } },
    );
    expect(res.status).toBe(201);
    created.push(res.data.data.worker.id);
    expect(res.data.data.worker.id).not.toBe(cId);
    expect(JSON.stringify(res.data)).not.toContain(emailC);
    expect(await authUidOf(cId)).toBe(uidC);
  });

  it('(e) login de volta de A (2ª chamada) → 200 com a própria ficha', async () => {
    const res = await postWorkerInit(api, { authUid: uidA, email: emailA, country: 'AR' });
    expect(res.status).toBe(200);
    expect(res.data.data.worker.authUid).toBe(uidA);
    expect(res.data.data.worker.email).toBe(emailA);
  });
});
