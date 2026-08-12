/**
 * phase5-encuadres-unique-constraint.e2e.test.ts — E2E Tests (DB-level)
 *
 * Valida a invariante da Fase F5 (ADR-001):
 * "encuadres tem UNIQUE (worker_id, job_posting_id) — 1 encuadre por par"
 *
 * Migrations cobertas:
 *   192 — consolidação de duplicatas históricas
 *   193 — ADD CONSTRAINT encuadres_worker_job_unique UNIQUE (worker_id, job_posting_id)
 *          + atualiza trigger fn_ensure_encuadre_on_wja_insert para ON CONFLICT (worker_id, job_posting_id)
 *
 * Testes:
 *   F5-1 — Segundo INSERT com mesmo par (worker_id, job_posting_id) e dedup_hash diferente
 *           deve falhar OU silenciar via ON CONFLICT (worker_id, job_posting_id) DO NOTHING
 *   F5-2 — Upsert via ON CONFLICT (worker_id, job_posting_id) atualiza o sobrevivente
 *   F5-3 — Trigger fn_ensure_encuadre_on_wja_insert não cria duplicata quando encuadre já existe
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Fixture IDs determinísticos (prefix f5e para evitar colisão) ──────────────

const IDS = {
  patient:   'f5e00001-0000-4000-a001-000000000001',
  vacancy:   'f5e00001-0000-4000-a002-000000000001',
  workerA:   'f5e00001-0000-4000-a003-000000000001', // F5-1 & F5-3
  workerB:   'f5e00001-0000-4000-a003-000000000002', // F5-2 (upsert update)
  workerC:   'f5e00001-0000-4000-a003-000000000003', // F5-3 (trigger)
};

describe('F5 — Invariante UNIQUE (worker_id, job_posting_id) em encuadres (ADR-001)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await seedFixtures(pool);
  });

  afterAll(async () => {
    await cleanFixtures(pool);
    await pool.end();
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // F5-1 — Segundo INSERT com mesmo par e dedup_hash diferente deve ser silenciado
  // ══════════════════════════════════════════════════════════════════════════════

  it('[F5-1] Segundo INSERT com mesmo (worker_id, job_posting_id) e dedup_hash distinto é silenciado via ON CONFLICT DO NOTHING', async () => {
    // workerA já tem encuadre criado no seed com dedup_hash-A
    const initial = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.workerA, IDS.vacancy],
    );
    expect(initial.rows[0].cnt).toBe(1);

    // Tentar inserir segundo encuadre com dedup_hash diferente para o mesmo par
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
       VALUES ($1, $2, 'second-attempt', md5('second-attempt|' || $1::uuid::text || '|' || $2::uuid::text))
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [IDS.workerA, IDS.vacancy],
    );

    // Deve continuar com exatamente 1 encuadre
    const after = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.workerA, IDS.vacancy],
    );
    expect(after.rows[0].cnt).toBe(1);
  });

  it('[F5-1b] INSERT sem ON CONFLICT e com mesmo par viola constraint (unique violation)', async () => {
    // Confirma que a constraint está ativa: INSERT sem ON CONFLICT deve lançar erro
    await expect(
      pool.query(
        `INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
         VALUES ($1, $2, 'raw-insert', md5('raw-insert|' || $1::uuid::text || '|' || $2::uuid::text))`,
        [IDS.workerA, IDS.vacancy],
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // F5-2 — Upsert via ON CONFLICT (worker_id, job_posting_id) atualiza o sobrevivente
  // ══════════════════════════════════════════════════════════════════════════════

  it('[F5-2] Upsert via ON CONFLICT (worker_id, job_posting_id) atualiza campos sem criar linha nova', async () => {
    // workerB tem encuadre existente sem resultado
    const before = await pool.query(
      'SELECT id, resultado FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.workerB, IDS.vacancy],
    );
    expect(before.rows.length).toBe(1);
    expect(before.rows[0].resultado).toBeNull();
    const originalId = before.rows[0].id as string;

    // Upsert com resultado preenchido
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash, resultado)
       VALUES ($1, $2, 'upsert-test', md5('upsert-test|' || $1::uuid::text || '|' || $2::uuid::text), 'SELECCIONADO')
       ON CONFLICT (worker_id, job_posting_id) DO UPDATE SET
         resultado = EXCLUDED.resultado,
         updated_at = NOW()`,
      [IDS.workerB, IDS.vacancy],
    );

    // Verificar: ainda 1 linha, mesmo id, resultado atualizado
    const after = await pool.query(
      'SELECT id, resultado FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.workerB, IDS.vacancy],
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].id).toBe(originalId);
    expect(after.rows[0].resultado).toBe('SELECCIONADO');
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // F5-3 — Trigger fn_ensure_encuadre_on_wja_insert não cria duplicata
  // ══════════════════════════════════════════════════════════════════════════════

  it('[F5-3] Trigger não cria duplicata quando encuadre já existe para o par (worker_id, job_posting_id)', async () => {
    // workerC não tem WJA nem encuadre no seed — iniciamos limpos aqui

    // Garantir estado limpo
    await pool.query('DELETE FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2', [IDS.workerC, IDS.vacancy]);
    await pool.query('DELETE FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2', [IDS.workerC, IDS.vacancy]);

    // 1. Inserir encuadre manualmente antes da WJA
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
       VALUES ($1, $2, 'pre-existing', md5('pre-existing|' || $1::uuid::text || '|' || $2::uuid::text))`,
      [IDS.workerC, IDS.vacancy],
    );

    const beforeWja = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.workerC, IDS.vacancy],
    );
    expect(beforeWja.rows[0].cnt).toBe(1);

    // 2. Inserir WJA — trigger dispara, mas NOT EXISTS guard impede criação de duplicata
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'f5-trigger-test')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [IDS.workerC, IDS.vacancy],
    );

    const afterWja = await pool.query(
      'SELECT COUNT(*)::int AS cnt, MAX(import_source_audit) AS import_source_audit FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.workerC, IDS.vacancy],
    );
    // Trigger não criou duplicata — ainda 1 encuadre
    expect(afterWja.rows[0].cnt).toBe(1);
    // Encuadre pré-existente preservado (import_source_audit não sobrescrito pelo trigger)
    expect(afterWja.rows[0].import_source_audit).toBe('pre-existing');
  });

  // ══════════════════════════════════════════════════════════════════════════════
  // F5-4 — Invariante global: zero WJAs sem encuadre na vaga de teste
  // ══════════════════════════════════════════════════════════════════════════════

  it('[F5-4] Zero WJAs sem encuadre (invariante global pós-F5)', async () => {
    const orphans = await pool.query(
      `SELECT wja.worker_id
       FROM worker_job_applications wja
       WHERE wja.job_posting_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM encuadres e
           WHERE e.worker_id = wja.worker_id AND e.job_posting_id = wja.job_posting_id
         )`,
      [IDS.vacancy],
    );
    expect(orphans.rows.length).toBe(0);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function seedFixtures(pool: Pool): Promise<void> {
  await cleanFixtures(pool);

  // Patient
  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'f5e-e2e-task-001', 'F5ETest', 'Patient', 'AR', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.patient],
  );

  // Vacancy
  const vnRes = await pool.query<{ vn: string }>(
    "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
  );
  const vn = parseInt(vnRes.rows[0].vn);

  await pool.query(
    `INSERT INTO job_postings
       (id, vacancy_number, case_number, patient_id, title, description, country, status)
     VALUES ($1, $2, 98001, $3, 'f5e-e2e-vacancy', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.vacancy, vn, IDS.patient],
  );

  // Workers A, B, C
  const workers = [IDS.workerA, IDS.workerB, IDS.workerC];
  for (const [idx, wid] of workers.entries()) {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country)
       VALUES ($1, $2, $3, $4, 'REGISTERED', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [wid, `f5e-worker-${idx + 1}`, `f5e-w${idx + 1}@e2e.local`, `+54911009901${idx + 1}`],
    );
  }

  // workerA: encuadre direto (para F5-1 testar conflito)
  await pool.query(
    `INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
     VALUES ($1, $2, 'seed-first', md5('seed-first|' || $1::uuid::text || '|' || $2::uuid::text))
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    [IDS.workerA, IDS.vacancy],
  );

  // workerB: WJA + encuadre via trigger (para F5-2 testar upsert update)
  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, 'INVITED', 'f5e-seed')
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    [IDS.workerB, IDS.vacancy],
  );
  // Trigger cria encuadre com import_source_audit='auto-trigger' para workerB — sem resultado (NULL)

  // workerC: limpo — test F5-3 gerencia o estado diretamente
}

async function cleanFixtures(pool: Pool): Promise<void> {
  const workers = [IDS.workerA, IDS.workerB, IDS.workerC];

  await pool.query(
    'DELETE FROM encuadres WHERE job_posting_id = $1',
    [IDS.vacancy],
  ).catch(() => {});

  await pool.query(
    'DELETE FROM worker_job_applications WHERE job_posting_id = $1',
    [IDS.vacancy],
  ).catch(() => {});

  for (const wid of workers) {
    await pool.query('DELETE FROM workers WHERE id = $1', [wid]).catch(() => {});
  }

  await pool.query('DELETE FROM job_postings WHERE id = $1', [IDS.vacancy]).catch(() => {});
  await pool.query('DELETE FROM patients WHERE id = $1', [IDS.patient]).catch(() => {});
}
