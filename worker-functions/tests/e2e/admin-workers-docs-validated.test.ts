/**
 * admin-workers-docs-validated.test.ts
 *
 * Testa os filtros docs_validated=all_validated e docs_validated=pending_validation
 * nos endpoints de listagem e export de workers.
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 *
 * Endpoints cobertos:
 *   GET /api/admin/workers?docs_validated=all_validated
 *   GET /api/admin/workers?docs_validated=pending_validation
 *   GET /api/admin/workers/export?docs_validated=all_validated&format=csv&columns=email
 *   GET /api/admin/workers/export?docs_validated=pending_validation&format=csv&columns=email
 *
 * Slugs obrigatórios (migration 212 — verso OPCIONAL):
 *   AT       : identity_document, criminal_record, resume_cv, at_certificate (4 obrigatórios)
 *   Cuidador : identity_document, criminal_record (2 obrigatórios)
 *   NULL     : identity_document, criminal_record (2 obrigatórios)
 *   identity_document_back: OPCIONAL para todos
 *
 * Nota: as fixtures deste teste inserem identity_document_back como slug validado
 * em todos os workers (herdado da migration 207). Isso é inofensivo — um slug
 * extra em document_validations não quebra nenhuma asserção.
 *
 * Cenários all_validated:
 *   1. Worker AT com todos os slugs obrigatórios validados (incluindo back extra) → retornado
 *   2. Worker AT com slugs sem at_certificate → NÃO retornado
 *   3. Worker Cuidador com slugs obrigatórios validados (incluindo back extra) → retornado
 *   4. Worker base (profession = null) com slugs obrigatórios validados → retornado
 *   5. Worker sem linha em worker_documents → NÃO retornado
 *   6. Combinação com case_id → aplica AND corretamente
 *   7. Export também respeita o filtro
 *
 * Cenários pending_validation:
 *   8.  Worker AT sem at_certificate → aparece em pending, NÃO em all_validated
 *   9.  Worker Cuidador sem criminal_record → aparece em pending
 *  10.  Worker sem linha worker_documents → aparece em pending
 *  11.  Worker AT completo → NÃO aparece em pending
 *  12.  Combinação docs_complete=complete AND pending_validation
 *  13.  Export com pending_validation retorna mesmo conjunto da lista
 *
 * Validação de schema:
 *  14. docs_validated=true (valor antigo) → 400 Bad Request
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * Slugs para AT: 4 obrigatórios (migration 212 — verso OPCIONAL).
 * identity_document_back mantido COMO SLUG EXTRA na fixture — é inofensivo
 * (documenta que o verso pode ser validado mesmo sendo opcional).
 * Apenas criminal_record + identity_document + resume_cv + at_certificate são exigidos.
 */
const AT_ALL_SLUGS = [
  'identity_document',
  'identity_document_back', // opcional desde mig 212 — extra na fixture
  'criminal_record',
  'resume_cv',
  'at_certificate',
];

/**
 * Slugs para não-AT / NULL: 2 obrigatórios (migration 212 — verso OPCIONAL).
 * identity_document_back mantido COMO SLUG EXTRA na fixture — inofensivo.
 * Apenas criminal_record + identity_document são exigidos.
 */
const BASE_SLUGS = [
  'identity_document',
  'identity_document_back', // opcional desde mig 212 — extra na fixture
  'criminal_record',
];

/** identity_document + identity_document_back (falta criminal_record). Simula Cuidador incompleto. */
const BASE_TWO_SLUGS = BASE_SLUGS.filter((s) => s !== 'criminal_record');

/** Build a JSONB-compatible object where each slug maps to a minimal validation entry. */
function makeValidations(slugs: string[]): Record<string, unknown> {
  return Object.fromEntries(
    slugs.map((s) => [s, { validated_by: 'test@e2e.local', validated_at: new Date().toISOString() }]),
  );
}

describe('docs_validated filter — list and export', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;

  // Worker IDs seeded for this suite
  let atFullId: string;         // AT with 4+1 slugs (verso extra) — all_validated: YES, pending: NO
  let atMissingId: string;      // AT missing at_certificate — all_validated: NO, pending: YES
  let cuidadorFullId: string;   // Cuidador with 2+1 slugs (verso extra) — all_validated: YES, pending: NO
  let baseFullId: string;       // profession=null with 2+1 slugs (verso extra) — all_validated: YES, pending: NO
  let baseMissingId: string;    // profession=null with identity_document+back, missing criminal_record — all_validated: NO, pending: YES
  let noDocsId: string;         // no worker_documents row — all_validated: NO, pending: YES

  // Unique emails so we can verify presence/absence in CSV body
  const ts = Date.now();
  const atFullEmail = `dv-at-full-${ts}@e2e.local`;
  const atMissingEmail = `dv-at-missing-${ts}@e2e.local`;
  const cuidadorFullEmail = `dv-cuidador-full-${ts}@e2e.local`;
  const baseFullEmail = `dv-base-full-${ts}@e2e.local`;
  const baseMissingEmail = `dv-base-missing-${ts}@e2e.local`;
  const noDocsEmail = `dv-no-docs-${ts}@e2e.local`;

  beforeAll(async () => {
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'dv-admin-e2e',
      email: 'dv-admin@e2e.local',
      role: 'admin',
    });

    pool = new Pool({ connectionString: DATABASE_URL });

    // 1. AT worker — 4 required slugs + back (opcional, extra na fixture — mig 212)
    const r1 = await pool.query(
      `INSERT INTO workers (auth_uid, email, profession, status)
       VALUES ($1, $2, 'AT', 'REGISTERED') RETURNING id`,
      [`dv-at-full-${ts}`, atFullEmail],
    );
    atFullId = r1.rows[0].id;
    await pool.query(
      `INSERT INTO worker_documents (worker_id, document_validations)
       VALUES ($1, $2::jsonb)`,
      [atFullId, JSON.stringify(makeValidations(AT_ALL_SLUGS))],
    );

    // 2. AT worker — 4 slugs (missing at_certificate)
    const r2 = await pool.query(
      `INSERT INTO workers (auth_uid, email, profession, status)
       VALUES ($1, $2, 'AT', 'REGISTERED') RETURNING id`,
      [`dv-at-missing-${ts}`, atMissingEmail],
    );
    atMissingId = r2.rows[0].id;
    const atFourSlugs = AT_ALL_SLUGS.filter((s) => s !== 'at_certificate');
    await pool.query(
      `INSERT INTO worker_documents (worker_id, document_validations)
       VALUES ($1, $2::jsonb)`,
      [atMissingId, JSON.stringify(makeValidations(atFourSlugs))],
    );

    // 3. Cuidador (profession != 'AT') — 2 obrigatórios + verso extra (mig 212)
    // ClickUp: "Cuidador" → canonical UPPERCASE EN: 'CAREGIVER'
    const r3 = await pool.query(
      `INSERT INTO workers (auth_uid, email, profession, status)
       VALUES ($1, $2, 'CAREGIVER', 'REGISTERED') RETURNING id`,
      [`dv-cuidador-full-${ts}`, cuidadorFullEmail],
    );
    cuidadorFullId = r3.rows[0].id;
    await pool.query(
      `INSERT INTO worker_documents (worker_id, document_validations)
       VALUES ($1, $2::jsonb)`,
      [cuidadorFullId, JSON.stringify(makeValidations(BASE_SLUGS))],
    );

    // 4. Base worker (profession = null) — 2 obrigatórios + verso extra (mig 212)
    const r4 = await pool.query(
      `INSERT INTO workers (auth_uid, email, profession, status)
       VALUES ($1, $2, NULL, 'REGISTERED') RETURNING id`,
      [`dv-base-full-${ts}`, baseFullEmail],
    );
    baseFullId = r4.rows[0].id;
    await pool.query(
      `INSERT INTO worker_documents (worker_id, document_validations)
       VALUES ($1, $2::jsonb)`,
      [baseFullId, JSON.stringify(makeValidations(BASE_SLUGS))],
    );

    // 5. Base worker — identity_document + back (verso extra), falta criminal_record
    const r5 = await pool.query(
      `INSERT INTO workers (auth_uid, email, profession, status)
       VALUES ($1, $2, NULL, 'REGISTERED') RETURNING id`,
      [`dv-base-missing-${ts}`, baseMissingEmail],
    );
    baseMissingId = r5.rows[0].id;
    await pool.query(
      `INSERT INTO worker_documents (worker_id, document_validations)
       VALUES ($1, $2::jsonb)`,
      [baseMissingId, JSON.stringify(makeValidations(BASE_TWO_SLUGS))],
    );

    // 6. Worker without any worker_documents row
    const r6 = await pool.query(
      `INSERT INTO workers (auth_uid, email, profession, status)
       VALUES ($1, $2, NULL, 'REGISTERED') RETURNING id`,
      [`dv-no-docs-${ts}`, noDocsEmail],
    );
    noDocsId = r6.rows[0].id;
    // Intentionally no worker_documents insert
  });

  afterAll(async () => {
    if (!pool) return;
    const ids = [atFullId, atMissingId, cuidadorFullId, baseFullId, baseMissingId, noDocsId].filter(Boolean);
    for (const id of ids) {
      await pool.query('DELETE FROM worker_documents WHERE worker_id = $1', [id]);
      await pool.query('DELETE FROM workers WHERE id = $1', [id]);
    }
    await pool.end();
  });

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // ── Helper: collect IDs returned by the list endpoint ──────────────────────
  async function listWithFilter(docsValidated: string, extra = ''): Promise<string[]> {
    const res = await api.get(
      `/api/admin/workers?docs_validated=${docsValidated}&limit=1000${extra}`,
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    return (res.data.data as { id: string }[]).map((w) => w.id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Bloco A — all_validated
  // ═══════════════════════════════════════════════════════════════════════════

  describe('docs_validated=all_validated', () => {
    // ── 1. AT worker with all 5 slugs → INCLUDED ─────────────────────────────
    it('AT worker com todas as 5 chaves validadas é retornado', async () => {
      const ids = await listWithFilter('all_validated');
      expect(ids).toContain(atFullId);
    });

    // ── 2. AT worker missing at_certificate → EXCLUDED ───────────────────────
    it('AT worker sem at_certificate NÃO é retornado', async () => {
      const ids = await listWithFilter('all_validated');
      expect(ids).not.toContain(atMissingId);
    });

    // ── 3. Cuidador with required slugs (+ back extra) → INCLUDED ────────────
    it('Worker Cuidador com as 3 chaves base validadas é retornado', async () => {
      const ids = await listWithFilter('all_validated');
      expect(ids).toContain(cuidadorFullId);
    });

    // ── 4. Base worker (profession = null) with 3 slugs → INCLUDED ───────────
    it('Worker base (profession=null) com as 3 chaves validadas é retornado', async () => {
      const ids = await listWithFilter('all_validated');
      expect(ids).toContain(baseFullId);
    });

    // ── 5. Worker without worker_documents row → EXCLUDED ────────────────────
    it('Worker sem linha em worker_documents NÃO é retornado', async () => {
      const ids = await listWithFilter('all_validated');
      expect(ids).not.toContain(noDocsId);
    });

    // ── 6. Combination with case_id filter ────────────────────────────────────
    it('combinação com case_id inexistente retorna lista vazia (AND aplicado corretamente)', async () => {
      const fakeUuid = '00000000-0000-0000-0000-000000000000';
      const ids = await listWithFilter('all_validated', `&case_id=${fakeUuid}`);
      expect(ids).not.toContain(atFullId);
      expect(ids).not.toContain(baseFullId);
      expect(ids).not.toContain(cuidadorFullId);
    });

    // ── 7. Export endpoint — docs_validated=all_validated ─────────────────────
    describe('GET /api/admin/workers/export?docs_validated=all_validated', () => {
      it('CSV inclui worker AT completo, Cuidador completo e worker base completo', async () => {
        const res = await api.get(
          '/api/admin/workers/export?format=csv&columns=email&docs_validated=all_validated',
          { ...authHeaders(adminToken), responseType: 'text' },
        );
        expect(res.status).toBe(200);
        const body = res.data as string;
        expect(body).toContain(atFullEmail);
        expect(body).toContain(cuidadorFullEmail);
        expect(body).toContain(baseFullEmail);
      });

      it('CSV NÃO inclui AT com chave faltando', async () => {
        const res = await api.get(
          '/api/admin/workers/export?format=csv&columns=email&docs_validated=all_validated',
          { ...authHeaders(adminToken), responseType: 'text' },
        );
        expect(res.status).toBe(200);
        expect(res.data as string).not.toContain(atMissingEmail);
      });

      it('CSV NÃO inclui worker sem linha em worker_documents', async () => {
        const res = await api.get(
          '/api/admin/workers/export?format=csv&columns=email&docs_validated=all_validated',
          { ...authHeaders(adminToken), responseType: 'text' },
        );
        expect(res.status).toBe(200);
        expect(res.data as string).not.toContain(noDocsEmail);
      });

      it('resultados do export batem com a lista (mesmos IDs)', async () => {
        const listIds = await listWithFilter('all_validated');
        const ourIds = new Set([atFullId, atMissingId, cuidadorFullId, baseFullId, baseMissingId, noDocsId]);
        const relevantFromList = listIds.filter((id) => ourIds.has(id)).sort();

        const res = await api.get(
          '/api/admin/workers/export?format=csv&columns=email&docs_validated=all_validated',
          { ...authHeaders(adminToken), responseType: 'text' },
        );
        expect(res.status).toBe(200);
        const body = res.data as string;

        const inExport = (email: string) => body.includes(email);

        if (relevantFromList.includes(atFullId)) expect(inExport(atFullEmail)).toBe(true);
        if (!relevantFromList.includes(atMissingId)) expect(inExport(atMissingEmail)).toBe(false);
        if (relevantFromList.includes(cuidadorFullId)) expect(inExport(cuidadorFullEmail)).toBe(true);
        if (relevantFromList.includes(baseFullId)) expect(inExport(baseFullEmail)).toBe(true);
        if (!relevantFromList.includes(noDocsId)) expect(inExport(noDocsEmail)).toBe(false);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Bloco B — pending_validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('docs_validated=pending_validation', () => {
    // ── 8. AT worker sem at_certificate → aparece em pending, NÃO em all_validated ─
    it('AT worker com 4/5 slugs aparece em pending_validation', async () => {
      const ids = await listWithFilter('pending_validation');
      expect(ids).toContain(atMissingId);
    });

    it('AT worker com 4/5 slugs NÃO aparece em all_validated', async () => {
      const ids = await listWithFilter('all_validated');
      expect(ids).not.toContain(atMissingId);
    });

    // ── 9. Worker base com 2/3 slugs → aparece em pending ────────────────────
    it('Worker base sem criminal_record aparece em pending_validation', async () => {
      const ids = await listWithFilter('pending_validation');
      expect(ids).toContain(baseMissingId);
    });

    // ── 10. Worker sem linha worker_documents → aparece em pending ─────────────
    it('Worker sem linha em worker_documents aparece em pending_validation', async () => {
      const ids = await listWithFilter('pending_validation');
      expect(ids).toContain(noDocsId);
    });

    // ── 11. AT completo (todos obrigatórios + verso extra) → NÃO aparece em pending ─
    it('AT worker completo (5/5) NÃO aparece em pending_validation', async () => {
      const ids = await listWithFilter('pending_validation');
      expect(ids).not.toContain(atFullId);
    });

    // ── 12. docs_complete=complete AND pending_validation ─────────────────────
    it('combinação docs_complete=complete AND pending_validation retorna cadastros completos com validação pendente', async () => {
      // atMissingId and baseMissingId have status=REGISTERED (docs_complete=complete)
      // but are missing required slugs (pending_validation).
      const res = await api.get(
        '/api/admin/workers?docs_complete=complete&docs_validated=pending_validation&limit=1000',
        authHeaders(adminToken),
      );
      expect(res.status).toBe(200);
      const ids = (res.data.data as { id: string }[]).map((w) => w.id);
      expect(ids).toContain(atMissingId);
      expect(ids).toContain(baseMissingId);
      // fully validated workers must NOT appear
      expect(ids).not.toContain(atFullId);
      expect(ids).not.toContain(baseFullId);
      expect(ids).not.toContain(cuidadorFullId);
    });

    // ── 13. Export com pending_validation bate com a lista ────────────────────
    describe('GET /api/admin/workers/export?docs_validated=pending_validation', () => {
      it('CSV inclui workers com validação pendente', async () => {
        const res = await api.get(
          '/api/admin/workers/export?format=csv&columns=email&docs_validated=pending_validation',
          { ...authHeaders(adminToken), responseType: 'text' },
        );
        expect(res.status).toBe(200);
        const body = res.data as string;
        expect(body).toContain(atMissingEmail);
        expect(body).toContain(baseMissingEmail);
        expect(body).toContain(noDocsEmail);
      });

      it('CSV NÃO inclui workers com validação completa', async () => {
        const res = await api.get(
          '/api/admin/workers/export?format=csv&columns=email&docs_validated=pending_validation',
          { ...authHeaders(adminToken), responseType: 'text' },
        );
        expect(res.status).toBe(200);
        const body = res.data as string;
        expect(body).not.toContain(atFullEmail);
        expect(body).not.toContain(cuidadorFullEmail);
        expect(body).not.toContain(baseFullEmail);
      });

      it('resultados do export batem com a lista pending_validation', async () => {
        const listIds = await listWithFilter('pending_validation');
        const ourIds = new Set([atFullId, atMissingId, cuidadorFullId, baseFullId, baseMissingId, noDocsId]);
        const relevantFromList = listIds.filter((id) => ourIds.has(id));

        const res = await api.get(
          '/api/admin/workers/export?format=csv&columns=email&docs_validated=pending_validation',
          { ...authHeaders(adminToken), responseType: 'text' },
        );
        expect(res.status).toBe(200);
        const body = res.data as string;

        const inExport = (email: string) => body.includes(email);

        // pending workers must appear in both list and export
        if (relevantFromList.includes(atMissingId)) expect(inExport(atMissingEmail)).toBe(true);
        if (relevantFromList.includes(baseMissingId)) expect(inExport(baseMissingEmail)).toBe(true);
        if (relevantFromList.includes(noDocsId)) expect(inExport(noDocsEmail)).toBe(true);
        // validated workers must appear in neither
        if (!relevantFromList.includes(atFullId)) expect(inExport(atFullEmail)).toBe(false);
        if (!relevantFromList.includes(cuidadorFullId)) expect(inExport(cuidadorFullEmail)).toBe(false);
        if (!relevantFromList.includes(baseFullId)) expect(inExport(baseFullEmail)).toBe(false);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Bloco C — validação de schema (valor inválido)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('validação de schema', () => {
    // ── 13. docs_validated=true (valor legado) → 400 ──────────────────────────
    it('docs_validated=true retorna 400 Bad Request', async () => {
      const res = await api.get(
        '/api/admin/workers?docs_validated=true',
        { ...authHeaders(adminToken), validateStatus: () => true },
      );
      expect(res.status).toBe(400);
    });

    it('docs_validated=invalid retorna 400 Bad Request', async () => {
      const res = await api.get(
        '/api/admin/workers?docs_validated=invalid',
        { ...authHeaders(adminToken), validateStatus: () => true },
      );
      expect(res.status).toBe(400);
    });

    it('export com docs_validated=true retorna 400 Bad Request', async () => {
      const res = await api.get(
        '/api/admin/workers/export?format=csv&columns=email&docs_validated=true',
        { ...authHeaders(adminToken), validateStatus: () => true, responseType: 'json' },
      );
      expect(res.status).toBe(400);
    });
  });
});
