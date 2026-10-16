/**
 * tactiq-link-email — o e-mail do staff chega a `req.user` com TOKEN REAL (spec 049).
 *
 * Defeito medido em produção: `GET /api/admin/me/tactiq-link` = 400 NO_EMAIL em 6 de 6
 * chamadas — o caminho de autenticação REAL montava `req.user` sem `email` (só o mock o
 * preenchia, por isso o e2e com mock passava). Sem mock em nenhuma camada: conta no
 * Firebase Auth (emulador), claim gravado pela API administrativa, ID token de login real,
 * API com `USE_MOCK_AUTH=false`, Postgres real. Fixtures sintéticas (@example.test).
 *
 * Roda com `npm run test:e2e:real-auth` contra o stack `docker-compose.real-auth-ports.yml`.
 */
import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';
import { API_REAL_URL, claimsOf, exigirStackReal, realAccount, type RealAccount } from './helpers/realAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5440/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const EMAIL = 'tactiq-real-auth@example.test';

describe('GET /api/admin/me/tactiq-link com token REAL de staff (spec 049)', () => {
  let api: AxiosInstance;
  let pool: Pool;
  let staff: RealAccount;

  const limpar = () => pool.query(`DELETE FROM users WHERE email = $1`, [EMAIL]);

  beforeAll(async () => {
    await exigirStackReal();
    api = axios.create({ baseURL: API_REAL_URL, validateStatus: () => true, timeout: 15000 });
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    // Admin: a rota declara `untilEnforced: 'admin'` e o stack real roda com o engine desligado.
    staff = await realAccount(EMAIL, { role: 'admin', account_type: 'staff', country: 'AR' });
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
       VALUES ($1, $2, 'Tactiq Real Auth E2E', 'admin', 'ACTIVE', true, $3)
       ON CONFLICT (firebase_uid) DO NOTHING`,
      [staff.uid, EMAIL, TENANT],
    );
  }, 60000);

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('o token carrega o e-mail de verdade (não é mock): emitido pelo emulador, claim email presente', () => {
    const claims = claimsOf(staff.token);
    expect(claims.email).toBe(EMAIL);
    expect(String(claims.iss)).toContain('securetoken');
    expect(staff.token.startsWith('mock_')).toBe(false);
  });

  it('staff com token real → 200 com o estado do vínculo (`missing`), e NÃO 400 NO_EMAIL', async () => {
    const res = await api.get('/api/admin/me/tactiq-link', { headers: { Authorization: `Bearer ${staff.token}` } });
    expect({ status: res.status, code: res.data?.code }).toEqual({ status: 200, code: undefined });
    expect(res.data).toMatchObject({ success: true, data: { status: 'missing' } });
  });
});
