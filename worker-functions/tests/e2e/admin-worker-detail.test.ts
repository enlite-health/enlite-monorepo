/**
 * admin-worker-detail.test.ts
 *
 * Testa o endpoint de detalhes de um worker no painel admin.
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 *
 * Endpoints cobertos:
 *   GET /api/admin/workers/:id
 *
 * Cenários:
 *   - 200 com worker existente (valida shape do response e campos PII descriptografados)
 *   - 404 com UUID inexistente
 *   - 401 sem token de autenticação
 *   - 403 para role worker (apenas admin tem acesso)
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('GET /api/admin/workers/:id', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let seededWorkerId: string;

  const testAuthUid = `worker-detail-e2e-${Date.now()}`;
  const testEmail = `worker-detail-${Date.now()}@e2e.local`;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'worker-detail-admin-e2e',
      email: 'worker-detail-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'worker-detail-worker-e2e',
      email: 'worker-detail-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Seed: cria um worker via endpoint público para ter um ID válido nos testes
    const initRes = await api.post('/api/workers/init', {
      authUid: testAuthUid,
      email: testEmail,
      country: 'AR',
    });

    if (initRes.status !== 200 && initRes.status !== 201) {
      throw new Error(
        `Failed to seed worker for detail test: ${JSON.stringify(initRes.data)}`,
      );
    }

    seededWorkerId = initRes.data.data.worker.id;

    // Seed: salva dados pessoais para que campos PII estejam presentes
    const workerSeedToken = await getMockToken(api, {
      uid: testAuthUid,
      email: testEmail,
      role: 'worker',
    });

    await api.put(
      '/api/workers/me/general-info',
      {
        firstName: 'Maria',
        lastName: 'Garcia',
        sex: 'female',
        gender: 'female',
        birthDate: '1985-06-15',
        documentType: 'DNI',
        documentNumber: '87654321',
        phone: '+5491188888888',
        languages: ['es', 'pt'],
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
      // Remove registros dependentes antes do worker (FK constraints)
      await pool.query('DELETE FROM worker_service_areas WHERE worker_id = $1', [seededWorkerId]);
      await pool.query('DELETE FROM worker_documents WHERE worker_id = $1', [seededWorkerId]);
      await pool.query('DELETE FROM workers WHERE id = $1', [seededWorkerId]);
    }
    if (pool) await pool.end();
  });

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 200 — worker encontrado
  // ─────────────────────────────────────────────────────────────────────────────
  describe('worker existente', () => {
    it('retorna 200 com success: true e campo data', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toBeDefined();
    });

    it('retorna campos de identidade obrigatórios no response', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );

      const { data } = res.data;
      expect(data).toHaveProperty('id');
      expect(data).toHaveProperty('email');
      expect(data).toHaveProperty('status');
      expect(data).toHaveProperty('country');
      expect(data).toHaveProperty('createdAt');
      expect(data).toHaveProperty('updatedAt');
      expect(data).toHaveProperty('platform');
      expect(data).toHaveProperty('dataSources');
      expect(data).toHaveProperty('isMatchable');
      expect(data).toHaveProperty('isActive');
    });

    it('retorna campos PII descriptografados como strings legíveis', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );

      const { data } = res.data;

      // firstName e lastName devem ser strings (não blobs criptografados)
      expect(typeof data.firstName).toBe('string');
      expect(typeof data.lastName).toBe('string');
      expect(data.firstName).toBe('Maria');
      expect(data.lastName).toBe('Garcia');
    });

    it('campos PII não parecem dados criptografados (sem prefixo base64 de KMS)', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );

      const { data } = res.data;

      // Dados criptografados teriam formato de base64 longo — nomes reais são curtos e legíveis
      expect(data.firstName.length).toBeLessThan(50);
      expect(data.lastName.length).toBeLessThan(50);
      // Não deve conter caracteres típicos de payload base64 KMS
      expect(data.firstName).not.toMatch(/^[A-Za-z0-9+/]{30,}={0,2}$/);
    });

    it('retorna campos profissionais', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );

      const { data } = res.data;
      expect(data).toHaveProperty('profession');
      expect(data).toHaveProperty('occupation');
      expect(data).toHaveProperty('knowledgeLevel');
      expect(data).toHaveProperty('experienceTypes');
      expect(data).toHaveProperty('yearsExperience');
      expect(data).toHaveProperty('preferredTypes');
      expect(data).toHaveProperty('languages');
      expect(Array.isArray(data.experienceTypes)).toBe(true);
      expect(Array.isArray(data.preferredTypes)).toBe(true);
      expect(Array.isArray(data.languages)).toBe(true);
    });

    it('retorna campos de dados relacionados com shape correto', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );

      const { data } = res.data;

      // documents pode ser null (worker recém-criado pode não ter documentos)
      expect(data).toHaveProperty('documents');

      // serviceAreas é sempre array
      expect(data).toHaveProperty('serviceAreas');
      expect(Array.isArray(data.serviceAreas)).toBe(true);

      // location pode ser null
      expect(data).toHaveProperty('location');

      // encuadres é sempre array
      expect(data).toHaveProperty('encuadres');
      expect(Array.isArray(data.encuadres)).toBe(true);
    });

    it('o id retornado bate com o UUID solicitado', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(adminToken),
      );

      expect(res.data.data.id).toBe(seededWorkerId);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 404 — worker não encontrado
  // ─────────────────────────────────────────────────────────────────────────────
  describe('UUID inexistente', () => {
    it('retorna 404 com success: false e mensagem de erro', async () => {
      const res = await api.get(
        `/api/admin/workers/${NON_EXISTENT_UUID}`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Worker not found');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 401 — sem autenticação
  // ─────────────────────────────────────────────────────────────────────────────
  describe('sem autenticação', () => {
    it('retorna 401 quando não há token', async () => {
      const res = await api.get(`/api/admin/workers/${seededWorkerId}`);

      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });

    it('retorna 401 com token malformado', async () => {
      const res = await api.get(`/api/admin/workers/${seededWorkerId}`, {
        headers: { Authorization: 'Bearer token-invalido-xyz' },
      });

      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // 403 — role insuficiente
  // ─────────────────────────────────────────────────────────────────────────────
  describe('role worker (sem permissão admin)', () => {
    it('retorna 403 quando role é worker', async () => {
      const res = await api.get(
        `/api/admin/workers/${seededWorkerId}`,
        authHeaders(workerToken),
      );

      expect(res.status).toBe(403);
      expect(res.data.success).toBe(false);
    });
  });
});
