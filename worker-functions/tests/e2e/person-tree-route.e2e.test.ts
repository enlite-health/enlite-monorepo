/**
 * person-tree-route.e2e.test.ts — `GET /v1/persons/:pid/tree` por HTTP REAL, banco REAL (acesso-do-cliente F1, T138).
 *
 * Mesmo molde de `me-areas-route.e2e.test.ts` (cadeia real em porta efêmera; migrations 580/581). Fixtures sintéticas, sem PII.
 * `iam.*` é append-only: pessoas criadas por SQL direto como dono, com sufixo aleatório; o teste não apaga.
 * Substituição única: a verificação do OIDC do Google (`OAuth2Client.verifyIdToken`) — sem rede no e2e; ela só aceita
 * o token `oidc-de-servico-valido` e devolve a SA de `E2E_TREE_SA_EMAIL` (a allowlist é lida da env a cada request). O guard, a rota, o controller e o banco são os reais.
 */
import { randomBytes } from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { Pool } from 'pg';
import { tokenMock, montarAppDeFamilia, type AppDeFamilia } from './helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const OIDC_OK = 'oidc-de-servico-valido';
const SA_OK = 'learn-service-sa@e2e.iam.gserviceaccount.com';
const SA_OUTRA = 'outra-sa@e2e.iam.gserviceaccount.com';

describe('GET /v1/persons/:pid/tree — HTTP real, banco real (acesso-do-cliente F1, T138)', () => {
  let pool: Pool;
  let app: AppDeFamilia;
  const envAnterior: Record<string, string | undefined> = {};

  const chamar = async (pid: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${app.url}/v1/persons/${pid}/tree`, { headers });
    const texto = await res.text();
    return { status: res.status, body: texto ? JSON.parse(texto) : null };
  };
  const oidc = { Authorization: `Bearer ${OIDC_OK}` };
  /** Pessoa nasce não absorvida (trigger); a absorção é um UPDATE posterior do dono, que o guard permite. */
  const pessoa = async (mergedInto?: string): Promise<string> => {
    const id: string = (await pool.query(`INSERT INTO iam.person DEFAULT VALUES RETURNING id`)).rows[0].id;
    if (mergedInto) await pool.query(`UPDATE iam.person SET merged_into_id = $1, merged_at = now() WHERE id = $2`, [mergedInto, id]);
    return id;
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      USE_MOCK_AUTH: 'true',
      DATABASE_URL,
      INTERNAL_TOKEN_SECRET: 'test-secret-for-e2e-only',
      CLOUD_RUN_SERVICE_URL: 'https://wf.e2e.local',
      PERSON_TREE_ALLOWED_SAS: ` ${SA_OK} , outra-na-lista@e2e.iam.gserviceaccount.com`,
      E2E_TREE_SA_EMAIL: SA_OK,
    })) {
      envAnterior[k] = process.env[k];
      process.env[k] = v;
    }
    pool = new Pool({ connectionString: DATABASE_URL });
    jest.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation((async (opts: { idToken: string }) => {
      if (opts.idToken !== OIDC_OK) throw new Error('Invalid token');
      return { getPayload: () => ({ email: process.env.E2E_TREE_SA_EMAIL, email_verified: true }) };
    }) as never);
    app = await montarAppDeFamilia({
      montarRotas: ({ app: expressApp }) => {
        const { requirePersonTreeService } = require('@modules/identity/interfaces/middleware/requirePersonTreeService');
        const { createPersonTreeRouter } = require('@modules/identity/interfaces/personTreeRoute');
        const { DatabaseConnection } = require('@shared/database/DatabaseConnection');
        expressApp.use('/v1', createPersonTreeRouter(requirePersonTreeService, DatabaseConnection.getInstance().getPool()));
      },
    });
  }, 30000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });

  it('cadeia A→B→C (C absorvida por B, B por A): a raiz devolve os 3 pids', async () => {
    const a = await pessoa();
    const b = await pessoa(a);
    const c = await pessoa(b);
    const r = await chamar(a, oidc);
    expect(r.status).toBe(200);
    expect(r.body).toEqual([a, b, c].sort());
  });

  it('pid de uma absorvida devolve a árvore inteira da raiz', async () => {
    const a = await pessoa();
    const b = await pessoa(a);
    const c = await pessoa(b);
    expect((await chamar(c, oidc)).body).toEqual([a, b, c].sort());
  });

  it('pessoa sem merge devolve só ela mesma', async () => {
    const solo = await pessoa();
    expect((await chamar(solo, oidc)).body).toEqual([solo]);
  });

  it('X-Internal-Secret (Cloud Tasks) também passa pelo guard interno', async () => {
    const solo = await pessoa();
    const r = await chamar(solo, { 'X-Internal-Secret': 'test-secret-for-e2e-only' });
    expect(r.status).toBe(200);
  });

  it('OIDC válido com SA FORA da allowlist → 403', async () => {
    const solo = await pessoa();
    process.env.E2E_TREE_SA_EMAIL = SA_OUTRA;
    try {
      expect((await chamar(solo, oidc)).status).toBe(403);
    } finally {
      process.env.E2E_TREE_SA_EMAIL = SA_OK;
    }
  });

  it('allowlist VAZIA → OIDC válido dá 403 (fail-closed), mas o X-Internal-Secret segue passando', async () => {
    const solo = await pessoa();
    const anterior = process.env.PERSON_TREE_ALLOWED_SAS;
    process.env.PERSON_TREE_ALLOWED_SAS = '';
    try {
      expect((await chamar(solo, oidc)).status).toBe(403);
      expect((await chamar(solo, { 'X-Internal-Secret': 'test-secret-for-e2e-only' })).status).toBe(200);
    } finally {
      process.env.PERSON_TREE_ALLOWED_SAS = anterior;
    }
  });

  it('pid desconhecido → 404', async () => {
    expect((await chamar('00000000-0000-4000-8000-0000000000ff', oidc)).status).toBe(404);
  });

  it('pid que não é uuid → 400', async () => {
    expect((await chamar('nao-e-uuid', oidc)).status).toBe(400);
  });

  it('sem credencial → 403 (guard), mesmo com pid existente', async () => {
    const solo = await pessoa();
    expect([401, 403]).toContain((await chamar(solo)).status);
  });

  it('OIDC inválido → 403', async () => {
    const solo = await pessoa();
    expect([401, 403]).toContain((await chamar(solo, { Authorization: 'Bearer oidc-forjado' })).status);
  });

  it('token de usuário final (Firebase/mock) → 401/403', async () => {
    const solo = await pessoa();
    expect([401, 403]).toContain((await chamar(solo, { Authorization: tokenMock('e2e-tree-usuario', 'worker') })).status);
  });
});
