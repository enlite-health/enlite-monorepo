/**
 * admin-worker-service-area-edit.e2e.test.ts
 *
 * Testa a edição administrativa do endereço/área de serviço de um worker.
 * Usa MockAuth (USE_MOCK_AUTH=true).
 *
 * Endpoint coberto:
 *   PUT /api/admin/workers/:id/service-area   (adminOnly — role === ADMIN)
 *
 * Cenários:
 *   - 200: admin salva área de serviço e a mudança aparece no GET de detalhe
 *   - 400: body inválido (sem lat/lng)
 *   - 401: sem token
 *   - 403: role recruiter (gate é admin)
 *   - 404: UUID inexistente
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('PUT /api/admin/workers/:id/service-area', () => {
  const api = createApiClient();
  let adminToken: string;
  let recruiterToken: string;
  let pool: Pool;
  let seededWorkerId: string;

  const testAuthUid = `worker-sa-edit-e2e-${Date.now()}`;
  const testEmail = `worker-sa-edit-${Date.now()}@e2e.local`;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'worker-sa-edit-admin-e2e',
      email: 'worker-sa-edit-admin@e2e.local',
      role: 'admin',
    });
    recruiterToken = await getMockToken(api, {
      uid: 'worker-sa-edit-recruiter-e2e',
      email: 'worker-sa-edit-recruiter@e2e.local',
      role: 'recruiter',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    const initRes = await api.post('/api/workers/init', {
      authUid: testAuthUid,
      email: testEmail,
      country: 'AR',
    });
    if (initRes.status !== 200 && initRes.status !== 201) {
      throw new Error(`Failed to seed worker: ${JSON.stringify(initRes.data)}`);
    }
    seededWorkerId = initRes.data.data.worker.id;
  });

  afterAll(async () => {
    if (pool && seededWorkerId) {
      await pool.query('DELETE FROM worker_service_areas WHERE worker_id = $1', [seededWorkerId]);
      await pool.query('DELETE FROM worker_documents WHERE worker_id = $1', [seededWorkerId]);
      await pool.query('DELETE FROM workers WHERE id = $1', [seededWorkerId]);
    }
    if (pool) await pool.end();
  });

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  const validBody = {
    address: 'Av. Corrientes 1234, CABA, Argentina',
    serviceRadiusKm: 10,
    lat: -34.6037,
    lng: -58.3816,
    city: 'Buenos Aires',
    postalCode: 'C1043',
    neighborhood: 'San Nicolás',
  };

  describe('admin salva área de serviço', () => {
    it('retorna 200', async () => {
      const res = await api.put(
        `/api/admin/workers/${seededWorkerId}/service-area`,
        validBody,
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('a área de serviço aparece no GET de detalhe', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.data.serviceAreas)).toBe(true);
      expect(res.data.data.serviceAreas.length).toBeGreaterThan(0);
      expect(res.data.data.serviceAreas[0].address).toContain('Corrientes');
    });
  });

  describe('body inválido', () => {
    it('retorna 400 quando faltam lat/lng', async () => {
      const res = await api.put(
        `/api/admin/workers/${seededWorkerId}/service-area`,
        { address: 'Rua X', serviceRadiusKm: 10 },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });
  });

  describe('sem autenticação', () => {
    it('retorna 401', async () => {
      const res = await api.put(
        `/api/admin/workers/${seededWorkerId}/service-area`,
        validBody,
      );
      expect(res.status).toBe(401);
    });
  });

  describe('role insuficiente', () => {
    it('retorna 403 para recruiter (gate é admin)', async () => {
      const res = await api.put(
        `/api/admin/workers/${seededWorkerId}/service-area`,
        validBody,
        authHeaders(recruiterToken),
      );
      expect(res.status).toBe(403);
      expect(res.data.success).toBe(false);
    });
  });

  describe('UUID inexistente', () => {
    it('retorna 404', async () => {
      const res = await api.put(
        `/api/admin/workers/${NON_EXISTENT_UUID}/service-area`,
        validBody,
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });
  });
});
