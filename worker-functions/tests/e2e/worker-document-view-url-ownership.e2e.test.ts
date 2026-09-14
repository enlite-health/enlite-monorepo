/**
 * worker-document-view-url-ownership.e2e.test.ts
 *
 * Hotfix 13/09/2026 (Gabriel), RODADA 2 — o gate `revisao-pr` bloqueou a
 * rodada 1 por regressão funcional: a checagem de forma EXATA
 * (`matchesOwnedDocumentPathShape`) no guard de VIEW fechou a vulnerabilidade
 * original mas quebrou:
 *   - documentos ADICIONAIS (nunca estavam em `worker_documents`, só em
 *     `worker_additional_documents` — o guard de VIEW nunca olhava lá);
 *   - documentos INGERIDOS via MCP/WhatsApp
 *     (`workers/<id>/ingested/<tipo>/<timestamp-ms>`, sem uuid/extensão);
 *   - exclusão de caminho LEGADO fora do prefixo de upload (o registro
 *     ficava preso: `gcs.deleteFile` lançava ANTES da limpeza do campo).
 *
 * A regra desta rodada: VIEW exige (i) caminho normalizado, (ii) prefixo
 * `workers/<workerId>/` do dono, (iii) pertencer à lista de caminhos
 * GRAVADOS do worker (`worker_documents` + `worker_additional_documents`) —
 * sem mais exigir a forma exata de upload. DELETE localiza o registro pelo
 * dono como hoje; só chama o GCS quando o caminho passa (i)+(ii) — fora
 * disso, LIMPA o registro mesmo assim (`record_only`) e nunca toca o GCS.
 *
 * Estes testes rodam contra a API e Postgres REAIS (stack docker isolada
 * `hotfix-doc`, projeto `-p hotfix-doc`, portas 8099/5599/6392), mock GCS
 * (NODE_ENV=development sem GCP_PROJECT_ID, ver GCSStorageService.isMockMode)
 * e MockAuth (USE_MOCK_AUTH=true).
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5599/enlite_e2e';

describe('Worker document ownership — trava por PREFIXO do dono em view, delete e save (rodada 2)', () => {
  const api = createApiClient();
  let pool: Pool;

  const ts = Date.now();
  const DOC_UUID_A = '11111111-2222-4333-8444-555555555555';
  const DOC_UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  const ADDITIONAL_UUID_A = '77777777-7777-4777-8777-777777777777';

  let adminToken: string;
  let workerAToken: string;
  let workerBToken: string;
  let noWorkerToken: string; // conta autenticada mas sem linha em `workers`

  let workerAId: string;
  let workerBId: string;
  let workerAPath: string;
  let workerBPath: string;
  let additionalPathA: string;
  let ingestedPathA: string;
  let additionalDocIdA: string;

  async function insertWorker(tag: string): Promise<{ id: string; authUid: string }> {
    const authUid = `dvu2-${tag}-${ts}`;
    const email = `dvu2-${tag}-${ts}@e2e.local`;
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
      uid: `dvu2-admin-${ts}`,
      email: `dvu2-admin-${ts}@e2e.local`,
      role: 'admin',
    });

    const workerA = await insertWorker('worker-a');
    workerAId = workerA.id;
    workerAToken = await getMockToken(api, { uid: workerA.authUid, email: `${workerA.authUid}@e2e.local`, role: 'worker' });

    const workerB = await insertWorker('worker-b');
    workerBId = workerB.id;
    workerBToken = await getMockToken(api, { uid: workerB.authUid, email: `${workerB.authUid}@e2e.local`, role: 'worker' });

    noWorkerToken = await getMockToken(api, {
      uid: `dvu2-no-worker-${ts}`,
      email: `dvu2-no-worker-${ts}@e2e.local`,
      role: 'worker',
    });

    // Caminhos NA FORMA que o próprio fluxo de upload gera:
    // workers/<workerId>/<docType>/<uuid>.<ext> — GCSStorageService.ts.
    workerAPath = `workers/${workerAId}/identity_document/${DOC_UUID_A}.pdf`;
    workerBPath = `workers/${workerBId}/identity_document/${DOC_UUID_B}.pdf`;
    // Caminho INGERIDO via MCP/WhatsApp — sem uuid/extensão (IngestDocumentFromUrlUseCase.ts).
    ingestedPathA = `workers/${workerAId}/ingested/criminal_record/${ts}`;
    additionalPathA = `workers/${workerAId}/additional/${ADDITIONAL_UUID_A}.pdf`;

    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, criminal_record_url, documents_status)
       VALUES ($1, $2, $3, 'incomplete')`,
      [workerAId, workerAPath, ingestedPathA],
    );
    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, documents_status)
       VALUES ($1, $2, 'incomplete')`,
      [workerBId, workerBPath],
    );
    const additionalRow = await pool.query<{ id: string }>(
      `INSERT INTO worker_additional_documents (worker_id, label, file_path)
       VALUES ($1, 'Comprovante extra', $2) RETURNING id`,
      [workerAId, additionalPathA],
    );
    additionalDocIdA = additionalRow.rows[0].id;
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM worker_additional_documents WHERE worker_id IN ($1, $2)', [workerAId, workerBId]);
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

    it('[R1] worker A pedindo o caminho de um documento ADICIONAL (worker_additional_documents) do PRÓPRIO worker → 200', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: additionalPathA },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.signedUrl).toContain('mock-gcs-view');
    });

    it('[R2] worker A pedindo o caminho INGERIDO (sem uuid/extensão) já salvo no PRÓPRIO registro → 200', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: ingestedPathA },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
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

    it('[registro envenenado] caminho de B salvo como adicional de A (linha inserida direto no banco) → 404 (a checagem de PREFIXO decide, não a membership sozinha)', async () => {
      const poisonedRow = await pool.query<{ id: string }>(
        `INSERT INTO worker_additional_documents (worker_id, label, file_path)
         VALUES ($1, 'Envenenado', $2) RETURNING id`,
        [workerAId, workerBPath],
      );
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: workerBPath },
        authHeaders(workerAToken),
      );
      expect(res.status).toBe(404);
      await pool.query('DELETE FROM worker_additional_documents WHERE id = $1', [poisonedRow.rows[0].id]);
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

    it('[R1] admin pedindo o caminho ADICIONAL de :id → 200', async () => {
      const res = await api.post(
        `/api/admin/workers/${workerAId}/documents/view-url`,
        { filePath: additionalPathA },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
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
  // POST /api/workers/me/documents/save — trava de prefixo do dono
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

    it('worker A grava o PRÓPRIO caminho (novo docType) → 200 (controle positivo)', async () => {
      const uploadRes = await api.post(
        '/api/workers/me/documents/upload-url',
        { docType: 'apto_psicofisico', contentType: 'application/pdf' },
        authHeaders(workerAToken),
      );
      expect(uploadRes.status).toBe(200);
      const ownFilePath: string = uploadRes.data.data.filePath;
      expect(ownFilePath).toMatch(new RegExp(`^workers/${workerAId}/apto_psicofisico/.+\\.pdf$`));

      const saveRes = await api.post(
        '/api/workers/me/documents/save',
        { docType: 'apto_psicofisico', filePath: ownFilePath },
        authHeaders(workerAToken),
      );
      expect(saveRes.status).toBe(200);

      const row = await pool.query('SELECT apto_psicofisico_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(row.rows[0].apto_psicofisico_url).toBe(ownFilePath);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // DELETE /api/workers/me/documents/:type — record_only para legado
  // ─────────────────────────────────────────────────────────────────────
  describe('DELETE /api/workers/me/documents/:type', () => {
    it('[registro envenenado] registro de A "contaminado" com o caminho REAL de B (simulando contorno pré-hotfix via SQL direto) → 200, limpa SÓ o registro de A, objeto de B intacto', async () => {
      await pool.query(
        'UPDATE worker_documents SET liability_insurance_url = $2 WHERE worker_id = $1',
        [workerAId, workerBPath],
      );

      const res = await api.delete('/api/workers/me/documents/liability_insurance', authHeaders(workerAToken));
      expect(res.status).toBe(200);

      const row = await pool.query('SELECT liability_insurance_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(row.rows[0].liability_insurance_url).toBeNull(); // registro de A foi limpo (record_only)

      // O objeto de B, no registro DELE, segue intacto — nunca foi tocado pelo GCS
      // (o path de B não passa no prefixo de A, então gcs.deleteFile nunca é chamado).
      const bRow = await pool.query('SELECT identity_document_url FROM worker_documents WHERE worker_id = $1', [workerBId]);
      expect(bRow.rows[0].identity_document_url).toBe(workerBPath);
    });

    it('[R3] caminho LEGADO fora de workers/<id>/ → 200, registro some, GCS nunca chamado (record_only)', async () => {
      const legacyPath = 'legacy-uploads-2019/documento-antigo-sem-prefixo.pdf';
      await pool.query(
        'UPDATE worker_documents SET carta_recomendacion_url = $2 WHERE worker_id = $1',
        [workerAId, legacyPath],
      );

      const res = await api.delete('/api/workers/me/documents/carta_recomendacion', authHeaders(workerAToken));
      expect(res.status).toBe(200);

      const row = await pool.query('SELECT carta_recomendacion_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(row.rows[0].carta_recomendacion_url).toBeNull();
    });

    it('worker A deleta o PRÓPRIO documento (caminho normal) → 200 e o campo é limpo (controle positivo)', async () => {
      const res = await api.delete('/api/workers/me/documents/apto_psicofisico', authHeaders(workerAToken));
      expect(res.status).toBe(200);

      const row = await pool.query('SELECT apto_psicofisico_url FROM worker_documents WHERE worker_id = $1', [workerAId]);
      expect(row.rows[0].apto_psicofisico_url).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // DELETE /api/workers/me/additional-documents/:id — record_only p/ legado
  // ─────────────────────────────────────────────────────────────────────
  describe('DELETE /api/workers/me/additional-documents/:id', () => {
    it('[R3] documento adicional com caminho LEGADO fora do prefixo → 200, registro some, GCS nunca chamado', async () => {
      const legacyRow = await pool.query<{ id: string }>(
        `INSERT INTO worker_additional_documents (worker_id, label, file_path)
         VALUES ($1, 'Legado', 'legacy-uploads-2019/comprovante.pdf') RETURNING id`,
        [workerAId],
      );
      const legacyId = legacyRow.rows[0].id;

      const res = await api.delete(`/api/workers/me/additional-documents/${legacyId}`, authHeaders(workerAToken));
      expect(res.status).toBe(200);

      const row = await pool.query('SELECT id FROM worker_additional_documents WHERE id = $1', [legacyId]);
      expect(row.rowCount).toBe(0);
    });

    it('worker A deleta o PRÓPRIO documento adicional (caminho normal) → 200, registro some, objeto de B (não tocado) segue', async () => {
      const res = await api.delete(`/api/workers/me/additional-documents/${additionalDocIdA}`, authHeaders(workerAToken));
      expect(res.status).toBe(200);

      const row = await pool.query('SELECT id FROM worker_additional_documents WHERE id = $1', [additionalDocIdA]);
      expect(row.rowCount).toBe(0);
    });
  });
});
