/**
 * worker-tags.e2e.test.ts
 *
 * E2E suite para a feature de Tags de Workers.
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 *
 * Endpoints cobertos:
 *   GET    /api/admin/worker-tags              (staffOnly)
 *   POST   /api/admin/worker-tags              (adminOnly)
 *   PATCH  /api/admin/worker-tags/:id          (adminOnly)
 *   DELETE /api/admin/worker-tags/:id          (adminOnly — soft delete)
 *   POST   /api/admin/workers/:id/tags/:tagId  (staffOnly)
 *   DELETE /api/admin/workers/:id/tags/:tagId  (staffOnly)
 *   GET    /api/admin/workers?tag_ids=...      (staffOnly — filtro AND)
 *   GET    /api/admin/workers/:id              (staffOnly — campo tags no detail)
 *
 * Cenários de autorização:
 *   - POST/PATCH/DELETE de catálogo rejeitam staff (403)
 *   - Todos os endpoints rejeitam não-autenticado (401)
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

describe('Worker Tags E2E', () => {
  const api = createApiClient();
  let adminToken: string;
  let staffToken: string;
  let pool: Pool;
  let seededWorkerId: string;

  const testWorkerAuthUid = `tags-e2e-worker-${Date.now()}`;
  const testWorkerEmail = `tags-e2e-${Date.now()}@e2e.local`;

  // IDs criados neste teste (para cleanup)
  const createdTagIds: string[] = [];

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'tags-admin-e2e',
      email: 'tags-admin@e2e.local',
      role: 'admin',
    });

    // Valid staff roles: admin | recruiter | community_manager
    staffToken = await getMockToken(api, {
      uid: 'tags-staff-e2e',
      email: 'tags-staff@e2e.local',
      role: 'recruiter',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Seed: cria worker para testar assign/remove e filtro tag_ids
    const initRes = await api.post('/api/workers/init', {
      authUid: testWorkerAuthUid,
      email: testWorkerEmail,
      country: 'AR',
    });

    if (initRes.status !== 200 && initRes.status !== 201) {
      throw new Error(`Failed to seed worker: ${JSON.stringify(initRes.data)}`);
    }

    seededWorkerId = initRes.data.data.worker.id;
  });

  afterAll(async () => {
    if (pool) {
      // Limpa tags criadas no teste (cascade limpa worker_tags)
      for (const tagId of createdTagIds) {
        await pool.query('DELETE FROM worker_tag_catalog WHERE id = $1', [tagId]).catch(() => {});
      }
      // Limpa worker seed
      if (seededWorkerId) {
        await pool.query('DELETE FROM workers WHERE id = $1', [seededWorkerId]).catch(() => {});
      }
      await pool.end();
    }
  });

  function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  async function createTag(name: string, color = '#FF5733', description?: string): Promise<string> {
    const res = await api.post(
      '/api/admin/worker-tags',
      { name, color, description },
      auth(adminToken),
    );
    expect(res.status).toBe(201);
    const id = res.data.data.id as string;
    createdTagIds.push(id);
    return id;
  }

  // ── GET /api/admin/worker-tags ────────────────────────────────────────────────

  describe('GET /api/admin/worker-tags', () => {
    it('retorna 200 com array para staff', async () => {
      const res = await api.get('/api/admin/worker-tags', auth(staffToken));
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
    });

    it('retorna 200 com array para admin', async () => {
      const res = await api.get('/api/admin/worker-tags', auth(adminToken));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.data)).toBe(true);
    });

    it('retorna 401 sem autenticação', async () => {
      const res = await api.get('/api/admin/worker-tags');
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/admin/worker-tags ───────────────────────────────────────────────

  describe('POST /api/admin/worker-tags', () => {
    it('admin cria tag com sucesso (201)', async () => {
      const name = `Tag-Create-${Date.now()}`;
      const res = await api.post(
        '/api/admin/worker-tags',
        { name, color: '#1A2B3C', description: 'Test tag description' },
        auth(adminToken),
      );
      expect(res.status).toBe(201);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toMatchObject({ name, color: '#1A2B3C' });
      expect(typeof res.data.data.id).toBe('string');
      createdTagIds.push(res.data.data.id);
    });

    it('shape do item do catálogo tem os campos esperados', async () => {
      const name = `Tag-Shape-${Date.now()}`;
      const res = await api.post(
        '/api/admin/worker-tags',
        { name, color: '#AABBCC' },
        auth(adminToken),
      );
      expect(res.status).toBe(201);
      const item = res.data.data;
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('color');
      expect(item).toHaveProperty('createdBy');
      expect(item).toHaveProperty('createdAt');
      expect(item).toHaveProperty('updatedAt');
      createdTagIds.push(item.id);
    });

    it('staff recebe 403 ao tentar criar tag', async () => {
      const res = await api.post(
        '/api/admin/worker-tags',
        { name: `Tag-Staff-${Date.now()}`, color: '#FF0000' },
        auth(staffToken),
      );
      expect(res.status).toBe(403);
    });

    it('retorna 401 sem autenticação', async () => {
      const res = await api.post('/api/admin/worker-tags', { name: 'x', color: '#000000' });
      expect(res.status).toBe(401);
    });

    it('retorna 400 com cor inválida', async () => {
      const res = await api.post(
        '/api/admin/worker-tags',
        { name: 'BadColor', color: 'red' },
        auth(adminToken),
      );
      expect(res.status).toBe(400);
    });

    it('retorna 400 com nome vazio', async () => {
      const res = await api.post(
        '/api/admin/worker-tags',
        { name: '', color: '#000000' },
        auth(adminToken),
      );
      expect(res.status).toBe(400);
    });
  });

  // ── PATCH /api/admin/worker-tags/:id ─────────────────────────────────────────

  describe('PATCH /api/admin/worker-tags/:id', () => {
    let tagId: string;

    beforeAll(async () => {
      tagId = await createTag(`Tag-Update-${Date.now()}`);
    });

    it('admin atualiza nome da tag (200)', async () => {
      const newName = `Tag-Updated-${Date.now()}`;
      const res = await api.patch(
        `/api/admin/worker-tags/${tagId}`,
        { name: newName },
        auth(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.name).toBe(newName);
    });

    it('admin atualiza cor da tag (200)', async () => {
      const res = await api.patch(
        `/api/admin/worker-tags/${tagId}`,
        { color: '#00FF00' },
        auth(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.data.color).toBe('#00FF00');
    });

    it('staff recebe 403 ao tentar atualizar', async () => {
      const res = await api.patch(
        `/api/admin/worker-tags/${tagId}`,
        { name: 'Staff-Hack' },
        auth(staffToken),
      );
      expect(res.status).toBe(403);
    });

    it('retorna 404 para UUID inexistente', async () => {
      const res = await api.patch(
        `/api/admin/worker-tags/${NON_EXISTENT_UUID}`,
        { name: 'X' },
        auth(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 400 com cor inválida', async () => {
      const res = await api.patch(
        `/api/admin/worker-tags/${tagId}`,
        { color: 'blue' },
        auth(adminToken),
      );
      expect(res.status).toBe(400);
    });
  });

  // ── DELETE /api/admin/worker-tags/:id (soft delete) ──────────────────────────

  describe('DELETE /api/admin/worker-tags/:id', () => {
    it('admin soft-deleta tag (200)', async () => {
      const tagId = await createTag(`Tag-Delete-${Date.now()}`);
      const res = await api.delete(`/api/admin/worker-tags/${tagId}`, auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('tag deletada não aparece na listagem', async () => {
      const name = `Tag-Invisible-${Date.now()}`;
      const tagId = await createTag(name);

      await api.delete(`/api/admin/worker-tags/${tagId}`, auth(adminToken));

      const listRes = await api.get('/api/admin/worker-tags', auth(adminToken));
      const names = (listRes.data.data as Array<{ name: string }>).map((t) => t.name);
      expect(names).not.toContain(name);
    });

    it('staff recebe 403 ao tentar deletar', async () => {
      const tagId = await createTag(`Tag-Staff-Del-${Date.now()}`);
      const res = await api.delete(`/api/admin/worker-tags/${tagId}`, auth(staffToken));
      expect(res.status).toBe(403);
    });

    it('retorna 404 para UUID inexistente', async () => {
      const res = await api.delete(`/api/admin/worker-tags/${NON_EXISTENT_UUID}`, auth(adminToken));
      expect(res.status).toBe(404);
    });
  });

  // ── POST /api/admin/workers/:id/tags/:tagId (assign) ─────────────────────────

  describe('POST /api/admin/workers/:id/tags/:tagId (assign)', () => {
    let tagId: string;

    beforeAll(async () => {
      tagId = await createTag(`Tag-Assign-${Date.now()}`);
    });

    it('staff atribui tag a worker (200)', async () => {
      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/tags/${tagId}`,
        {},
        auth(staffToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('operação é idempotente — segunda atribuição também retorna 200', async () => {
      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/tags/${tagId}`,
        {},
        auth(adminToken),
      );
      expect(res.status).toBe(200);
    });

    it('retorna 404 ao tentar atribuir tag inexistente', async () => {
      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/tags/${NON_EXISTENT_UUID}`,
        {},
        auth(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 404 ao tentar atribuir tag deletada', async () => {
      const deletedTagId = await createTag(`Tag-Deleted-Assign-${Date.now()}`);
      await api.delete(`/api/admin/worker-tags/${deletedTagId}`, auth(adminToken));

      const res = await api.post(
        `/api/admin/workers/${seededWorkerId}/tags/${deletedTagId}`,
        {},
        auth(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 401 sem autenticação', async () => {
      const res = await api.post(`/api/admin/workers/${seededWorkerId}/tags/${tagId}`, {});
      expect(res.status).toBe(401);
    });
  });

  // ── DELETE /api/admin/workers/:id/tags/:tagId (remove) ───────────────────────

  describe('DELETE /api/admin/workers/:id/tags/:tagId (remove)', () => {
    let tagId: string;

    beforeAll(async () => {
      tagId = await createTag(`Tag-Remove-${Date.now()}`);
      // Assign first so we can remove
      await api.post(`/api/admin/workers/${seededWorkerId}/tags/${tagId}`, {}, auth(adminToken));
    });

    it('staff remove tag de worker (200)', async () => {
      const res = await api.delete(
        `/api/admin/workers/${seededWorkerId}/tags/${tagId}`,
        auth(staffToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('retorna 404 ao tentar remover tag não atribuída', async () => {
      const res = await api.delete(
        `/api/admin/workers/${seededWorkerId}/tags/${tagId}`,
        auth(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('retorna 401 sem autenticação', async () => {
      const res = await api.delete(`/api/admin/workers/${seededWorkerId}/tags/${tagId}`);
      expect(res.status).toBe(401);
    });
  });

  // ── GET /api/admin/workers?tag_ids=... (filtro AND) ──────────────────────────

  describe('GET /api/admin/workers?tag_ids (filtro AND)', () => {
    let tagA: string;
    let tagB: string;

    beforeAll(async () => {
      tagA = await createTag(`Tag-Filter-A-${Date.now()}`);
      tagB = await createTag(`Tag-Filter-B-${Date.now()}`);
      // Atribui tagA e tagB ao worker seed
      await api.post(`/api/admin/workers/${seededWorkerId}/tags/${tagA}`, {}, auth(adminToken));
      await api.post(`/api/admin/workers/${seededWorkerId}/tags/${tagB}`, {}, auth(adminToken));
    });

    it('filtra workers com uma tag — worker seed aparece no resultado', async () => {
      const res = await api.get(`/api/admin/workers?tag_ids=${tagA}`, auth(staffToken));
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map((w) => w.id);
      expect(ids).toContain(seededWorkerId);
    });

    it('filtro AND — worker seed aparece quando tem ambas as tags', async () => {
      const res = await api.get(
        `/api/admin/workers?tag_ids=${tagA},${tagB}`,
        auth(staffToken),
      );
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map((w) => w.id);
      expect(ids).toContain(seededWorkerId);
    });

    it('filtro AND — worker sem tag não aparece no resultado', async () => {
      const tagC = await createTag(`Tag-Filter-C-${Date.now()}`);
      // tagC não está atribuída ao seededWorker
      const res = await api.get(
        `/api/admin/workers?tag_ids=${tagA},${tagC}`,
        auth(staffToken),
      );
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map((w) => w.id);
      expect(ids).not.toContain(seededWorkerId);
    });

    it('retorna 400 para UUID inválido em tag_ids', async () => {
      const res = await api.get('/api/admin/workers?tag_ids=not-a-uuid', auth(staffToken));
      expect(res.status).toBe(400);
    });
  });

  // ── GET /api/admin/workers/:id — campo tags no detail ────────────────────────

  describe('GET /api/admin/workers/:id — campo tags no detail', () => {
    let tagId: string;

    beforeAll(async () => {
      tagId = await createTag(`Tag-Detail-${Date.now()}`);
      await api.post(`/api/admin/workers/${seededWorkerId}/tags/${tagId}`, {}, auth(adminToken));
    });

    it('worker detail inclui campo tags como array', async () => {
      const res = await api.get(`/api/admin/workers/${seededWorkerId}`, auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.data.data).toHaveProperty('tags');
      expect(Array.isArray(res.data.data.tags)).toBe(true);
    });

    it('tag atribuída aparece no detail com shape correto', async () => {
      const res = await api.get(`/api/admin/workers/${seededWorkerId}`, auth(adminToken));
      const tags = res.data.data.tags as Array<{ id: string; name: string; color: string }>;
      const found = tags.find((t) => t.id === tagId);
      expect(found).toBeDefined();
      expect(found).toHaveProperty('id');
      expect(found).toHaveProperty('name');
      expect(found).toHaveProperty('color');
    });
  });
});
