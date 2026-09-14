/**
 * admin-worker-document-validations.test.ts
 *
 * Testa as rotas de validação per-documento de workers.
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 *
 * Endpoints cobertos:
 *   POST   /api/admin/workers/:id/documents/:type/validate
 *   DELETE /api/admin/workers/:id/documents/:type/validate
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Admin Worker Document Validations API', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let testWorkerId: string;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'docval-admin-e2e',
      email: 'docval-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'docval-worker-e2e',
      email: 'docval-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // Create a test worker and seed documents with a resume_cv_url set
    const workerResult = await pool.query(`
      INSERT INTO workers (auth_uid, email, status)
      VALUES ('docval-worker-e2e-seed', 'docval-worker@e2e.test', 'REGISTERED')
      RETURNING id
    `);
    testWorkerId = workerResult.rows[0].id;

    await pool.query(`
      INSERT INTO worker_documents (worker_id, resume_cv_url, documents_status, document_validations)
      VALUES ($1, 'workers/${testWorkerId}/resume_cv/test.pdf', 'incomplete', '{}')
    `, [testWorkerId]);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM worker_documents WHERE worker_id = $1', [testWorkerId]);
      await pool.query('DELETE FROM workers WHERE id = $1', [testWorkerId]);
      await pool.end();
    }
  });

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ───────────────────────────────────────────────────────────────────
  // POST /api/admin/workers/:id/documents/:type/validate
  // ───────────────────────────────────────────────────────────────────
  describe('POST /api/admin/workers/:id/documents/:type/validate', () => {
    it('valida um documento existente e retorna WorkerDocuments atualizado', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv/validate`,
        {},
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toHaveProperty('documentValidations');
      expect(res.data.data.documentValidations).toHaveProperty('resume_cv');
      expect(res.data.data.documentValidations.resume_cv).toHaveProperty('validatedBy', 'docval-admin@e2e.local');
      expect(res.data.data.documentValidations.resume_cv).toHaveProperty('validatedAt');
    });

    it('persiste a validação no banco de dados', async () => {
      const { rows } = await pool.query(
        `SELECT document_validations FROM worker_documents WHERE worker_id = $1`,
        [testWorkerId],
      );
      expect(rows.length).toBe(1);
      const validations = rows[0].document_validations;
      expect(validations).toHaveProperty('resume_cv');
      expect(validations.resume_cv.validated_by).toBe('docval-admin@e2e.local');
      expect(validations.resume_cv.validated_at).toBeTruthy();
    });

    it('retorna 400 para docType inválido', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/invalid_doc/validate`,
        {},
        authHeaders(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/invalid document type/i);
    });

    it('retorna 400 ao tentar validar documento não enviado', async () => {
      // criminal_record_url was not set in the seed
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/criminal_record/validate`,
        {},
        authHeaders(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/not been uploaded/i);
    });

    it('retorna 401 sem token de autenticação', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv/validate`,
        {},
      );
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv/validate`,
        {},
        authHeaders(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // DELETE /api/admin/workers/:id/documents/:type/validate
  // ───────────────────────────────────────────────────────────────────
  describe('DELETE /api/admin/workers/:id/documents/:type/validate', () => {
    it('remove validação existente e retorna success', async () => {
      const res = await api.delete(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv/validate`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('validação é removida do banco de dados', async () => {
      const { rows } = await pool.query(
        `SELECT document_validations FROM worker_documents WHERE worker_id = $1`,
        [testWorkerId],
      );
      expect(rows.length).toBe(1);
      const validations = rows[0].document_validations;
      expect(validations).not.toHaveProperty('resume_cv');
    });

    it('retorna 400 para docType inválido', async () => {
      const res = await api.delete(
        `/api/admin/workers/${testWorkerId}/documents/invalid_doc/validate`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 401 sem token de autenticação', async () => {
      const res = await api.delete(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv/validate`,
      );
      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.delete(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv/validate`,
        authHeaders(workerToken),
      );
      expect(res.status).toBe(403);
    });
  });

  // ───────────────────────────────────────────────────────────────────
  // Comportamento on re-upload: validação deve ser limpa
  // ───────────────────────────────────────────────────────────────────
  describe('Re-upload limpa a validação do documento', () => {
    beforeAll(async () => {
      // Re-validate resume_cv so we have a validation to clear
      await api.post(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv/validate`,
        {},
        authHeaders(adminToken),
      );

      // Confirm validation is set
      const { rows } = await pool.query(
        `SELECT document_validations FROM worker_documents WHERE worker_id = $1`,
        [testWorkerId],
      );
      expect(rows[0].document_validations).toHaveProperty('resume_cv');
    });

    it('re-upload via saveDocumentPath remove a validação do docType correspondente', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/save`,
        { docType: 'resume_cv', filePath: `workers/${testWorkerId}/resume_cv/new-version.pdf` },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      // Validation for resume_cv must be cleared
      expect(res.data.data.documentValidations).not.toHaveProperty('resume_cv');

      // Verify in DB
      const { rows } = await pool.query(
        `SELECT document_validations FROM worker_documents WHERE worker_id = $1`,
        [testWorkerId],
      );
      expect(rows[0].document_validations).not.toHaveProperty('resume_cv');
    });
  });
});
