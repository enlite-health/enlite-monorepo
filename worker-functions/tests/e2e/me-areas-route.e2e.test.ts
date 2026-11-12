/**
 * me-areas-route.e2e.test.ts — `GET /v1/me/areas` por HTTP REAL, banco REAL (acesso-do-cliente, F1, T109).
 *
 * Mesmo molde de `me-simulation-route.e2e.test.ts`: cadeia de verdade (correlation → dbSession → mockAuth → AuthMiddleware
 * real → rota) numa porta efêmera, com `fetch`. O banco tem as migrations 580/581. Fixtures sintéticas, sem PII.
 * A ÚNICA substituição é o Firebase Admin (dublê em memória de `getUser`/`setCustomUserClaims`/`revokeRefreshTokens`):
 * não há Identity Platform no e2e, e o claim regravado é lido de volta DESTE dublê. Nenhum dado de negócio é simulado.
 * `iam.*` é append-only (sem DELETE): os uids levam um sufixo aleatório por execução.
 */
import { randomBytes } from 'crypto';
import * as firebaseAdmin from 'firebase-admin';
import { Pool } from 'pg';
import { tokenMock, montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const uid = (n: string) => `e2e-mearea-${RUN}-${n}`;

type Claims = Record<string, unknown>;

describe('GET /v1/me/areas — HTTP real, banco real (acesso-do-cliente F1)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const claims = new Map<string, Claims>();
  /** Liga o Firebase pendurado: `getUser` nunca responde (DNS/Identity Platform sem resposta, CI do PR #831). */
  let firebasePendurado = false;
  const emailOf = (u: string) => `${u}@e2e.local`;
  const envAnterior: Record<string, string | undefined> = {};

  async function chamar(u: string | null, role?: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}/v1/me/areas`, {
      headers: u ? { Authorization: tokenMock(u, role ?? 'worker') } : {},
    });
    const texto = await res.text();
    return { status: res.status, body: texto ? JSON.parse(texto) : {} };
  }
  const contar = async (sql: string, p: unknown[]) => Number((await pool.query(sql, [p[0]])).rows[0].n);
  const pessoas = (u: string) => contar(`SELECT count(*) AS n FROM iam.person_login WHERE uid = $1`, [u]);

  beforeAll(async () => {
    for (const [k, v] of Object.entries({ USE_MOCK_AUTH: 'true', DATABASE_URL })) {
      envAnterior[k] = process.env[k];
      process.env[k] = v;
    }
    pool = new Pool({ connectionString: DATABASE_URL });
    // Dublê do Firebase Admin (só identidade/claims).
    jest.spyOn(firebaseAdmin, 'auth').mockImplementation((() => ({
      getUser: (u: string) =>
        firebasePendurado
          ? new Promise(() => undefined)
          : Promise.resolve({ uid: u, email: emailOf(u), customClaims: claims.get(u) ?? {} }),
      setCustomUserClaims: async (u: string, c: Claims) => void claims.set(u, c),
      revokeRefreshTokens: async () => undefined,
    })) as never);
    app = await montarAppDeFamilia({
      montarRotas: ({ app: expressApp, auth }) => {
        const { createMeAreasRouter } = require('@modules/identity/interfaces/meAreasRoute');
        expressApp.use('/v1', createMeAreasRouter(auth.requireAuth(), require('@shared/database/DatabaseConnection').DatabaseConnection.getInstance().getPool()));
      },
    });
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`e2e-mearea-${RUN}-%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`e2e-mearea-${RUN}-%`]);
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('sem Authorization → 401 (requireAuth é o portão)', async () => {
    expect((await chamar(null)).status).toBe(401);
  });

  it('(1) prestador → care·worker, entryRoute "/"', async () => {
    const u = uid('worker');
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
      [u, emailOf(u), `+5491100${RUN.slice(0, 4)}`],
    );
    const r = await chamar(u, 'worker');
    expect(r.status).toBe(200);
    expect(r.body.areas).toEqual([{ area: 'care', role: 'worker', entryRoute: '/' }]);
  });

  it('(2) staff → backoffice·staff, entryRoute "/admin"', async () => {
    const u = uid('staff');
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
       VALUES ($1, $2, 'admin', 'ACTIVE', true, '00000000-0000-0000-0000-000000000001')`,
      [u, emailOf(u)],
    );
    const r = await chamar(u, 'admin');
    expect(r.body.areas).toEqual([{ area: 'backoffice', role: 'staff', entryRoute: '/admin' }]);
  });

  it('(3) aluno (vínculo gravado) → learn·learner, entryRoute null', async () => {
    const u = uid('aluno');
    const pid = (await pool.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [u])).rows[0].p;
    await pool.query(`SELECT iam.grant_area_membership($1::uuid, 'learn', 'learner', $2)`, [pid, uid('ator')]);
    const r = await chamar(u, 'worker');
    expect(r.body.areas).toEqual([{ area: 'learn', role: 'learner', entryRoute: null }]);
  });

  it('(4) conta sem nada → []', async () => {
    const r = await chamar(uid('nada'), 'worker');
    expect(r.status).toBe(200);
    expect(r.body.areas).toEqual([]);
  });

  it('(5) claim divergente → resposta certa E claim regravado', async () => {
    const u = uid('diverge');
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
      [u, emailOf(u), `+5491101${RUN.slice(0, 4)}`],
    );
    claims.set(u, { role: 'worker', pid: 'pid-velho', areas: { backoffice: ['staff'] } });
    const r = await chamar(u, 'worker');
    expect(r.body.areas).toEqual([{ area: 'care', role: 'worker', entryRoute: '/' }]);
    expect(r.body.tokenRefreshRequired).toBe(true);
    const gravado = claims.get(u)!;
    expect(gravado.areas).toEqual({ care: ['worker'] });
    expect(gravado.pid).not.toBe('pid-velho');
    expect(gravado.role).toBe('worker'); // merge preserva o resto
    const segunda = await chamar(u, 'worker');
    expect(segunda.body.tokenRefreshRequired).toBe(false); // convergiu
  });

  it('(6) bootstrap: uid sem pessoa → pessoa + login criados, claim pid gravado, tokenRefreshRequired; 2ª chamada não cria nada', async () => {
    const u = uid('boot');
    expect(await pessoas(u)).toBe(0);
    const antes = Number((await pool.query(`SELECT count(*) AS n FROM iam.person`)).rows[0].n);
    const r1 = await chamar(u, 'worker');
    expect(r1.body.tokenRefreshRequired).toBe(true);
    expect(await pessoas(u)).toBe(1);
    const depois = Number((await pool.query(`SELECT count(*) AS n FROM iam.person`)).rows[0].n);
    expect(depois).toBe(antes + 1);
    const pid = (await pool.query(`SELECT person_id FROM iam.person_login WHERE uid = $1`, [u])).rows[0].person_id;
    expect(claims.get(u)!.pid).toBe(pid);

    const r2 = await chamar(u, 'worker');
    expect(r2.body.tokenRefreshRequired).toBe(false);
    expect(await pessoas(u)).toBe(1);
    expect(Number((await pool.query(`SELECT count(*) AS n FROM iam.person`)).rows[0].n)).toBe(depois);
    expect(claims.get(u)!.pid).toBe(pid);
  });

  it('(7) login removido → 401 (conta apagada não ressuscita)', async () => {
    const u = uid('removido');
    await pool.query(`SELECT iam.ensure_person('firebase', $1)`, [u]);
    await pool.query(`UPDATE iam.person_login SET removed_at = now(), removed_reason = 'account_deleted' WHERE uid = $1`, [u]);
    expect((await chamar(u, 'worker')).status).toBe(401);
  });

  it('(8) Firebase pendurado → a lista sai certa, sem a flag, dentro do orçamento da reconciliação', async () => {
    const { RECONCILE_TIMEOUT_MS } = require('@modules/identity/interfaces/meAreasRoute');
    const u = uid('pendurado');
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
       VALUES ($1, $2, 'admin', 'ACTIVE', true, '00000000-0000-0000-0000-000000000001')`,
      [u, emailOf(u)],
    );
    firebasePendurado = true;
    try {
      const inicio = Date.now();
      const r = await chamar(u, 'admin');
      const ms = Date.now() - inicio;
      expect(r.status).toBe(200);
      expect(r.body.areas).toEqual([{ area: 'backoffice', role: 'staff', entryRoute: '/admin' }]);
      expect(r.body.tokenRefreshRequired).toBe(false);
      expect(ms).toBeLessThan(RECONCILE_TIMEOUT_MS + 2_000);
    } finally {
      firebasePendurado = false;
    }
  }, 15_000);

  it('(V1) login não-staff numa árvore com login staff → sem backoffice (o login A segue com ele)', async () => {
    const a = uid('v1-staff');
    const b = uid('v1-b');
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
       VALUES ($1, $2, 'admin', 'ACTIVE', true, '00000000-0000-0000-0000-000000000001')`,
      [a, emailOf(a)],
    );
    const pid = (await pool.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [a])).rows[0].p;
    await pool.query(`INSERT INTO iam.person_login (provider, uid, person_id) VALUES ('firebase', $1, $2::uuid)`, [b, pid]);
    const rb = await chamar(b, 'worker');
    expect(rb.body.areas.map((x: any) => x.area)).not.toContain('backoffice');
    const ra = await chamar(a, 'admin');
    expect(ra.body.areas.map((x: any) => x.area)).toContain('backoffice');
  });
});
