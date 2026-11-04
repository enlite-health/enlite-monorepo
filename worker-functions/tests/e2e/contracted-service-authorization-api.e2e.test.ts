/**
 * contracted-service-authorization-api.e2e.test.ts @integration — spec 056, T2.3 (execução = CI)
 *
 * Prova, contra a API REAL e o Postgres real, as 3 rotas da autorização de horas do serviço (P§5.2): criar (201),
 * sobreposição (409 AUTHORIZATION_OVERLAPS), sem fim (422 AUTHORIZATION_NEEDS_END), supersede (201 e a antiga com
 * `supersededAt`) e listagem. Envelope `{ success, data }`. Os `it` são sequenciais e compartilham o serviço semeado.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `csaapi-e2e-${RUN}-`;

describe('autorização de horas do serviço pela API — spec 056 T2.3 @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let patientId = '';
  let serviceId = '';
  let firstId = '';
  const base = () => `/api/admin/patients/${patientId}/contracted-services/${serviceId}/authorizations`;
  const BODY = { hours: 120, validFrom: '2026-01-01', validTo: '2026-12-31' };

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`csaapi-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Horas', 'AutorizacaoApi', 'AR', 'ACTIVE') RETURNING id`,
        [`${PREFIX}p1`],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patientId],
      )
    ).rows[0].id;
    serviceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patientId, addressId, PREFIX],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await pool.query(`DELETE FROM contracted_service_authorization WHERE contracted_service_id = $1`, [serviceId]);
      await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
      const left = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM patients WHERE clickup_task_id LIKE $1`,
        [`${PREFIX}%`],
      );
      expect(left.rows[0].n).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('POST → 201 com a vigência inclusiva devolvida', async () => {
    const r = await api.post(base(), BODY, asAdmin);
    expect(r.status).toBe(201);
    expect(r.data.success).toBe(true);
    expect(r.data.data).toMatchObject({ hours: 120, validFrom: '2026-01-01', validTo: '2026-12-31', supersededAt: null });
    firstId = r.data.data.id as string;
  });

  it('POST sobreposto → 409 AUTHORIZATION_OVERLAPS', async () => {
    const r = await api.post(base(), { hours: 60, validFrom: '2026-06-01', validTo: '2026-08-31' }, asAdmin);
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('AUTHORIZATION_OVERLAPS');
  });

  it('POST validTo null → 422 AUTHORIZATION_NEEDS_END', async () => {
    const r = await api.post(base(), { hours: 60, validFrom: '2027-01-01', validTo: null }, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('AUTHORIZATION_NEEDS_END');
  });

  it('supersede → 201 (linha nova) e a antiga com supersededAt', async () => {
    const r = await api.post(`${base()}/${firstId}/supersede`, { ...BODY, hours: 130 }, asAdmin);
    expect(r.status).toBe(201);
    expect(r.data.data.hours).toBe(130);
    expect(r.data.data.id).not.toBe(firstId);
    const list = await api.get(base(), asAdmin);
    const old = (list.data.data.authorizations as Array<{ id: string; supersededAt: string | null }>).find((a) => a.id === firstId);
    expect(old?.supersededAt).not.toBeNull();
  });

  it('GET lista 2 linhas (a corrente e a substituída)', async () => {
    const r = await api.get(base(), asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.data.authorizations).toHaveLength(2);
  });
});
