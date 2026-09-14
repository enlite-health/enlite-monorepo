/**
 * worker-document-view-url-ownership.e2e.test.ts
 *
 * Hotfix 13/09/2026 (Gabriel), extensão mesma data: o guard original só
 * comparava o `filePath` pedido contra os caminhos GRAVADOS no registro do
 * worker. Mas os endpoints de SAVE
 *   POST /api/workers/me/documents/save
 *   POST /api/workers/me/additional-documents
 *   POST /api/admin/workers/:id/additional-documents
 * aceitavam `filePath` do corpo sem checar prefixo — um worker A gravava o
 * caminho do documento de B no PRÓPRIO registro (o guard de leitura
 * aprovava: "está no registro de A") e então DELETAVA o objeto pelo caminho
 * gravado, apagando o arquivo de B.
 *
 * Estes testes rodam contra a API e Postgres REAIS (stack docker isolada
 * `hotfix-doc`, projeto `-p hotfix-doc`, portas 8099/5599), mock GCS
 * (NODE_ENV=test sem GCP_PROJECT_ID, ver GCSStorageService.isMockMode) e
 * MockAuth (USE_MOCK_AUTH=true).
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5599/enlite_e2e';

describe('Worker document ownership — trava por PREFIXO do dono em view, delete e save', () => {
  const api = createApiClient();
  let pool: Pool;

  const ts = Date.now();
  const DOC_UUID_A = '11111111-2222-4333-8444-555555555555';
  const DOC_UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';

  let adminToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let noWorkerToken: string; // conta autenticada mas sem linha em `workers`

  let workerAId: string;
  let workerBId: string;
  let workerAPath: string;
  let workerBPath: string;

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

    // Caminhos NA FORMA que o próprio fluxo de upload gera:
    // workers/<workerId>/<docType>/<uuid>.<ext> — GCSStorageService.ts:69-75.
    workerAPath = `workers/${workerAId}/identity_document/${DOC_UUID_A}.pdf`;
    workerBPath = `workers/${workerBId}/identity_document/${DOC_UUID_B}.pdf`;

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
    it('worker A pedindo o PRÓPRIO caminho → 200 com signedUrl (controle positivo)', async () => {
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

    it('path traversal PERCENT-ENCODED ("%2e%2e") → 404', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: `workers/${workerAId}/%2e%2e/${workerBId}/identity_document/${DOC_UUID_B}.pdf` },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(404);
    });

    it('URL completa do objeto de worker B (mesmo bucket) → 404', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: `https://storage.googleapis.com/enlite-worker-documents/${workerBPath}` },
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

  // ─────────────────────────────────────────────────────────────────────
  // POST /api/workers/me/documents/save — hotfix 13/09 (extensão)
  // ─────────────────────────────────────────────────────────────────────
  describe('POST /api/workers/me/documents/save — trava de prefixo do dono', () => {
    it('worker A tenta gravar o caminho REAL de worker B no próprio registro → 400, nunca grava', async () => {
      const before = await pool.query('SELECT identity_document_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(before.rows[0].identity_document_url).toBe(workerAPath);

      const res = await api.post(
        '/api/workers/me/documents/save',
        { docType: 'identity_document', filePath: workerBPath },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);

      const after = await pool.query('SELECT identity_document_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(after.rows[0].identity_document_url).toBe(workerAPath); // inalterado — B nunca entrou no registro de A
    });

    it('worker A grava caminho de forma "solta" (basename não-uuid) DENTRO do próprio prefixo → 200 — SAVE só checa prefixo, não a forma exata', async () => {
      const res = await api.post(
        '/api/workers/me/documents/save',
        { docType: 'monotributo_certificate', filePath: `workers/${workerAId}/monotributo_certificate/nao-e-uuid.pdf` },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(200);
    });

    it('worker A tenta gravar caminho com prefixo INTEIRO diferente (path traversal disfarçado) → 400', async () => {
      const res = await api.post(
        '/api/workers/me/documents/save',
        { docType: 'identity_document', filePath: `workers/${workerAId}/../${workerBId}/identity_document/${DOC_UUID_B}.pdf` },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(400);
    });

    it('worker A grava o PRÓPRIO caminho (mesmo docType) → 200 (controle positivo)', async () => {
      const uploadRes = await api.post(
        '/api/workers/me/documents/upload-url',
        { docType: 'criminal_record', contentType: 'application/pdf' },
        authHeaders(workerAToken),
      );
      expect(uploadRes.status).toBe(200);
      const ownFilePath: string = uploadRes.data.data.filePath;
      expect(ownFilePath).toMatch(new RegExp(`^workers/${workerAId}/criminal_record/.+\\.pdf$`));

      const saveRes = await api.post(
        '/api/workers/me/documents/save',
        { docType: 'criminal_record', filePath: ownFilePath },
        authHeaders(workerAToken),
      );
      expect(saveRes.status).toBe(200);

      const row = await pool.query('SELECT criminal_record_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(row.rows[0].criminal_record_url).toBe(ownFilePath);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // DELETE /api/workers/me/documents/:type — hotfix 13/09 (extensão)
  // ─────────────────────────────────────────────────────────────────────
  describe('DELETE /api/workers/me/documents/:type — não apaga objeto de OUTRO worker', () => {
    it('registro de A "contaminado" com o caminho de B (simulando o contorno pré-hotfix via SQL direto) — DELETE 404 e NÃO limpa o campo', async () => {
      // Antes do hotfix, o SAVE deixava isso acontecer pela API; hoje o SAVE já
      // recusa (provado acima). Para provar que o DELETE também está fechado
      // (2ª camada, GCSStorageService), simulamos a pré-condição por SQL direto
      // — nunca mais alcançável pela API, mas a trava tem de segurar mesmo assim.
      await pool.query(
        'UPDATE worker_documents SET liability_insurance_url = $2 WHERE worker_id = $1',
        [workerAId, workerBPath],
      );

      const res = await api.delete('/api/workers/me/documents/liability_insurance', authHeaders(workerAToken));
      expect(res.status).toBe(404);

      const row = await pool.query('SELECT liability_insurance_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(row.rows[0].liability_insurance_url).toBe(workerBPath); // NÃO foi limpo — o objeto de B nunca foi "apagado"

      // Confirma que o objeto de B, no registro DELE, segue intacto.
      const bRow = await pool.query('SELECT identity_document_url FROM worker_documents WHERE worker_id = $1', [workerBId]);
      expect(bRow.rows[0].identity_document_url).toBe(workerBPath);
    });

    it('worker A deleta o PRÓPRIO documento → 200 e o campo é limpo (controle positivo)', async () => {
      const res = await api.delete('/api/workers/me/documents/criminal_record', authHeaders(workerAToken));
      expect(res.status).toBe(200);

      const row = await pool.query('SELECT criminal_record_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(row.rows[0].criminal_record_url).toBeNull();
    });
  });
});
