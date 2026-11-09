/**
 * acesso-do-cliente F3 (T319) — o prestador CONTINUA dentro: nas 21 rotas de prestador da F0 (b), a conta só-prestador e a
 * conta staff+prestador não levam 401/403 [AJUSTE A5: "≠ 401/403", não "200": 400/404/204/409 são respostas legítimas do
 * handler com corpo de teste]. App REAL de pé (Cedar do cliente + guards reais + `StaffOrClientEngine`), banco real.
 *
 * Lista de 21 = `fatos-medidos.md` F3 (index.ts 7 + accountLinkRoutes 4 + workerDocumentsRoutes 9 + workerApplicationsRoutes 1),
 * conferida CONTRA o inventário em runtime: as 21 existem com classe `client-policy` e as `client-policy` restantes são
 * exatamente as 5 que não são de prestador (REST_CLIENT_POLICY). Conta NOVA por chamada (sintética, sem PII). Corpo `{}`
 * (só `finalize` leva token assinado do próprio survivor, senão o 401 do handler `INVALID_LINK_TOKEN` seria falso positivo).
 * Controle: conta SEM ficha (só-aluno) → 403 em GET /api/workers/me, provando que estas rotas sabem negar neste mesmo stack.
 */
import { randomBytes, randomUUID } from 'crypto';
import axios from 'axios';
import { Pool } from 'pg';
import { signLinkToken } from '../../src/modules/account-link/linkToken';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = randomBytes(4).toString('hex');
const SYNTHETIC_ID = '00000000-0000-4000-8000-000000000319';

const ROTAS_PRESTADOR: Array<[string, string]> = [
  ['PUT', '/api/workers/step'],
  ['GET', '/api/workers/me'],
  ['PUT', '/api/workers/me/general-info'],
  ['PUT', '/api/workers/me/service-area'],
  ['GET', '/api/workers/me/availability'],
  ['PUT', '/api/workers/me/availability'],
  ['DELETE', '/api/users/me'],
  ['POST', '/api/workers/me/account-link/lookup'],
  ['POST', '/api/workers/me/account-link/start'],
  ['POST', '/api/workers/me/account-link/confirm'],
  ['POST', '/api/workers/me/account-link/finalize'],
  ['GET', '/api/workers/me/documents'],
  ['POST', '/api/workers/me/documents/upload-url'],
  ['POST', '/api/workers/me/documents/save'],
  ['POST', '/api/workers/me/documents/view-url'],
  ['DELETE', '/api/workers/me/documents/:type'],
  ['GET', '/api/workers/me/additional-documents'],
  ['POST', '/api/workers/me/additional-documents/upload-url'],
  ['POST', '/api/workers/me/additional-documents'],
  ['DELETE', '/api/workers/me/additional-documents/:docId'],
  ['POST', '/api/worker-applications/track-channel'],
];
/** `client-policy` do inventário que NÃO são as 21 de prestador (onboarding/identidade, sem ficha prévia). */
const OUTRAS_CLIENT_POLICY = [
  'POST /api/workers/init', 'POST /api/auth/claim/start', 'POST /api/auth/claim/confirm', 'GET /v1/me/areas', 'GET /api/admin/auth/profile',
];

const bearer = (uid: string, role: string) =>
  `Bearer mock_${Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role, country: 'AR' })).toString('base64')}`;

describe('F3 — prestador continua dentro das 21 rotas (T319)', () => {
  let pool: Pool;
  let seq = 0;
  const linhas: string[] = [];

  async function conta(tipo: 'so-prestador' | 'staff+prestador' | 'so-aluno') {
    seq += 1;
    const uid = `e2e-worker-open-${RUN}-${seq}`;
    let workerId: string | null = null;
    if (tipo !== 'so-aluno') {
      const r = await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW()) RETURNING id`,
        [uid, `${uid}@e2e.local`, `+54911${String(seq).padStart(4, '0')}${RUN.slice(0, 4).replace(/[a-f]/g, '7')}`],
      );
      workerId = r.rows[0].id;
    }
    if (tipo === 'staff+prestador') {
      await pool.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id)
         VALUES ($1, $2, 'admin', 'ACTIVE', true, '00000000-0000-0000-0000-000000000001')`,
        [uid, `${uid}@e2e.local`],
      );
    }
    return { uid, workerId, role: tipo === 'staff+prestador' ? 'admin' : 'worker' };
  }

  async function chamar(tipo: 'so-prestador' | 'staff+prestador' | 'so-aluno', metodo: string, caminho: string) {
    const c = await conta(tipo);
    const temCorpo = metodo !== 'GET' && metodo !== 'DELETE';
    const corpo = caminho.endsWith('/account-link/finalize')
      ? { linkToken: signLinkToken({ purpose: 'finalize', survivorId: c.workerId as string, absorbedId: randomUUID(), exp: Date.now() + 600000 }) }
      : {};
    const res = await axios.request({
      method: metodo as 'GET',
      url: `${API_URL}${caminho.replace(/:[A-Za-z0-9_]+/g, SYNTHETIC_ID)}`,
      data: temCorpo ? corpo : undefined,
      headers: { Authorization: bearer(c.uid, c.role), ...(temCorpo ? { 'Content-Type': 'application/json' } : {}) },
      validateStatus: () => true,
      maxRedirects: 0,
      timeout: 30000,
    });
    linhas.push(`${tipo} ${metodo} ${caminho} -> ${res.status}`);
    return res;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });
  afterAll(async () => {
    await pool?.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`e2e-worker-open-${RUN}-%`]);
    await pool?.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`e2e-worker-open-${RUN}-%`]);
    await pool?.end();
  });

  it('as 21 rotas de prestador existem no inventário (runtime) como client-policy; as outras client-policy são as 5 nomeadas', async () => {
    const inv = await axios.get(`${API_URL}/.well-known/permissions/routes`, { headers: { 'X-Internal-Secret': INTERNAL_SECRET }, validateStatus: () => true });
    expect(inv.status).toBe(200);
    const cp = (inv.data.routes as Array<{ method: string; path: string; class: string }>)
      .filter((r) => r.class === 'client-policy').map((r) => `${r.method} ${r.path}`).sort();
    const vinteUm = ROTAS_PRESTADOR.map(([m, p]) => `${m} ${p}`);
    expect(ROTAS_PRESTADOR.length).toBe(21);
    const normaliza = (l: string) => l.replace(/:[A-Za-z0-9_]+/g, ':p');
    const esperado = [...vinteUm, ...OUTRAS_CLIENT_POLICY].map(normaliza).sort();
    expect(cp.map(normaliza)).toEqual(esperado);
  });

  it('controle: conta SEM ficha (só-aluno) → 403 em GET /api/workers/me (estas rotas sabem negar neste stack)', async () => {
    const res = await chamar('so-aluno', 'GET', '/api/workers/me');
    expect(res.status).toBe(403);
  });

  it('21 rotas × {só-prestador, staff+prestador} = 42 chamadas, nenhuma com 401/403', async () => {
    const negadas: string[] = [];
    let feitas = 0;
    for (const [metodo, caminho] of ROTAS_PRESTADOR) {
      for (const tipo of ['so-prestador', 'staff+prestador'] as const) {
        const res = await chamar(tipo, metodo, caminho);
        feitas += 1;
        if (res.status === 401 || res.status === 403) {
          negadas.push(`${tipo} ${metodo} ${caminho} -> ${res.status} ${JSON.stringify(res.data).slice(0, 80)}`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(`[T319] rotas=${ROTAS_PRESTADOR.length} contas=2 chamadas=${feitas} com_401_403=${negadas.length}\n${linhas.join('\n')}`);
    expect(feitas).toBe(42);
    expect(negadas).toEqual([]);
  }, 300000);
});
