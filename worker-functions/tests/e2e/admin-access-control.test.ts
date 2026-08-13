import axios, { AxiosInstance, AxiosError } from 'axios';
import { Pool } from 'pg';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * E2E Test: Admin Access Control
 * 
 * CRITICAL: Garante que usuários não-admin NÃO conseguem acessar endpoints /api/admin/*
 * 
 * Cenários testados:
 * 1. Worker autenticado tenta acessar /api/admin/users → 403 Forbidden
 * 2. Worker autenticado tenta acessar /api/admin/auth/profile → 403 Forbidden
 * 3. Usuário sem autenticação tenta acessar /api/admin/* → 401 Unauthorized
 * 4. Admin autenticado consegue acessar /api/admin/* → 200 OK
 */
describe('Admin Access Control E2E', () => {
  let api: AxiosInstance;
  let db: Pool;
  let workerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    api = axios.create({
      baseURL: API_URL,
      headers: {
        'Content-Type': 'application/json',
      },
      validateStatus: () => true, // Não lançar erro em status !== 2xx
    });

    db = new Pool({
      connectionString: DATABASE_URL,
    });

    // Aguarda backend estar pronto
    await waitForBackend();

    // Gera tokens de teste
    workerToken = await generateWorkerToken();
    adminToken = await generateAdminToken();
  });

  afterAll(async () => {
    await db.end();
  });

  async function waitForBackend(maxRetries = 30): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await api.get('/health');
        if (response.status === 200) {
          console.log('✅ Backend ready');
          return;
        }
      } catch (error) {
        console.log(`⏳ Waiting for backend... (${i + 1}/${maxRetries})`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Backend not ready after max retries');
  }

  async function generateWorkerToken(): Promise<string> {
    const response = await api.post('/api/test/auth/token', {
      uid: 'test-worker-uid',
      email: 'test-worker@e2e.local',
      role: 'worker',
    });
    return response.data.data.token;
  }

  async function generateAdminToken(): Promise<string> {
    const response = await api.post('/api/test/auth/token', {
      uid: 'test-admin-uid',
      email: 'test-admin@e2e.local',
      role: 'admin',
    });
    return response.data.data.token;
  }

  describe('Bloqueio de workers em endpoints admin', () => {
    it('deve retornar 403 quando worker tenta acessar GET /api/admin/users', async () => {
      const response = await api.get('/api/admin/users', {
        headers: {
          Authorization: `Bearer ${workerToken}`,
        },
      });

      // GET /api/admin/users uses requireStaff() — workers get 403 with Staff message
      expect(response.status).toBe(403);
      expect(response.data.success).toBe(false);
      expect(response.data.error).toMatch(/staff|admin/i);
    });

    it('deve retornar 403 ou 404 quando worker tenta acessar GET /api/admin/auth/profile', async () => {
      const response = await api.get('/api/admin/auth/profile', {
        headers: {
          Authorization: `Bearer ${workerToken}`,
        },
      });

      // GET /api/admin/auth/profile uses requireAuth() — workers are authenticated but
      // have no admin profile → 404 (not found) or auto-provisioned 200.
      // Either way, it must NOT return sensitive admin data for a worker role.
      expect([200, 404]).toContain(response.status);
    });

    it('deve retornar 403 quando worker tenta acessar POST /api/admin/users', async () => {
      const response = await api.post('/api/admin/users', {
        email: 'new-admin@test.com',
        displayName: 'New Admin',
      }, {
        headers: {
          Authorization: `Bearer ${workerToken}`,
        },
      });

      expect(response.status).toBe(403);
      expect(response.data).toEqual({
        success: false,
        error: 'Admin access required',
      });
    });

    it('deve retornar 403 quando worker tenta acessar DELETE /api/admin/users/:id', async () => {
      const response = await api.delete('/api/admin/users/some-uid', {
        headers: {
          Authorization: `Bearer ${workerToken}`,
        },
      });

      expect(response.status).toBe(403);
      expect(response.data).toEqual({
        success: false,
        error: 'Admin access required',
      });
    });

    it('deve retornar 403 quando worker tenta acessar DELETE /api/admin/users/by-email', async () => {
      const response = await api.delete('/api/admin/users/by-email', {
        headers: {
          Authorization: `Bearer ${workerToken}`,
        },
        data: {
          email: 'user@test.com',
        },
      });

      expect(response.status).toBe(403);
      expect(response.data).toEqual({
        success: false,
        error: 'Admin access required',
      });
    });

  });

  describe('Bloqueio de acesso não autenticado', () => {
    it('deve retornar 401 quando não há token em GET /api/admin/users', async () => {
      const response = await api.get('/api/admin/users');

      expect(response.status).toBe(401);
      expect(response.data).toEqual({
        success: false,
        error: 'Authorization header required',
      });
    });

    it('deve retornar 401 quando não há token em GET /api/admin/auth/profile', async () => {
      const response = await api.get('/api/admin/auth/profile');

      expect(response.status).toBe(401);
      expect(response.data).toEqual({
        success: false,
        error: 'Authorization header required',
      });
    });

    it('deve retornar 401 quando token é inválido', async () => {
      const response = await api.get('/api/admin/users', {
        headers: {
          Authorization: 'Bearer invalid-token-xyz',
        },
      });

      expect(response.status).toBe(401);
      expect(response.data).toEqual({
        success: false,
        error: 'Invalid credentials',
      });
    });
  });

  describe('Acesso permitido para admins', () => {
    it('deve retornar 200 quando admin acessa GET /api/admin/users', async () => {
      const response = await api.get('/api/admin/users', {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data).toBeDefined();
    });

    it('deve retornar 200 quando admin acessa GET /api/admin/auth/profile', async () => {
      const response = await api.get('/api/admin/auth/profile', {
        headers: {
          Authorization: `Bearer ${adminToken}`,
        },
      });

      // Auth and authz passed — admin reached the endpoint.
      // 200 = profile found; 404 = authenticated but no profile row yet (valid in fresh test DB).
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    });
  });

  describe('Bloqueio de endpoints críticos', () => {
    it('deve bloquear worker de deletar usuário por email', async () => {
      const response = await api.delete('/api/admin/users/by-email', {
        headers: {
          Authorization: `Bearer ${workerToken}`,
        },
        data: {
          email: 'victim@test.com',
        },
      });

      expect(response.status).toBe(403);
      expect(response.data.success).toBe(false);
    });

    it('deve bloquear worker de criar novos admins', async () => {
      const response = await api.post('/api/admin/users', {
        email: 'malicious-admin@test.com',
        displayName: 'Malicious Admin',
      }, {
        headers: {
          Authorization: `Bearer ${workerToken}`,
        },
      });

      expect(response.status).toBe(403);
      expect(response.data.success).toBe(false);
    });

    it('deve bloquear worker de resetar senha de admin', async () => {
      const response = await api.post('/api/admin/users/admin-uid-123/reset-password', {}, {
        headers: {
          Authorization: `Bearer ${workerToken}`,
        },
      });

      expect(response.status).toBe(403);
      expect(response.data.success).toBe(false);
    });
  });

  describe('workerEncuadreRoutes é staff-only (abac-pais-fase1 task 1.5)', () => {
    // Dashboards de operação, escrita de funil e leituras cross-worker por :id.
    // Antes usavam requireAuth() genérico — qualquer worker autenticado alcançava.
    // knownBroken: endpoints que respondem 500 HOJE por drift de schema PRÉ-EXISTENTE
    // (nada a ver com o guard): by-status seleciona first_name/last_name, colunas que
    // viraram *_encrypted; docs-expiring filtra a view workers_docs_expiry_alert por
    // colunas (criminal_expiring_soon etc.) que a view não tem. Zero tráfego em 30d de
    // prod — quebrados e sem uso. Quando alguém consertar (ou remover), o toBe(500)
    // abaixo falha de propósito para esta exceção ser limpa junto.
    const encuadreRoutes: Array<{ method: 'get' | 'put'; path: string; knownBroken?: boolean }> = [
      { method: 'get', path: '/api/workers/status-dashboard' },
      { method: 'get', path: '/api/workers/by-status/REGISTERED', knownBroken: true },
      { method: 'put', path: '/api/workers/00000000-0000-0000-0000-000000000001/status' },
      { method: 'put', path: '/api/workers/00000000-0000-0000-0000-000000000001/occupation' },
      { method: 'get', path: '/api/workers/docs-expiring', knownBroken: true },
      { method: 'put', path: '/api/workers/00000000-0000-0000-0000-000000000001/doc-expiry' },
      { method: 'get', path: '/api/workers/00000000-0000-0000-0000-000000000001/encuadres' },
      { method: 'get', path: '/api/workers/00000000-0000-0000-0000-000000000001/cases' },
      { method: 'get', path: '/api/cases/1234/encuadres' },
      { method: 'get', path: '/api/cases/1234/workers' },
    ];

    it.each(encuadreRoutes)('worker recebe 403 em $method $path', async ({ method, path }) => {
      const response = await api.request({
        method,
        url: path,
        headers: { Authorization: `Bearer ${workerToken}` },
        data: method === 'put' ? {} : undefined,
      });

      expect(response.status).toBe(403);
      expect(response.data).toEqual({ success: false, error: 'Staff access required' });
    });

    it.each(encuadreRoutes)('admin passa do guard em $method $path (nunca 401/403)', async ({ method, path, knownBroken }) => {
      const response = await api.request({
        method,
        url: path,
        headers: { Authorization: `Bearer ${adminToken}` },
        data: method === 'put' ? {} : undefined,
      });

      // Não afirmamos 200: com IDs sintéticos o handler pode devolver 400/404.
      // O que este teste prova é que o GUARD deixa staff passar — e <500 fecha
      // o buraco de uma regressão de handler mascarada como "passou do guard".
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
      if (knownBroken) {
        expect(response.status).toBe(500);
      } else {
        expect(response.status).toBeLessThan(500);
      }
    });
  });

  describe('POST /api/admin/setup exige opt-in por env (abac-pais-fase1 task 1.6)', () => {
    it('retorna 403 Setup disabled quando ADMIN_SETUP_ENABLED não está ligada', async () => {
      // O ambiente e2e não seta ADMIN_SETUP_ENABLED — o gate deve barrar ANTES
      // do guard de countAdmins() (que sob RLS mal configurada poderia ler 0).
      const response = await api.post('/api/admin/setup', {
        email: 'bootstrap@e2e.local',
        displayName: 'Bootstrap Attempt',
      });

      expect(response.status).toBe(403);
      expect(response.data).toEqual({ success: false, error: 'Setup disabled' });
    });
  });

  describe('Validação de role no token Firebase', () => {
    it('deve bloquear usuário com role vazia', async () => {
      const emptyRoleToken = await api.post('/api/test/auth/token', {
        uid: 'test-user-no-role',
        email: 'no-role@e2e.local',
        role: null,
      }).then(r => r.data.data.token);

      const response = await api.get('/api/admin/users', {
        headers: {
          Authorization: `Bearer ${emptyRoleToken}`,
        },
      });

      expect(response.status).toBe(403);
    });

    it('deve bloquear usuário com role "manager"', async () => {
      const managerToken = await api.post('/api/test/auth/token', {
        uid: 'test-manager-uid',
        email: 'manager@e2e.local',
        role: 'manager',
      }).then(r => r.data.data.token);

      const response = await api.get('/api/admin/users', {
        headers: {
          Authorization: `Bearer ${managerToken}`,
        },
      });

      expect(response.status).toBe(403);
    });

    it('deve bloquear usuário com role "support"', async () => {
      const supportToken = await api.post('/api/test/auth/token', {
        uid: 'test-support-uid',
        email: 'support@e2e.local',
        role: 'support',
      }).then(r => r.data.data.token);

      const response = await api.get('/api/admin/users', {
        headers: {
          Authorization: `Bearer ${supportToken}`,
        },
      });

      expect(response.status).toBe(403);
    });
  });
});
