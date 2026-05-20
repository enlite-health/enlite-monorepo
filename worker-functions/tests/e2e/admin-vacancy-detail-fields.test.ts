/**
 * admin-vacancy-detail-fields.test.ts
 *
 * Valida que GET /api/admin/vacancies/:id devolve os aliases que os cards
 * VacancyCaseCard / VacancyProfessionCard consomem:
 *   - dependency_level (de patients.dependency_level)
 *   - closed_at        (de job_postings.closes_at)
 *   - service_type     (array bruto de patients.service_type — TEXT[])
 *   - patient_city     (coalesce de patient_addresses.city / patients.city_locality)
 *   - patient_neighborhood (coalesce de pa.neighborhood / p.zone_neighborhood)
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('GET /api/admin/vacancies/:id — aliases expostos para o detalhe', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let patientAddressId: string;
  let vacancyId: string;

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: 'detail-fields-admin',
      email: 'detail-fields-admin@e2e.local',
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });

    const clickupTaskId = `e2e-detail-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const patient = await pool.query(
      `INSERT INTO patients
         (clickup_task_id, first_name, last_name, country, status,
          dependency_level, service_type, city_locality, zone_neighborhood, diagnosis)
       VALUES ($1, 'E2E', 'Detail', 'AR', 'ACTIVE',
               'SEVERE', ARRAY['AT', 'CAREGIVER'], 'CABA-fallback', 'Palermo-fallback', 'TEA F84.0')
       RETURNING id`,
      [clickupTaskId],
    );
    patientId = patient.rows[0].id as string;

    const addr = await pool.query(
      `INSERT INTO patient_addresses
         (patient_id, address_type, city, neighborhood, address_formatted)
       VALUES ($1, 'primary', 'CABA-addr', 'Palermo-addr', 'Av Santa Fe 1234, CABA')
       RETURNING id`,
      [patientId],
    );
    patientAddressId = addr.rows[0].id as string;

    const vacancy = await pool.query(
      `INSERT INTO job_postings
         (title, country, status, patient_id, patient_address_id, case_number, closes_at)
       VALUES ('Caso detail E2E', 'AR', 'SEARCHING', $1, $2, 99982, '2026-08-15 23:59:00+00')
       RETURNING id`,
      [patientId, patientAddressId],
    );
    vacancyId = vacancy.rows[0].id as string;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
      await pool.query(`DELETE FROM patient_addresses WHERE id = $1`, [patientAddressId]);
      await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
      await pool.end();
    }
  });

  it('devolve dependency_level, closed_at, service_type, patient_city e patient_neighborhood', async () => {
    const res = await api.get(
      `/api/admin/vacancies/${vacancyId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    const data = res.data.data;

    expect(data.dependency_level).toBe('SEVERE');
    expect(data.closed_at).toMatch(/^2026-08-15/);
    expect(data.service_type).toEqual(['AT', 'CAREGIVER']);
    expect(data.patient_city).toBe('CABA-addr');
    expect(data.patient_neighborhood).toBe('Palermo-addr');
  });

  it('cai no campo do paciente quando patient_addresses não tem city/neighborhood', async () => {
    await pool.query(
      `UPDATE patient_addresses SET city = NULL, neighborhood = NULL WHERE id = $1`,
      [patientAddressId],
    );
    const res = await api.get(
      `/api/admin/vacancies/${vacancyId}`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.data.data.patient_city).toBe('CABA-fallback');
    expect(res.data.data.patient_neighborhood).toBe('Palermo-fallback');
  });
});
