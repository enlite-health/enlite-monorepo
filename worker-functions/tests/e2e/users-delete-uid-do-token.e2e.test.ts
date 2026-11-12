import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';

/**
 * H1 / D650 — DELETE /api/users/* pela borda (HTTP real, USE_MOCK_AUTH).
 *  (a) prestador em `/:userId` → 403 (a rota é staff-only);
 *  (b) staff em `/:userId` → ≠ 403 (passa a guarda; o resultado depende do Identity Platform, ausente no e2e);
 *  (c) `/me` com Bearer de A + `x-auth-uid` de B → o header é ignorado: B segue intacto no banco.
 * ⚠️ No e2e o Identity Platform não está configurado: o use case falha ANTES de tocar o banco, então
 * "só A é afetado" não é observável aqui — quem prova o alvo exato é o unit `UserController.test.ts`.
 * uids sintéticos, sem PII.
 */
const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';
const RUN = Date.now();
const UID_A = `h1-uid-a-${RUN}`;
const UID_B = `h1-uid-b-${RUN}`;
const UID_ALVO = `h1-uid-alvo-${RUN}`;

describe('DELETE /api/users — identidade só do token (H1)', () => {
  let api: AxiosInstance;
  let db: Pool;

  const token = async (uid: string, role: 'worker' | 'admin'): Promise<string> => {
    const r = await api.post('/api/test/auth/token', { uid, email: `${uid}@e2e.local`, role });
    return r.data.data.token;
  };
  const existe = async (uid: string): Promise<boolean> =>
    (await db.query('SELECT 1 FROM users WHERE firebase_uid = $1', [uid])).rowCount === 1;

  beforeAll(async () => {
    api = axios.create({ baseURL: API_URL, validateStatus: () => true });
    db = new Pool({ connectionString: DATABASE_URL });
    const tenant = '00000000-0000-0000-0000-000000000001'; // TENANT_E2E (helpers/permissionFamilyHarness.ts)
    for (const uid of [UID_B, UID_ALVO]) {
      await db.query(
        `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES ($1,$2,'worker','ACTIVE',true,$3)`,
        [uid, `${uid}@e2e.local`, tenant],
      );
    }
  });

  afterAll(async () => {
    await db.query('DELETE FROM users WHERE firebase_uid = ANY($1)', [[UID_B, UID_ALVO]]);
    await db.end();
  });

  it('(a) prestador em DELETE /api/users/:userId → 403 e o alvo segue existindo', async () => {
    const t = await token(UID_A, 'worker');
    const r = await api.delete(`/api/users/${UID_ALVO}`, { headers: { Authorization: `Bearer ${t}` } });
    expect(r.status).toBe(403);
    expect(await existe(UID_ALVO)).toBe(true);
  });

  it('(b) staff em DELETE /api/users/:userId → passa a guarda (≠ 403)', async () => {
    const t = await token(`h1-staff-${RUN}`, 'admin');
    const r = await api.delete(`/api/users/uid-inexistente-${RUN}`, { headers: { Authorization: `Bearer ${t}` } });
    expect(r.status).not.toBe(403);
    expect(r.status).not.toBe(401);
  });

  it('(c) DELETE /me com Bearer de A + x-auth-uid de B → o header é ignorado, B intacto', async () => {
    const t = await token(UID_A, 'worker');
    const r = await api.delete('/api/users/me', { headers: { Authorization: `Bearer ${t}`, 'x-auth-uid': UID_B } });
    expect(r.status).not.toBe(401);
    expect(r.status).not.toBe(403);
    expect(await existe(UID_B)).toBe(true);
  });
});
