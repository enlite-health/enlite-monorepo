/**
 * account-type — a fronteira staff × prestador com TOKEN REAL (D294).
 *
 * Sem mock em nenhuma camada: conta criada no Firebase Auth (emulador), claim gravado
 * pela API administrativa (o que `mergeCustomClaims` faz em produção), ID token de um
 * login real, API rodando com `USE_MOCK_AUTH=false`, Postgres real com a migration 414.
 *
 * O que fica GARANTIDO aqui:
 *   1. um prestador (`account_type=worker`) NUNCA obtém 2xx em NENHUMA rota do perímetro
 *      do painel — a lista vem do inventário VIVO da API (`/.well-known/permissions/routes`),
 *      não de uma lista à mão; rota nova entra na varredura sozinha;
 *   2. o tipo declarado vence o papel: `role=admin` + `account_type=worker` é prestador;
 *   3. sem claim nenhum e sem linha em `users` não é staff (lex C5);
 *   4. controles positivos — o instrumento mede: staff só com `account_type` entra; staff
 *      legado só com `role` entra (ponte, até o backfill do claim).
 *
 * Roda com `npm run test:e2e:real-auth` contra o stack `docker-compose.real-auth-ports.yml`.
 */
import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';
import { API_REAL_URL, claimsOf, exigirStackReal, realAccount, type RealAccount } from './helpers/realAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5440/enlite_e2e';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';
const TENANT = '00000000-0000-0000-0000-000000000001';
const DOMINIO = 'real-auth.e2e.local';

interface RotaGovernada {
  method: string;
  path: string;
  cell: string | null;
  status: 'declared' | 'exempt' | 'pending';
}

/** Substitui os parâmetros de rota por um id plausível — a decisão de auth vem ANTES de existir alvo. */
function concretizar(path: string): string {
  return path.replace(/:[A-Za-z_]+/g, '11111111-1111-1111-1111-111111111111');
}

/**
 * As 4 rotas isentas do perímetro têm contrato próprio para um prestador — nenhuma
 * devolve dado de staff. O que se afirma aqui é o status EXATO de cada uma, para
 * uma isenção nova nunca passar despercebida (a varredura falha se aparecer uma 5ª).
 */
const ISENTAS_ESPERADO: Record<string, number> = {
  'POST /api/admin/setup': 403, // bootstrap desligado por env
  'GET /v1/me/authz': 403, // contrato é de staff — prestador não tem
  'GET /api/admin/auth/profile': 404, // e-mail fora de @enlite.health → não provisiona
  'POST /api/admin/auth/telemetry': 400, // rejeita o corpo antes de gravar qualquer coisa
};

describe('prestador com token REAL nunca entra no painel (account_type, D294)', () => {
  let api: AxiosInstance;
  let pool: Pool;
  let rotas: RotaGovernada[];
  let worker: RealAccount;
  let forjado: RealAccount;
  let semClaims: RealAccount;
  let staffSoTipo: RealAccount;
  let staffLegado: RealAccount;

  const limpar = () => pool.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${DOMINIO}`]);

  beforeAll(async () => {
    await exigirStackReal();
    api = axios.create({ baseURL: API_REAL_URL, validateStatus: () => true, timeout: 15000 });
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    const inv = await api.get('/.well-known/permissions/routes', { headers: { 'X-Internal-Secret': INTERNAL_SECRET } });
    expect(inv.status).toBe(200);
    rotas = inv.data.governedRoutes as RotaGovernada[];
    expect(rotas.length).toBeGreaterThan(150); // contagem zero seria "não olhei"

    // Prestador: claim de worker, SEM linha em users (é assim que o prestador existe hoje).
    worker = await realAccount(`worker@${DOMINIO}`, { role: 'worker', account_type: 'worker' });
    // Claim forjado: papel de admin, mas tipo de prestador — o tipo vence.
    forjado = await realAccount(`forjado@${DOMINIO}`, { role: 'admin', account_type: 'worker' });
    // Conta sem claim nenhum e sem linha em users.
    semClaims = await realAccount(`semclaims@${DOMINIO}`, {});
    // Staff só com o claim novo (pós-backfill) e linha em users.
    staffSoTipo = await realAccount(`staff-tipo@${DOMINIO}`, { account_type: 'staff', country: 'AR' });
    // Staff legado: só `role` (conta anterior ao backfill) e linha em users.
    staffLegado = await realAccount(`staff-legado@${DOMINIO}`, { role: 'recruiter', country: 'AR' });
    for (const s of [staffSoTipo, staffLegado]) {
      await pool.query(
        `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
         VALUES ($1, $2, 'Real Auth E2E', 'recruiter', 'ACTIVE', true, $3)
         ON CONFLICT (firebase_uid) DO NOTHING`,
        [s.uid, s.email, TENANT],
      );
    }
  }, 60000);

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('o token do prestador carrega o claim de verdade (não é mock): account_type=worker, emitido pelo emulador', () => {
    const claims = claimsOf(worker.token);
    expect(claims.account_type).toBe('worker');
    expect(String(claims.iss)).toContain('securetoken');
    expect(worker.token.startsWith('mock_')).toBe(false);
  });

  it('VARREDURA: em NENHUMA das rotas governadas o prestador obtém 2xx (401/403 em todas as declaradas)', async () => {
    const declaradas = rotas.filter((r) => r.status !== 'exempt');
    const furos: string[] = [];
    const inesperados: string[] = [];
    for (const rota of declaradas) {
      const res = await api.request({
        method: rota.method,
        url: concretizar(rota.path),
        headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' },
        data: {},
      });
      if (res.status >= 200 && res.status < 300) furos.push(`${rota.method} ${rota.path} → ${res.status}`);
      else if (res.status !== 401 && res.status !== 403) inesperados.push(`${rota.method} ${rota.path} → ${res.status}`);
    }
    // A mensagem vai no próprio valor: jest não aceita 2º argumento em expect().
    expect({ rotasQueEntregaramAoPrestador: furos }).toEqual({ rotasQueEntregaramAoPrestador: [] });
    // Só 401/403: qualquer outro status significa que o handler rodou (404 de alvo, 400 de corpo…)
    // e a fronteira NÃO foi a primeira a responder.
    expect({ fronteiraNaoRespondeuPrimeiro: inesperados }).toEqual({ fronteiraNaoRespondeuPrimeiro: [] });
    expect(declaradas.length).toBeGreaterThan(150);
  });

  it('as rotas ISENTAS são exatamente 4 e cada uma responde ao prestador o que o contrato diz', async () => {
    const isentas = rotas.filter((r) => r.status === 'exempt');
    expect(isentas.map((r) => `${r.method} ${r.path}`).sort()).toEqual(Object.keys(ISENTAS_ESPERADO).sort());
    for (const rota of isentas) {
      const res = await api.request({
        method: rota.method,
        url: rota.path,
        headers: { Authorization: `Bearer ${worker.token}`, 'Content-Type': 'application/json' },
        data: {},
      });
      expect(`${rota.method} ${rota.path} → ${res.status}`).toBe(`${rota.method} ${rota.path} → ${ISENTAS_ESPERADO[`${rota.method} ${rota.path}`]}`);
    }
  });

  it('claim FORJADO (role=admin + account_type=worker): o tipo vence — 403 Staff access required', async () => {
    const res = await api.get('/api/admin/users', { headers: { Authorization: `Bearer ${forjado.token}` } });
    expect(res.status).toBe(403);
    expect(res.data).toMatchObject({ error: 'Staff access required' });
  });

  it('sem claim nenhum e sem linha em users → 403 (lex C5: nunca staff por ausência)', async () => {
    const res = await api.get('/api/admin/users', { headers: { Authorization: `Bearer ${semClaims.token}` } });
    expect(res.status).toBe(403);
  });

  it('CONTROLE POSITIVO 1: staff só com account_type=staff (sem role) entra — o claim novo basta', async () => {
    const res = await api.get('/api/admin/users', { headers: { Authorization: `Bearer ${staffSoTipo.token}` } });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('CONTROLE POSITIVO 2: staff legado só com role=recruiter entra (ponte até o backfill do claim)', async () => {
    const res = await api.get('/api/admin/users', { headers: { Authorization: `Bearer ${staffLegado.token}` } });
    expect(res.status).toBe(200);
  });

  it('sem token nenhum → 401 (a fronteira de identidade vem antes da de tipo)', async () => {
    expect((await api.get('/api/admin/users')).status).toBe(401);
  });
});
