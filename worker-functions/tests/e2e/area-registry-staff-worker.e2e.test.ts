/**
 * area-registry-staff-worker.e2e.test.ts — o auto-provisionamento de staff NÃO apaga o prestador
 * (acesso-do-cliente, F1, T115 · fase-1.md item 6 · fatos-medidos F7).
 *
 * Cenário: um uid que já é prestador (ficha em `workers.auth_uid`) entra com e-mail `@enlite.health`, que dispara o
 * auto-provisionamento de `GetAdminProfileUseCase` (grava `users` + claim `account_type=staff`). Depois disso,
 * `GET /v1/me/areas` desse MESMO login traz `backoffice`·staff E `care`·worker: `care` vem de `workers.auth_uid` na
 * árvore da pessoa, nunca do claim `account_type`.
 *
 * Pela borda: HTTP real em processo (cadeia real do harness; as duas rotas são as de `src/index.ts`), banco real.
 * Única substituição: o Firebase Admin (dublê em memória de getUser/setCustomUserClaims/revokeRefreshTokens).
 * Sem PII: o e-mail do domínio exigido pelo código usa local-part sintético `qa-t115-<rand>`.
 */
import { randomBytes } from 'crypto';
import * as firebaseAdmin from 'firebase-admin';
import { Pool } from 'pg';
import { montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const UID = `e2e-t115-${RUN}-prestador`;
const EMAIL = `qa-t115-${RUN}@enlite.health`;

type Claims = Record<string, unknown>;

/** Token mock com o que o login carregaria: papel/tipo vêm do claim gravado no dublê (o "token refrescado"). */
function token(claims: Claims, role: string): string {
  const dados = Buffer.from(
    JSON.stringify({
      uid: UID,
      email: EMAIL,
      role: (claims.role as string | undefined) ?? role,
      ...(claims.account_type ? { account_type: claims.account_type } : {}),
    }),
  ).toString('base64');
  return `Bearer mock_${dados}`;
}

describe('auto-provisionamento de staff não apaga o prestador (F7) — HTTP real, banco real', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const claims = new Map<string, Claims>();
  const envAnterior: Record<string, string | undefined> = {};

  const get = async (caminho: string, auth: string) => {
    const res = await fetch(`${app.url}${caminho}`, { headers: { Authorization: auth } });
    const texto = await res.text();
    return { status: res.status, body: texto ? JSON.parse(texto) : {} };
  };
  const n = async (sql: string) => Number((await pool.query(sql, [UID])).rows[0].n);

  beforeAll(async () => {
    for (const [k, v] of Object.entries({ USE_MOCK_AUTH: 'true', DATABASE_URL })) {
      envAnterior[k] = process.env[k];
      process.env[k] = v;
    }
    pool = new Pool({ connectionString: DATABASE_URL });
    jest.spyOn(firebaseAdmin, 'auth').mockImplementation((() => ({
      getUser: async (u: string) => ({
        uid: u,
        email: EMAIL,
        displayName: 'QA T115',
        photoURL: null,
        providerData: [],
        customClaims: claims.get(u) ?? {},
      }),
      setCustomUserClaims: async (u: string, c: Claims) => void claims.set(u, c),
      revokeRefreshTokens: async () => undefined,
    })) as never);
    app = await montarAppDeFamilia({
      montarRotas: ({ app: expressApp, auth }) => {
        const { createMeAreasRouter } = require('@modules/identity/interfaces/meAreasRoute');
        const { AdminController } = require('@modules/identity');
        const { DatabaseConnection } = require('@shared/database/DatabaseConnection');
        const adminController = new AdminController();
        // Mesmas duas rotas, mesma ordem de middleware, de `src/index.ts`.
        expressApp.get('/api/admin/auth/profile', auth.requireAuth(), (req: any, res: any) => {
          adminController.getProfile(req, res);
        });
        expressApp.use('/v1', createMeAreasRouter(auth.requireAuth(), DatabaseConnection.getInstance().getPool()));
      },
    });
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [UID]);
    await pool.query(`DELETE FROM workers WHERE auth_uid = $1`, [UID]);
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('prestador faz o auto-provisionamento de staff → /v1/me/areas traz backoffice·staff E care·worker; a ficha segue', async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
      [UID, EMAIL, `+5491102${RUN.slice(0, 4)}`],
    );
    // Antes: só prestador (sem linha em users).
    expect(await n(`SELECT count(*) AS n FROM users WHERE firebase_uid = $1`)).toBe(0);
    const antes = await get('/v1/me/areas', token({}, 'worker'));
    expect(antes.status).toBe(200);
    expect(antes.body.areas).toEqual([{ area: 'care', role: 'worker', entryRoute: '/' }]);

    // O auto-provisionamento (primeiro login de staff @enlite.health).
    const perfil = await get('/api/admin/auth/profile', token({}, 'worker'));
    expect(perfil.status).toBe(200);
    expect(perfil.body.success).toBe(true);
    expect(await n(`SELECT count(*) AS n FROM users WHERE firebase_uid = $1`)).toBe(1);
    const gravado = claims.get(UID)!;
    expect(gravado.account_type).toBe('staff');

    // Depois (token já com o claim novo): as duas áreas, backoffice primeiro (ordem de AREA_ORDER).
    const depois = await get('/v1/me/areas', token(gravado, 'worker'));
    expect(depois.status).toBe(200);
    const pares = depois.body.areas.map((a: any) => `${a.area}:${a.role}`).sort();
    expect(pares).toEqual(['backoffice:staff', 'care:worker']);

    // O prestador não foi apagado: a ficha continua e `care` não depende do claim.
    expect(await n(`SELECT count(*) AS n FROM workers WHERE auth_uid = $1`)).toBe(1);
  });
});
