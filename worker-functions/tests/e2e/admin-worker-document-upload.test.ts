/**
 * admin-worker-document-upload.test.ts
 *
 * Testa as rotas de upload e deleção de documentos de workers.
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 *
 * Endpoints cobertos:
 *   POST   /api/admin/workers/:id/documents/upload-url
 *   POST   /api/admin/workers/:id/documents/save
 *   DELETE /api/admin/workers/:id/documents/:type
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Admin Worker Document Upload API', () => {
  const api = createApiClient();
  let adminToken: string;
  let workerToken: string;
  let pool: Pool;
  let testWorkerId: string;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'docupload-admin-e2e',
      email: 'docupload-admin@e2e.local',
      role: 'admin',
    });

    workerToken = await getMockToken(api, {
      uid: 'docupload-worker-e2e',
      email: 'docupload-worker@e2e.local',
      role: 'worker',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    const workerResult = await pool.query(`
      INSERT INTO workers (auth_uid, email, status)
      VALUES ('docupload-worker-e2e-seed', 'docupload-worker@e2e.test', 'REGISTERED')
      RETURNING id
    `);
    testWorkerId = workerResult.rows[0].id;

    await pool.query(
      `INSERT INTO worker_documents (worker_id, resume_cv_url, documents_status, document_validations)
       VALUES ($1, 'workers/test/existing-resume.pdf', 'incomplete', '{}')`,
      [testWorkerId],
    );
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

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/admin/workers/:id/documents/upload-url
  // ─────────────────────────────────────────────────────────────────────────
  describe('POST /api/admin/workers/:id/documents/upload-url', () => {
    // upload-url chama o GCS real para gerar signed URL — requer credenciais de serviço.
    // Em ambiente local sem Application Default Credentials o endpoint retorna 500.
    // O fluxo completo (upload-url → GCS PUT → save) é coberto nos testes Playwright.
    it.skip('retorna signedUrl e filePath para docType válido (requer credenciais GCS)', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/upload-url`,
        { docType: 'resume_cv' },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toHaveProperty('signedUrl');
      expect(res.data.data).toHaveProperty('filePath');
      expect(typeof res.data.data.signedUrl).toBe('string');
      expect(typeof res.data.data.filePath).toBe('string');
    });

    it('retorna 400 para docType inválido', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/upload-url`,
        { docType: 'invalid_type' },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/upload-url`,
        { docType: 'resume_cv' },
      );

      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/upload-url`,
        { docType: 'resume_cv' },
        authHeaders(workerToken),
      );

      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /api/admin/workers/:id/documents/save — persistência no banco
  // ─────────────────────────────────────────────────────────────────────────
  describe('POST /api/admin/workers/:id/documents/save', () => {
    it.each([
      ['resume_cv',                  'resume_cv_url'],
      ['identity_document',          'identity_document_url'],
      ['identity_document_back',     'identity_document_back_url'],
      ['criminal_record',            'criminal_record_url'],
      ['professional_registration',  'professional_registration_url'],
      ['liability_insurance',        'liability_insurance_url'],
      ['monotributo_certificate',    'monotributo_certificate_url'],
      ['at_certificate',             'at_certificate_url'],
      ['apto_psicofisico',           'apto_psicofisico_url'],
      ['analitico_universitario',    'analitico_universitario_url'],
      ['carta_recomendacion',        'carta_recomendacion_url'],
    ] as const)(
      'persiste %s_url no banco após upload',
      async (docType, sqlCol) => {
        const filePath = `workers/test/${docType}/new-file.pdf`;

        const res = await api.post(
          `/api/admin/workers/${testWorkerId}/documents/save`,
          { docType, filePath },
          authHeaders(adminToken),
        );

        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);

        const { rows } = await pool.query(
          `SELECT ${sqlCol} FROM worker_documents WHERE worker_id = $1`,
          [testWorkerId],
        );
        expect(rows[0][sqlCol]).toBe(filePath);
      },
    );

    it('retorna WorkerDocuments completo na resposta', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/save`,
        { docType: 'resume_cv', filePath: 'workers/test/resume_cv/complete-check.pdf' },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toHaveProperty('documentsStatus');
      expect(res.data.data).toHaveProperty('documentValidations');
    });

    it('retorna 400 para docType inválido', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/save`,
        { docType: 'invalid_type', filePath: 'workers/test/invalid/file.pdf' },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('retorna 401 sem token', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/save`,
        { docType: 'resume_cv', filePath: 'workers/test/resume_cv/file.pdf' },
      );

      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/save`,
        { docType: 'resume_cv', filePath: 'workers/test/resume_cv/file.pdf' },
        authHeaders(workerToken),
      );

      expect(res.status).toBe(403);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Re-upload limpa validação prévia
  // ─────────────────────────────────────────────────────────────────────────
  describe('Re-upload limpa validação prévia', () => {
    beforeAll(async () => {
      // Garante que resume_cv_url está preenchido antes de validar
      await pool.query(
        `UPDATE worker_documents SET resume_cv_url = 'workers/test/existing-resume.pdf' WHERE worker_id = $1`,
        [testWorkerId],
      );

      // Valida o resume_cv via API
      await api.post(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv/validate`,
        {},
        authHeaders(adminToken),
      );

      // Confirma que a validação foi persistida
      const { rows } = await pool.query(
        `SELECT document_validations FROM worker_documents WHERE worker_id = $1`,
        [testWorkerId],
      );
      expect(rows[0].document_validations).toHaveProperty('resume_cv');
    });

    it('re-upload via save remove a chave resume_cv de document_validations no banco', async () => {
      const res = await api.post(
        `/api/admin/workers/${testWorkerId}/documents/save`,
        { docType: 'resume_cv', filePath: 'workers/test/resume_cv/re-uploaded.pdf' },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.documentValidations).not.toHaveProperty('resume_cv');

      const { rows } = await pool.query(
        `SELECT document_validations FROM worker_documents WHERE worker_id = $1`,
        [testWorkerId],
      );
      expect(rows[0].document_validations).not.toHaveProperty('resume_cv');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /api/admin/workers/:id/documents/:type
  // ─────────────────────────────────────────────────────────────────────────
  describe('DELETE /api/admin/workers/:id/documents/:type', () => {
    beforeAll(async () => {
      // Garante que o campo existe antes de deletar
      await pool.query(
        `UPDATE worker_documents SET resume_cv_url = 'workers/test/to-delete.pdf' WHERE worker_id = $1`,
        [testWorkerId],
      );
    });

    it('remove o campo do banco após deleção (resume_cv_url fica NULL)', async () => {
      const res = await api.delete(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const { rows } = await pool.query(
        `SELECT resume_cv_url FROM worker_documents WHERE worker_id = $1`,
        [testWorkerId],
      );
      expect(rows[0].resume_cv_url).toBeNull();
    });

    // ── REGRESSION ─────────────────────────────────────────────────────────
    // Se este teste quebrar, o frontend vai receber `data: undefined`,
    // chamar patchDocuments(undefined) e zerar TODOS os cards de documento.
    // ───────────────────────────────────────────────────────────────────────
    it('REGRESSION: retorna data com WorkerDocuments completo (não apenas {success:true})', async () => {
      // Prepara: preenche 3 documentos, vai deletar apenas 1
      await pool.query(
        `UPDATE worker_documents
         SET resume_cv_url = 'workers/test/resume.pdf',
             identity_document_url = 'workers/test/identity.pdf',
             criminal_record_url = 'workers/test/criminal.pdf'
         WHERE worker_id = $1`,
        [testWorkerId],
      );

      const res = await api.delete(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv`,
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      // O response DEVE conter data — do contrário o frontend vai zerar tudo
      expect(res.data.data).toBeDefined();
      expect(res.data.data).not.toBeNull();

      // O campo deletado deve estar null, os outros preservados
      expect(res.data.data.resumeCvUrl).toBeNull();
      expect(res.data.data.identityDocumentUrl).toBe('workers/test/identity.pdf');
      expect(res.data.data.criminalRecordUrl).toBe('workers/test/criminal.pdf');

      // Estrutura mínima esperada pelo frontend (WorkerDocument type)
      expect(res.data.data).toHaveProperty('id');
      expect(res.data.data).toHaveProperty('documentsStatus');
      expect(res.data.data).toHaveProperty('documentValidations');
    });

    it('retorna 401 sem token', async () => {
      const res = await api.delete(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv`,
      );

      expect(res.status).toBe(401);
    });

    it('retorna 403 para role worker', async () => {
      const res = await api.delete(
        `/api/admin/workers/${testWorkerId}/documents/resume_cv`,
        authHeaders(workerToken),
      );

      expect(res.status).toBe(403);
    });
  });
});
