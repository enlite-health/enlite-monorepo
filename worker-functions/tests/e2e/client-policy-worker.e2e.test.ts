/**
 * client-policy-worker.e2e.test.ts — política do prestador no motor Cedar REAL, por HTTP REAL, banco REAL
 * (acesso-do-cliente, F2, T207 (a), fase-2.md itens 3 e 9).
 *
 * Cadeia de verdade (correlation → dbSession → mockAuth → AuthMiddleware real → `requireAuth` + `requirePermission`) numa
 * porta efêmera, com `fetch`. O engine de não-staff é o `createClientPolicyEngine(pool)` (CedarClientPolicyEngine +
 * ClientEntityLoader reais, Postgres real). As rotas são as do `index.ts` com handler-eco: o que se prova aqui é a DECISÃO
 * de autorização, não o controller. Fixtures sintéticas, sem PII; `iam.*` é append-only → uids com sufixo aleatório por execução.
 */
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { tokenMock, montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const uid = (n: string) => `e2e-clientpol-${RUN}-${n}`;

// 6 rotas de prestador do index.ts + 4 do accountLinkRoutes (mesmos guards) — todas ('worker', read|update).
const ROTAS_DE_PRESTADOR: Array<[string, string, 'read' | 'update']> = [
  ['PUT', '/api/workers/step', 'update'],
  ['GET', '/api/workers/me', 'read'],
  ['PUT', '/api/workers/me/general-info', 'update'],
  ['PUT', '/api/workers/me/service-area', 'update'],
  ['GET', '/api/workers/me/availability', 'read'],
  ['PUT', '/api/workers/me/availability', 'update'],
  ['POST', '/api/workers/me/account-link/lookup', 'update'],
  ['POST', '/api/workers/me/account-link/start', 'update'],
  ['POST', '/api/workers/me/account-link/confirm', 'update'],
  ['POST', '/api/workers/me/account-link/finalize', 'update'],
];

describe('política do prestador — Cedar real, HTTP real, banco real (acesso-do-cliente F2)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const envAnterior: Record<string, string | undefined> = {};
  let n = 0;

  const criarPrestador = async (u: string): Promise<string> => {
    const r = await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW()) RETURNING id`,
      [u, `${u}@e2e.local`, `+5491${RUN.slice(0, 4)}${String(++n).padStart(4, '0')}`],
    );
    return r.rows[0].id;
  };

  async function chamar(metodo: string, caminho: string, u: string, extra: Record<string, string> = {}) {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(u, 'worker'), 'content-type': 'application/json', ...extra },
      body: metodo === 'GET' ? undefined : '{}',
    });
    const texto = await res.text();
    return { status: res.status, body: texto ? JSON.parse(texto) : {} };
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries({ USE_MOCK_AUTH: 'true', DATABASE_URL })) {
      envAnterior[k] = process.env[k];
      process.env[k] = v;
    }
    pool = new Pool({ connectionString: DATABASE_URL });
    const identity = await import('@modules/identity');
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    const { createClientPolicyEngine } = await import('@modules/identity/clientAuthorization/createClientPolicyEngine');
    const engine = createClientPolicyEngine(DatabaseConnection.getInstance().getPool());
    const auth = new identity.AuthMiddleware(
      { parseCredentials: () => null, authenticate: async () => null } as never,
      engine,
    );
    app = await montarAppDeFamilia({
      auth,
      montarRotas: ({ app: expressApp }) => {
        const eco = (req: any, res: any) => res.status(200).json({ uid: req.user.uid });
        const read = [auth.requireAuth(), auth.requirePermission('worker', 'read')];
        const update = [auth.requireAuth(), auth.requirePermission('worker', 'update')];
        for (const [m, caminho, acao] of ROTAS_DE_PRESTADOR) {
          (expressApp as any)[m.toLowerCase()](caminho, ...(acao === 'read' ? read : update), eco);
        }
        // Rota com id na URL: é por aqui que "A pede a ficha de B" vira HTTP (as rotas /me não têm id).
        expressApp.get('/test/workers/:id', ...read, eco);
        expressApp.delete('/api/users/me', auth.requireAuth(), auth.requirePermission('user', 'delete'), eco);
      },
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`e2e-clientpol-${RUN}-%`]);
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('prestador A nas 10 rotas de prestador (7 do index + 4 do vínculo, o DELETE por último) → ≠ 401/403', async () => {
    const a = uid('a');
    await criarPrestador(a);
    for (const [m, caminho] of ROTAS_DE_PRESTADOR) {
      const r = await chamar(m, caminho, a);
      expect([m, caminho, r.status]).toEqual([m, caminho, 200]);
      expect(r.body.uid).toBe(a);
    }
    const del = await chamar('DELETE', '/api/users/me', a);
    expect(del.status).toBe(200); // a Account é montada do token: o próprio login, sem comparar header
  });

  it('A pede a ficha de B por id → 403; a própria ficha → 200', async () => {
    const a = uid('a2');
    const b = uid('b2');
    const wa = await criarPrestador(a);
    const wb = await criarPrestador(b);
    expect((await chamar('GET', `/test/workers/${wa}`, a)).status).toBe(200);
    expect((await chamar('GET', `/test/workers/${wb}`, a)).status).toBe(403);
    expect((await chamar('GET', `/test/workers/${wa}`, b)).status).toBe(403);
  });

  it('A com x-auth-uid de B → o header é ignorado: age só em A (e a ficha de B segue negada)', async () => {
    const a = uid('a3');
    const b = uid('b3');
    await criarPrestador(a);
    const wb = await criarPrestador(b);
    const r = await chamar('GET', '/api/workers/me', a, { 'x-auth-uid': b });
    expect(r.status).toBe(200);
    expect(r.body.uid).toBe(a);
    expect((await chamar('GET', `/test/workers/${wb}`, a, { 'x-auth-uid': b })).status).toBe(403);
  });

  it('conta sem ficha de prestador → 403 nas rotas /me (sem care·worker não há recurso próprio)', async () => {
    expect((await chamar('GET', '/api/workers/me', uid('sem-ficha'))).status).toBe(403);
  });

  it('(item 9) login absorvido por merge acessa como a sobrevivente: /api/workers/me e a ficha dela → ≠ 401/403; a de outro segue negada', async () => {
    const s = uid('sobrevivente');
    const x = uid('absorvido');
    const outro = uid('outro');
    const ws = await criarPrestador(s);
    const wx = await criarPrestador(x);
    const wo = await criarPrestador(outro);
    await pool.query(`SELECT iam.ensure_person('firebase', $1)`, [s]);
    await pool.query(`SELECT iam.ensure_person('firebase', $1)`, [x]);
    await pool.query(`UPDATE workers SET merged_into_id = $1::uuid WHERE id = $2::uuid`, [ws, wx]);
    await pool.query(`SELECT iam.merge_person($1, $2, NULL)`, [x, s]);
    const raiz = async (u: string) =>
      (await pool.query(`SELECT iam.person_root(iam.resolve_person('firebase', $1)) AS p`, [u])).rows[0].p;
    expect(await raiz(x)).toBe(await raiz(s)); // o merge de fato absorveu

    expect((await chamar('GET', '/api/workers/me', x)).status).toBe(200);
    expect((await chamar('GET', `/test/workers/${ws}`, x)).status).toBe(200);
    expect((await chamar('GET', `/test/workers/${wo}`, x)).status).toBe(403);
  });
});
