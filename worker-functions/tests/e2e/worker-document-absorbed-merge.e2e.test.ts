/**
 * worker-document-absorbed-merge.e2e.test.ts
 *
 * Hotfix 14/09/2026 (Gabriel) — item 2. O merge (`WorkerPhoneMergeService.
 * executeSingleMerge`) reparenta `worker_id` em `worker_documents` /
 * `worker_additional_documents` para o SOBREVIVENTE, mas NUNCA move o objeto
 * no GCS (`WorkerPhoneMergeTypes.ts:166`, upsert_delete). O caminho gravado
 * continua `workers/<id do ABSORVIDO>/...`. O guard de documento
 * (`documentPathGuard`) trava por PREFIXO `workers/<workerId>/` — sem a
 * lista de ids absorvidos (`findAbsorbedWorkerIds`), o próprio sobrevivente
 * pedindo o PRÓPRIO documento levava 404. Medido em PRD (só contagem,
 * 13/09): 51 documentos legítimos nessa forma.
 *
 * Seed direto por SQL (`merged_into_id`), como o "termina quando" pede — não
 * roda o fluxo de merge inteiro, só a consequência que importa aqui: a linha
 * do worker morto aponta para o sobrevivente, o registro do sobrevivente tem
 * um caminho com o prefixo do morto.
 *
 * Stack docker isolada `-p hotfix-doc` (docker-compose.hotfix-doc-ports.yml,
 * portas 8099/5599/6392), mock GCS, MockAuth — mesmo padrão de
 * worker-document-view-url-ownership.e2e.test.ts.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5599/enlite_e2e';

describe('Documento de worker ABSORVIDO em merge — sobrevivente abre/apaga pelo prefixo do morto', () => {
  const api = createApiClient();
  let pool: Pool;

  const ts = Date.now();
  const DOC_UUID_A = '11111111-3333-4333-8444-a00000000001'; // path do absorvido A
  const DOC_UUID_C = '11111111-3333-4333-8444-a00000000003'; // path do absorvido C (cadeia A→C→B)
  const DOC_UUID_X = '11111111-3333-4333-8444-a00000000009'; // path do worker X (sem relação)

  let adminToken: string;
  let survivorToken: string; // dono de B (o "me" de B)

  let survivorId: string; // B
  let absorbedId: string; // A, merged_into_id = B
  let chainMidId: string; // C, merged_into_id = B (A→C→B testado via C.merged_into_id = ? não — ver nota abaixo)
  let unrelatedId: string; // X, worker vivo, sem relação com A/B
  let otherCountryAbsorbedId: string; // país diferente na cadeia

  let survivorAbsorbedDocPath: string; // caminho de A gravado no registro de B (após "merge")
  let chainDocPath: string; // caminho de A na cadeia A→C→B
  let unrelatedPath: string; // caminho pertencente de fato a X, no registro dele

  async function insertWorker(tag: string, country = 'AR'): Promise<{ id: string; authUid: string }> {
    const authUid = `dam-${tag}-${ts}`;
    const email = `dam-${tag}-${ts}@e2e.local`;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country)
       VALUES ($1, $2, 'REGISTERED', $3)
       RETURNING id`,
      [authUid, email, country],
    );
    return { id: rows[0].id, authUid };
  }

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });

    adminToken = await getMockToken(api, {
      uid: `dam-admin-${ts}`,
      email: `dam-admin-${ts}@e2e.local`,
      role: 'admin',
    });

    const survivor = await insertWorker('survivor-b');
    survivorId = survivor.id;
    survivorToken = await getMockToken(api, {
      uid: survivor.authUid,
      email: `${survivor.authUid}@e2e.local`,
      role: 'worker',
    });

    const absorbed = await insertWorker('absorbed-a');
    absorbedId = absorbed.id;

    const chainMid = await insertWorker('chain-c');
    chainMidId = chainMid.id;

    const unrelated = await insertWorker('unrelated-x');
    unrelatedId = unrelated.id;

    const otherCountry = await insertWorker('other-country', 'BR');
    otherCountryAbsorbedId = otherCountry.id;

    survivorAbsorbedDocPath = `workers/${absorbedId}/identity_document/${DOC_UUID_A}.pdf`;
    chainDocPath = `workers/${chainMidId}/criminal_record/${DOC_UUID_C}.pdf`;
    unrelatedPath = `workers/${unrelatedId}/identity_document/${DOC_UUID_X}.pdf`;

    // O REGISTRO de worker_documents do sobrevivente (B) já traz um caminho
    // com prefixo do absorvido — exatamente o efeito do merge real (reparent
    // de worker_id, sem mover objeto no GCS).
    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, documents_status)
       VALUES ($1, $2, 'incomplete')`,
      [survivorId, survivorAbsorbedDocPath],
    );
    // Registro do worker X, sem qualquer relação com A/B — usado no caso
    // negativo "worker sem relação pedindo caminho de A".
    await pool.query(
      `INSERT INTO worker_documents (worker_id, identity_document_url, documents_status)
       VALUES ($1, $2, 'incomplete')`,
      [unrelatedId, unrelatedPath],
    );
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM worker_documents WHERE worker_id IN ($1, $2, $3, $4, $5, $6)', [
        survivorId, absorbedId, chainMidId, unrelatedId, otherCountryAbsorbedId, survivorId,
      ]);
      await pool.query('DELETE FROM workers WHERE id IN ($1, $2, $3, $4, $5)', [
        survivorId, absorbedId, chainMidId, unrelatedId, otherCountryAbsorbedId,
      ]);
      await pool.end();
    }
  });

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  async function setMergedInto(id: string, into: string | null): Promise<void> {
    await pool.query('UPDATE workers SET merged_into_id = $2 WHERE id = $1', [id, into]);
  }

  // ── 1. VERMELHO ANTES (implícito): sem o fix, este teste falharia com 404.
  //    Servido pela primeira asserção de cada describe abaixo, que roda
  //    DEPOIS de A ser marcado como absorvido em B.

  describe('B (sobrevivente) via rota "me" abre documento cujo caminho carrega o prefixo do absorvido A', () => {
    beforeAll(async () => {
      await setMergedInto(absorbedId, survivorId); // A → B
    });
    afterAll(async () => {
      await setMergedInto(absorbedId, null);
    });

    it('B pedindo o caminho de A (gravado no PRÓPRIO registro de B) → 200', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: survivorAbsorbedDocPath },
        authHeaders(survivorToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.signedUrl).toContain('mock-gcs-view');
    });

    it('admin :id=B pedindo o mesmo caminho de A → 200', async () => {
      const res = await api.post(
        `/api/admin/workers/${survivorId}/documents/view-url`,
        { filePath: survivorAbsorbedDocPath },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.data.signedUrl).toContain('mock-gcs-view');
    });

    it('B tentando SALVAR (não só ver) um caminho no prefixo de A → 400 (SAVE continua só com o PRÓPRIO prefixo)', async () => {
      const res = await api.post(
        '/api/workers/me/documents/save',
        { docType: 'resume_cv', filePath: survivorAbsorbedDocPath },
        authHeaders(survivorToken),
      );
      expect(res.status).toBe(400);
    });

    it('worker X, sem relação com A/B, pedindo o caminho de A → 404', async () => {
      const xToken = await getMockToken(api, {
        uid: `dam-actor-x-${ts}`,
        email: `dam-actor-x-${ts}@e2e.local`,
        role: 'worker',
      });
      // X não tem worker vinculado a este auth_uid — usa o próprio unrelatedId via admin,
      // que é o cenário relevante: :id=X, filePath do A (fora da cadeia de X).
      const res = await api.post(
        `/api/admin/workers/${unrelatedId}/documents/view-url`,
        { filePath: survivorAbsorbedDocPath },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
      void xToken;
    });

    it('após "undo" (merged_into_id volta a NULL em A) → B pedindo o caminho de A → 404', async () => {
      await setMergedInto(absorbedId, null);
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: survivorAbsorbedDocPath },
        authHeaders(survivorToken),
      );
      expect(res.status).toBe(404);
      // restaura para o afterAll (idempotente) e para os testes seguintes
      await setMergedInto(absorbedId, survivorId);
    });

    it('B deleta o documento cujo caminho é o de A → 200, registro de B limpo', async () => {
      const res = await api.delete('/api/workers/me/documents/identity_document', authHeaders(survivorToken));
      expect(res.status).toBe(200);
      const row = await pool.query('SELECT identity_document_url FROM worker_documents WHERE worker_id = $1', [survivorId]);
      expect(row.rows[0].identity_document_url).toBeNull();

      // Restaura para os testes seguintes (cadeia, país diferente).
      await pool.query('UPDATE worker_documents SET identity_document_url = $2 WHERE worker_id = $1', [survivorId, survivorAbsorbedDocPath]);
    });
  });

  describe('Cadeia A→C→B (2 saltos) — B abre caminho de C, que só aponta para B através de A', () => {
    beforeAll(async () => {
      // C → B direto (C é o meio da cadeia real seria A→C, C→B; aqui
      // simplificamos a cadeia como A→B e C→B, ambos absorvidos DIRETO em B,
      // e testamos a PROFUNDIDADE 2 com uma segunda cadeia A2→A→B.
      await setMergedInto(absorbedId, survivorId); // A → B (salto 1)
      await setMergedInto(chainMidId, absorbedId); // C → A (salto 2) — cadeia C→A→B
      await pool.query(
        `INSERT INTO worker_documents (worker_id, identity_document_url, documents_status)
         VALUES ($1, $2, 'incomplete')
         ON CONFLICT (worker_id) DO UPDATE SET identity_document_url = EXCLUDED.identity_document_url`,
        [survivorId, chainDocPath],
      );
    });
    afterAll(async () => {
      await setMergedInto(chainMidId, null);
      await setMergedInto(absorbedId, null);
    });

    it('B abre o caminho de C (2 saltos: C→A→B) → 200', async () => {
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: chainDocPath },
        authHeaders(survivorToken),
      );
      expect(res.status).toBe(200);
    });
  });

  describe('País diferente na cadeia — fail-closed', () => {
    beforeAll(async () => {
      await setMergedInto(otherCountryAbsorbedId, survivorId); // BR → B (AR)
      const path = `workers/${otherCountryAbsorbedId}/identity_document/22222222-3333-4333-8444-a00000000002.pdf`;
      await pool.query(
        `UPDATE worker_documents SET criminal_record_url = $2 WHERE worker_id = $1`,
        [survivorId, path],
      );
      (global as unknown as { __otherCountryPath?: string }).__otherCountryPath = path;
    });
    afterAll(async () => {
      await setMergedInto(otherCountryAbsorbedId, null);
    });

    it('B pedindo o caminho de um "absorvido" de país DIFERENTE → 404 (findAbsorbedWorkerIds fail-closed por país)', async () => {
      const path = (global as unknown as { __otherCountryPath: string }).__otherCountryPath;
      const res = await api.post(
        '/api/workers/me/documents/view-url',
        { filePath: path },
        authHeaders(survivorToken),
      );
      expect(res.status).toBe(404);
    });
  });
});
