/**
 * patient-native-case-number.e2e.test.ts — spec 027 (T016), Postgres REAL, API REAL.
 *
 * `POST /api/admin/patients` cria o paciente NATIVO (origin='admin_manual',
 * migration 251) sem que o chamador informe `case_number` — o schema do body
 * (`createPatientSchema`) nem expõe esse campo. T012 preenche o número ANTES
 * do insert via `patients_case_number_seq` (migration 459). Este teste prova
 * isso de ponta a ponta: HTTP real → Express real → transação real → o valor
 * que fica gravado no Postgres, sem mockar nada.
 *
 * PII: os pacientes seedados aqui usam nome/telefone SINTÉTICOS de teste — a
 * leitura de volta usa só `id` e `case_number` (nunca nome/telefone em log).
 */
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('POST /api/admin/patients — case_number nativo (spec 027, T016)', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  const createdIds: string[] = [];

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  function makeBody(overrides: Record<string, unknown> = {}) {
    return {
      firstName: 'E2E-T016',
      country: 'AR',
      phoneWhatsapp: `+549110000${Math.floor(Math.random() * 9000 + 1000)}`,
      ...overrides,
    };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'patients-case-number-e2e',
      email: 'patients-case-number@e2e.local',
      role: 'admin',
    });
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [createdIds]);
    }
    await pool.query('DELETE FROM users WHERE firebase_uid = $1', ['patients-case-number-e2e']);
    await pool.end();
  });

  it('1. cria paciente nativo SEM case_number no body → Postgres grava um case_number ≥1000 (migration 459)', async () => {
    const res = await api.post('/api/admin/patients', makeBody(), authHeaders(adminToken));

    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
    const id = res.data.data.id as string;
    createdIds.push(id);

    const { rows } = await pool.query<{ case_number: number | null; origin: string }>(
      'SELECT case_number, origin FROM patients WHERE id = $1',
      [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].origin).toBe('admin_manual');
    expect(rows[0].case_number).not.toBeNull();
    expect(rows[0].case_number).toBeGreaterThanOrEqual(1000);
  });

  it('2. dois pacientes nativos seguidos → case_number consecutivos (mesma SEQUENCE, banco real)', async () => {
    const res1 = await api.post('/api/admin/patients', makeBody(), authHeaders(adminToken));
    expect(res1.status).toBe(201);
    createdIds.push(res1.data.data.id);

    const res2 = await api.post('/api/admin/patients', makeBody(), authHeaders(adminToken));
    expect(res2.status).toBe(201);
    createdIds.push(res2.data.data.id);

    const { rows } = await pool.query<{ id: string; case_number: number }>(
      'SELECT id, case_number FROM patients WHERE id = ANY($1::uuid[]) ORDER BY created_at ASC',
      [[res1.data.data.id, res2.data.data.id]],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].case_number).not.toBeNull();
    expect(rows[1].case_number).toBe(rows[0].case_number + 1);
  });
});
