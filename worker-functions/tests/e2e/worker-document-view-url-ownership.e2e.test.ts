/**
 * worker-document-view-url-ownership.e2e.test.ts
 *
 * Hotfix 13/09/2026 (Gabriel): antes deste fix, tanto
 *   POST /api/workers/me/documents/view-url
 * quanto
 *   POST /api/admin/workers/:id/documents/view-url
 * assinavam QUALQUER `filePath` do corpo, sem checar que o caminho pertence
 * ao worker (own ou :id). Um worker autenticado conseguia URL de leitura do
 * documento de OUTRO worker só sabendo (ou adivinhando) o path; a rota admin
 * ignorava `:id` por completo.
 *
 * Estes testes rodam contra a API e Postgres REAIS (stack docker
 * `hotfix-doc`, mock GCS — NODE_ENV=test sem GCP_PROJECT_ID, ver
 * GCSStorageService.isMockMode) e MockAuth (USE_MOCK_AUTH=true).
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5599/enlite_e2e';

describe('Worker document view-url — URL assinada só para documento do próprio worker', () => {
  const api = createApiClient();
  let pool: Pool;

  const ts = Date.now();

  let adminToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let noWorkerToken: string; // conta autenticada mas sem linha em `workers`

  let workerAId: string;
  let workerBId: string;

  const workerAPath = `workers/wA-${ts}/identity_document/real-doc.pdf`;
  const workerBPath = `workers/wB-${ts}/identity_document/other-doc.pdf`;

  async function insertWorker(tag: string): Promise<{ id: string; authUid: string }> {
    const authUid = `dvu-${tag}-${ts}`;
    const email = `dvu-${tag}-${ts}@e2e.local`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country)
       VALUES ($1, $2, 'REGISTERED', 'AR')
       RETURNING id`,
      [authUid, email],
    );
    return { id: rows[0].id, authUid };
  }

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    adminToken = await getMockToken(api, {
      uid: `dvu-admin-${ts}`,
      email: `dvu-admin-${ts}@e2e.local`,
      role: 'admin',
    });

    const workerA = await insertWorker('worker-a');
    workerAId = workerA.id;
    workerAToken = await getMockToken(api, { uid: workerA.authUid, email: `${workerA.authUid}@e2e.local`, role: 'worker' });

    const workerB = await insertWorker('worker-b');
    workerBId = workerB.id;
    workerBToken = await getMockToken(api, { uid: workerB.authUid, email: `${workerB.authUid}@e2e.local`, role: 'worker' });

    noWorkerToken = await getMockToken(api, {
      uid: `dvu-no-worker-${ts}`,
      email: `dvu-no-worker-${ts}@e2e.local`,
      role: 'worker',
    });

    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, documents_status)
       VALUES ($1, $2, 'incomplete')`,
      [workerAId, workerAPath],
    );
    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, documents_status)
       VALUES ($1, $2, 'incomplete')`,
      [workerBId, workerBPath],
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM worker_documents WHERE worker_id IN ($1, $2)', [workerAId, workerBId]);
      await pool.query('DELETE FROM workers WHERE id IN ($1, $2)', [workerAId, workerBId]);
      await pool.end();
    }
  });

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ─────────────────────────────────────────────────────────────────────
  // POST /api/workers/me/documents/view-url
  // ─────────────────────────────────────────────────────────────────────
  describe('POST /api/workers/me/documents/view-url', () => {
    it('worker A pedindo o PRÓPRIO caminho → 200 com signedUrl', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: workerAPath },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(typeof res.data.data.signedUrl).toBe('string');
      expect(res.data.data.signedUrl).toContain('mock-gcs-view');
    });

    it('worker A pedindo o caminho de worker B → 404 (nunca assina o de outro worker)', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: workerBPath },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it('path traversal ("..") → 404', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: '../../etc/passwd' },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(404);
    });

    it('conta autenticada sem worker vinculado → 404', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: workerAPath },
        authHeaders(noWorkerToken),
      );
      expect(res.status).toBe(404);
    });

    it('sem token → 401', async () => {
      const res = await api.post('/api/workers/me/documents/view-url', { filePath: workerAPath });
      expect(res.status).toBe(401);
    });

    it('sem filePath → 400', async () => {
      const res = await api.post('/api/workers/me/documents/view-url', {}, authHeaders(workerAToken));
      expect(res.status).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // POST /api/admin/workers/:id/documents/view-url
  // ─────────────────────────────────────────────────────────────────────
  describe('POST /api/admin/workers/:id/documents/view-url', () => {
    it('admin pedindo o caminho CORRETO de :id → 200 com signedUrl', async () => {
      const res = await api.post(
        `/api/admin/workers/${workerAId}/documents/view-url`,
        { filePath: workerAPath },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.signedUrl).toContain('mock-gcs-view');
    });

    it(':id = worker A mas filePath de worker B → 404 (a rota admin agora respeita :id)', async () => {
      const res = await api.post(
        `/api/admin/workers/${workerAId}/documents/view-url`,
        { filePath: workerBPath },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
    });

    it(':id inexistente → 404, nunca assina', async () => {
      const res = await api.post(
        '/api/admin/workers/00000000-0000-0000-0000-000000000000/documents/view-url',
        { filePath: workerAPath },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
    });

    it('role worker na rota admin → 403 (permissão inalterada pelo hotfix)', async () => {
      const res = await api.post(
        `/api/admin/workers/${workerAId}/documents/view-url`,
        { filePath: workerAPath },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(403);
    });

    it('sem token → 401', async () => {
      const res = await api.post(
        `/api/admin/workers/${workerAId}/documents/view-url`,
        { filePath: workerAPath },
      );
      expect(res.status).toBe(401);
    });

    it('sem filePath → 400', async () => {
      const res = await api.post(
        `/api/admin/workers/${workerAId}/documents/view-url`,
        {},
        authHeaders(adminToken),
      );
      expect(res.status).toBe(400);
    });
  });
});
