/**
 * admin-worker-profile-edit.e2e.test.ts
 *
 * Testa o endpoint de edição administrativa do perfil de um worker.
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 *
 * Endpoint coberto:
 *   PATCH /api/admin/workers/:id/profile   (adminOnly — role === ADMIN)
 *
 * Cenários:
 *   - 200: admin atualiza campos e a mudança persiste (confirmado via GET)
 *   - 200: atualizar profession reflete no detalhe
 *   - 400: body vazio / sem campos
 *   - 401: sem token
 *   - 403: role worker
 *   - 403: role recruiter (gate é admin, mais estrito que staff)
 *   - 404: UUID inexistente
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('PATCH /api/admin/workers/:id/profile', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let recruiterToken: string;
  let pool: Pool;
  let seededWorkerId: string;

  const testAuthUid = `worker-profile-edit-e2e-${Date.now()}`;
  const testEmail = `worker-profile-edit-${Date.now()}@e2e.local`;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'worker-profile-edit-admin-e2e',
      email: 'worker-profile-edit-admin@e2e.local',
      role: 'admin',
    });
    workerToken = await getMockToken(api, {
      uid: 'worker-profile-edit-worker-e2e',
      email: 'worker-profile-edit-worker@e2e.local',
      role: 'worker',
    });
    recruiterToken = await getMockToken(api, {
      uid: 'worker-profile-edit-recruiter-e2e',
      email: 'worker-profile-edit-recruiter@e2e.local',
      role: 'recruiter',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Seed: cria um worker via endpoint público para ter um ID válido
    const initRes = await api.post('/api/workers/init', {
      authUid: testAuthUid,
      email: testEmail,
      country: 'AR',
    });
    if (initRes.status !== 200 && initRes.status !== 201) {
      throw new Error(`Failed to seed worker: ${JSON.stringify(initRes.data)}`);
    }
    seededWorkerId = initRes.data.data.worker.id;

    // Seed: dados pessoais iniciais
    const workerSeedToken = await getMockToken(api, {
      uid: testAuthUid,
      email: testEmail,
      role: 'worker',
    });
    await api.put(
      '/api/workers/me/general-info',
      {
        firstName: 'Original',
        lastName: 'Name',
        sex: 'female',
        gender: 'female',
        birthDate: '1990-01-01',
        documentType: 'DNI',
        documentNumber: '12345678',
        phone: '+5491177777777',
        languages: ['es'],
        profession: 'CAREGIVER',
        knowledgeLevel: 'UNIVERSITY',
        experienceTypes: ['TEA'],
        yearsExperience: '5_10',
        preferredTypes: ['TEA'],
        preferredAgeRange: ['children'],
        termsAccepted: true,
        privacyAccepted: true,
      },
      { headers: { Authorization: `Bearer ${workerSeedToken}` } },
    );
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

  // ── 200 — admin atualiza e persiste ──
  describe('admin atualiza campos', () => {
    it('retorna 200 e lista fieldsUpdated', async () => {
      const res = await api.patch(
        `/api/admin/workers/${seededWorkerId}/profile`,
        { firstName: 'Editado', lastName: 'Sobrenome', email: 'editado@e2e.local' },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.fieldsUpdated).toEqual(
        expect.arrayContaining(['firstName', 'lastName', 'email']),
      );
    });

    it('a mudança persiste (confirmado via GET de detalhe)', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.firstName).toBe('Editado');
      expect(res.data.data.lastName).toBe('Sobrenome');
      expect(res.data.data.email).toBe('editado@e2e.local');
    });

    it('atualizar profession reflete no detalhe', async () => {
      const patchRes = await api.patch(
        `/api/admin/workers/${seededWorkerId}/profile`,
        { profession: 'AT' },
        authHeaders(adminToken),
      );
      expect(patchRes.status).toBe(200);
      expect(patchRes.data.data.fieldsUpdated).toContain('profession');

      const getRes = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );
      expect(getRes.data.data.profession).toBe('AT');
    });
  });

  // ── 400 — body inválido ──
  describe('body inválido', () => {
    it('retorna 400 quando nenhum campo é informado', async () => {
      const res = await api.patch(
        `/api/admin/workers/${seededWorkerId}/profile`,
        {},
        authHeaders(adminToken),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 400 quando profession é inválida', async () => {
      const res = await api.patch(
        `/api/admin/workers/${seededWorkerId}/profile`,
        { profession: 'INVALID_PROFESSION' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });
  });

  // ── 401 — sem autenticação ──
  describe('sem autenticação', () => {
    it('retorna 401 quando não há token', async () => {
      const res = await api.patch(
        `/api/admin/workers/${seededWorkerId}/profile`,
        { firstName: 'X' },
      );
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });
  });

  // ── 403 — role insuficiente (gate é admin, não staff) ──
  describe('role insuficiente', () => {
    it('retorna 403 quando role é worker', async () => {
      const res = await api.patch(
        `/api/admin/workers/${seededWorkerId}/profile`,
        { firstName: 'X' },
        authHeaders(workerToken),
      );
      expect(res.status).toBe(403);
      expect(res.data.success).toBe(false);
    });

    it('retorna 403 quando role é recruiter (staff mas não admin)', async () => {
      const res = await api.patch(
        `/api/admin/workers/${seededWorkerId}/profile`,
        { firstName: 'X' },
        authHeaders(recruiterToken),
      );
      expect(res.status).toBe(403);
      expect(res.data.success).toBe(false);
    });
  });

  // ── 404 — worker inexistente ──
  describe('UUID inexistente', () => {
    it('retorna 404', async () => {
      const res = await api.patch(
        `/api/admin/workers/${NON_EXISTENT_UUID}/profile`,
        { firstName: 'X' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Worker not found');
    });
  });
});
