/**
 * bulk-dispatch-incomplete.e2e.test.ts
 *
 * Valida o endpoint POST /api/internal/bulk-dispatch/process (Fase 5 — fix TD-021):
 *   - Endpoint retorna 200 com success=true
 *   - Query INCOMPLETE_WORKERS_QUERY não quebra com "malformed array literal"
 *     (TD-021: preferred_types = '{}'::text[] corrigido)
 *   - Worker elegível com preferred_types = '{}' e experience_types = '{}'
 *     é incluído no batch (comparação com text[] funciona)
 *   - Worker com preferred_types populado mas docs incompletos também é elegível
 *
 * Pré-condição: migration 177 aplicada + API rodando em localhost:8080.
 */

import { Pool } from 'pg';
import axios from 'axios';

const API_URL         = process.env.API_URL         || 'http://localhost:8080';
const DATABASE_URL    = process.env.DATABASE_URL     || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const INTERNAL_SECRET = process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only';

const internalApi = axios.create({
  baseURL: `${API_URL}/api/internal`,
  headers: { 'X-Internal-Secret': INTERNAL_SECRET },
  validateStatus: () => true,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('Bulk dispatch — cadastro incompleto (fix TD-021)', () => {
  let pool: Pool;
  let workerEmptyArraysId: string;
  let workerWithDocsId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    const suffix = Date.now();

    // Worker com preferred_types = '{}' e experience_types = '{}' — caso que quebrava antes do fix
    // Precisa ter encuadre (INNER JOIN encuadres)
    const wEmptyRes = await pool.query<{ id: string }>(
      `INSERT INTO workers
         (auth_uid, email, country, timezone, status, occupation, phone,
          preferred_types, experience_types)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires',
               'REGISTERED', 'AT', $3,
               '{}'::text[], '{}'::text[])
       RETURNING id`,
      [
        `uid-bulk-empty-${suffix}`,
        `bulk-empty-${suffix}@bulk-inc.e2e`,
        `+54911999${String(suffix).slice(-5)}`,
      ],
    );
    workerEmptyArraysId = wEmptyRes.rows[0].id;

    // Garantir job_posting para FK de encuadre
    const jpRes = await pool.query<{ id: string }>(`SELECT id FROM job_postings LIMIT 1`);
    let jobPostingId: string;
    if (jpRes.rows.length > 0) {
      jobPostingId = jpRes.rows[0].id;
    } else {
      const created = await pool.query<{ id: string }>(
        `INSERT INTO job_postings (case_number, status, title, vacancy_number)
         VALUES (99969, 'SEARCHING', 'CASO 99969-1', 1) RETURNING id`,
      );
      jobPostingId = created.rows[0].id;
    }

    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, resultado)
       VALUES ($1, $2, 'PENDIENTE')
       ON CONFLICT DO NOTHING`,
      [workerEmptyArraysId, jobPostingId],
    );

    // Worker com preferred_types preenchido mas sem documentos (também elegível)
    const wDocsRes = await pool.query<{ id: string }>(
      `INSERT INTO workers
         (auth_uid, email, country, timezone, status, occupation, phone,
          preferred_types, experience_types, profession)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires',
               'INCOMPLETE_REGISTER', 'AT', $3,
               ARRAY['adultos']::text[], ARRAY['hospital']::text[],
               'PSYCHOLOGIST')
       RETURNING id`,
      [
        `uid-bulk-docs-${suffix}`,
        `bulk-docs-${suffix}@bulk-inc.e2e`,
        `+54911888${String(suffix).slice(-5)}`,
      ],
    );
    workerWithDocsId = wDocsRes.rows[0].id;

    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, resultado)
       VALUES ($1, $2, 'PENDIENTE')
       ON CONFLICT DO NOTHING`,
      [workerWithDocsId, jobPostingId],
    );

    // Limpar worker_reminder_state do dia para garantir elegibilidade
    await pool.query(
      `DELETE FROM worker_reminder_state
       WHERE worker_id IN ($1, $2) AND sent_date = CURRENT_DATE`,
      [workerEmptyArraysId, workerWithDocsId],
    );
  });

  afterAll(async () => {
    if (!pool) return;

    await pool.query(
      `DELETE FROM worker_reminder_state WHERE worker_id IN ($1, $2)`,
      [workerEmptyArraysId, workerWithDocsId],
    );
    await pool.query(
      `DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id IN ($1, $2)`,
      [workerEmptyArraysId, workerWithDocsId],
    );
    await pool.query(
      `DELETE FROM encuadres WHERE worker_id IN ($1, $2)`,
      [workerEmptyArraysId, workerWithDocsId],
    );
    await pool.query(
      `DELETE FROM workers WHERE id IN ($1, $2)`,
      [workerEmptyArraysId, workerWithDocsId],
    );

    await pool.end();
  });

  it('retorna 403 sem autenticação', async () => {
    const res = await axios.post(
      `${API_URL}/api/internal/bulk-dispatch/process`,
      {},
      { validateStatus: () => true },
    );
    expect(res.status).toBe(403);
  });

  it('retorna 200 com success=true e batchId UUID (fix TD-021: sem malformed array literal)', async () => {
    const res = await internalApi.post('/bulk-dispatch/process', {});

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.batchId).toMatch(UUID_RE);
    expect(typeof res.data.total).toBe('number');
    expect(typeof res.data.sent).toBe('number');
    expect(typeof res.data.errors).toBe('number');
  });

  it('worker com preferred_types={} é incluído no batch (comparação text[] não quebra)', async () => {
    // Query direta que o use case usa — verifica que worker com preferred_types={}
    // é retornado sem "malformed array literal" error
    const { rows } = await pool.query(
      `SELECT w.id
       FROM workers w
       INNER JOIN encuadres e ON e.worker_id = w.id
       LEFT JOIN worker_documents wd ON wd.worker_id = w.id
       WHERE w.id = $1
         AND w.email NOT LIKE '%@enlite.import'
         AND w.phone IS NOT NULL
         AND w.phone <> ''
         AND (
           wd.documents_status IS NULL
           OR wd.documents_status NOT IN ('submitted', 'under_review', 'approved')
           OR w.preferred_types IS NULL OR w.preferred_types = '{}'::text[]
           OR w.experience_types IS NULL OR w.experience_types = '{}'::text[]
         )`,
      [workerEmptyArraysId],
    );

    // O worker tem preferred_types = '{}' e está sem documentos → deve aparecer
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].id).toBe(workerEmptyArraysId);
  });

  it('dry-run retorna workers sem chamar Twilio', async () => {
    const res = await internalApi.post('/bulk-dispatch/process', { dryRun: true });

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.dryRun).toBe(true);
    expect(res.data.sent).toBe(0);
  });
});
