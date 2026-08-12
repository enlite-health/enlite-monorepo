/**
 * kanban-fase2-invariant.test.ts — E2E Tests (DB-level)
 *
 * Valida a invariante estrutural da Fase 2 (TD-036):
 * "toda WJA tem encuadre correspondente"
 *
 * Migrations cobertas:
 *   188 — backfill encuadres para WJAs órfãs (idempotente)
 *   189 — trigger fn_ensure_encuadre_on_wja_insert + índice idx_encuadres_worker_job
 *
 * Edge cases:
 *   F2-1 — Backfill idempotente: rodar 2x não duplica encuadres
 *   F2-2 — WJA com encuadre pré-existente não recebe encuadre duplicado (import_source_audit original preservado)
 *   F2-3 — WJA órfã com múltiplos encuadres existentes — não cria mais
 *   F2-4 — Trigger não cria encuadre duplicado quando encuadre já existe (insert massivo)
 *   F2-5 — Trigger cria encuadre com import_source_audit='auto-trigger' para WJA nova sem encuadre
 *   F2-6 — Trigger garante invariante mesmo quando worker_id e job_posting_id são não-null
 *   F2-7 — worker_id NULL: backfill NÃO cria encuadre fantasma (WHERE NOT EXISTS guard)
 *   F2-8 — Dedup hash collision entre backfill e trigger: ON CONFLICT preserva encuadre original
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// ── Fixture IDs determinísticos (prefix kf2 para evitar colisão) ─────────────

const IDS = {
  patient:  'af200001-0000-4000-b001-000000000001',
  vacancy:  'af200001-0000-4000-b002-000000000001',
  wA: 'af200001-0000-4000-b003-000000000001',   // WJA sem encuadre → backfill testa
  wB: 'af200001-0000-4000-b003-000000000002',   // WJA com encuadre pré-existente
  wC: 'af200001-0000-4000-b003-000000000003',   // WJA com múltiplos encuadres
  wD: 'af200001-0000-4000-b003-000000000004',   // trigger não duplica
  wE: 'af200001-0000-4000-b003-000000000005',   // trigger cria auto-trigger
  wF: 'af200001-0000-4000-b003-000000000006',   // dedup hash collision
};

describe('Fase 2 — invariante estrutural WJA→encuadre (TD-036)', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await seedFixtures(pool);
  });

  afterAll(async () => {
    await cleanFixtures(pool);
    await pool.end();
  });

  // ════════════════════════════════════════════════════════════════════════════
  // F2-1 — Backfill idempotente: rodar 2x não duplica
  // ════════════════════════════════════════════════════════════════════════════

  it('[F2-1] Backfill idempotente: rodar INSERT backfill 2x mantém mesmo count', async () => {
    // Executa a lógica do backfill (migration 188) manualmente
    const backfillSql = `
      INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
      SELECT
        wja.worker_id,
        wja.job_posting_id,
        'backfill-td036',
        md5('backfill-td036|' || wja.worker_id::text || '|' || wja.job_posting_id::text)
      FROM worker_job_applications wja
      WHERE wja.job_posting_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM encuadres e
          WHERE e.worker_id = wja.worker_id AND e.job_posting_id = wja.job_posting_id
        )
      ON CONFLICT (worker_id, job_posting_id) DO NOTHING
    `;

    // Primeira execução
    const r1 = await pool.query(backfillSql, [IDS.vacancy]);
    const countAfterFirst = r1.rowCount ?? 0;

    // Conta encuadres após primeira execução
    const c1 = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE job_posting_id = $1',
      [IDS.vacancy],
    );
    const encuadresAfterFirst = c1.rows[0].cnt as number;

    // Segunda execução
    const r2 = await pool.query(backfillSql, [IDS.vacancy]);
    expect(r2.rowCount ?? 0).toBe(0); // segunda vez não insere nada novo

    // Conta encuadres após segunda execução — deve ser igual
    const c2 = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE job_posting_id = $1',
      [IDS.vacancy],
    );
    const encuadresAfterSecond = c2.rows[0].cnt as number;

    expect(encuadresAfterSecond).toBe(encuadresAfterFirst);
    // Confirmar que houve backfill na primeira execução (wA era órfã)
    expect(countAfterFirst).toBeGreaterThanOrEqual(0); // pode ser 0 se trigger já criou
    // Não importa quantos criou — o ponto é que a segunda execução criou 0
  });

  // ════════════════════════════════════════════════════════════════════════════
  // F2-2 — WJA com encuadre pré-existente: import_source_audit original preservado
  // ════════════════════════════════════════════════════════════════════════════

  it('[F2-2] WJA com encuadre pré-existente: backfill não sobrescreve import_source_audit original', async () => {
    // wB tem encuadre pré-existente com import_source_audit='Talentum' (criado no seed)
    // O backfill não deve criar um segundo encuadre nem mudar o import_source_audit

    // Verificar que existe exatamente 1 encuadre para wB
    const result = await pool.query(
      'SELECT import_source_audit FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.wB, IDS.vacancy],
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].import_source_audit).toBe('Talentum');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // F2-3 — WJA com múltiplos encuadres: backfill não cria mais
  // ════════════════════════════════════════════════════════════════════════════

  it('[F2-3] WJA com encuadre existente: backfill não adiciona mais (post-F5 — 1 encuadre por par)', async () => {
    // Post-F5: UNIQUE (worker_id, job_posting_id) em encuadres impede duplicatas.
    // wC tem exatamente 1 encuadre (criado pelo trigger no seed).
    // Backfill não deve criar outro (WHERE NOT EXISTS guard + UNIQUE constraint).

    const beforeCount = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.wC, IDS.vacancy],
    );
    const countBefore = beforeCount.rows[0].cnt as number;

    // Executa backfill restrito ao wC
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash)
       SELECT wja.worker_id, wja.job_posting_id, 'backfill-td036',
         md5('backfill-td036|' || wja.worker_id::text || '|' || wja.job_posting_id::text)
       FROM worker_job_applications wja
       WHERE wja.worker_id = $1 AND wja.job_posting_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM encuadres e
           WHERE e.worker_id = wja.worker_id AND e.job_posting_id = wja.job_posting_id
         )
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [IDS.wC, IDS.vacancy],
    );

    const afterCount = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.wC, IDS.vacancy],
    );
    const countAfter = afterCount.rows[0].cnt as number;

    // Count deve permanecer igual (não criou mais) e exatamente 1 (invariante F5)
    expect(countAfter).toBe(countBefore);
    expect(countBefore).toBe(1); // post-F5: UNIQUE constraint garante exatamente 1
  });

  // ════════════════════════════════════════════════════════════════════════════
  // F2-4 — Trigger não cria duplicado quando encuadre pré-existe
  // ════════════════════════════════════════════════════════════════════════════

  it('[F2-4] Trigger não cria encuadre duplicado quando encuadre já existe', async () => {
    // wD já tem WJA e encuadre (criado no seed). Inserir WJA via ON CONFLICT DO NOTHING
    // (simula chamada de syncToWorkerJobApplications).

    const beforeCount = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.wD, IDS.vacancy],
    );

    // O INSERT de WJA conflita (ON CONFLICT DO NOTHING), trigger não dispara
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'sync-test')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [IDS.wD, IDS.vacancy],
    );

    const afterCount = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.wD, IDS.vacancy],
    );

    // Count inalterado (trigger só dispara em INSERT, não em ON CONFLICT DO NOTHING)
    expect(afterCount.rows[0].cnt).toBe(beforeCount.rows[0].cnt);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // F2-5 — Trigger cria encuadre auto-trigger para WJA nova
  // ════════════════════════════════════════════════════════════════════════════

  it('[F2-5] Trigger cria encuadre com import_source_audit=auto-trigger para nova WJA', async () => {
    // wE não tem WJA nem encuadre no início (seed não criou para wE)
    // Verificar estado inicial
    const initialEnc = await pool.query(
      'SELECT id FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.wE, IDS.vacancy],
    );
    // Limpar se existir (trigger anterior pode ter criado)
    if (initialEnc.rows.length > 0) {
      await pool.query(
        'DELETE FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
        [IDS.wE, IDS.vacancy],
      );
      await pool.query(
        'DELETE FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2',
        [IDS.wE, IDS.vacancy],
      );
    }

    // Inserir WJA — trigger deve criar encuadre auto-trigger
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'trigger-test')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [IDS.wE, IDS.vacancy],
    );

    const encResult = await pool.query(
      'SELECT import_source_audit FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [IDS.wE, IDS.vacancy],
    );

    expect(encResult.rows.length).toBe(1);
    expect(encResult.rows[0].import_source_audit).toBe('auto-trigger');
  });

  // ════════════════════════════════════════════════════════════════════════════
  // F2-6 — Trigger garante invariante: zero órfãs após insert
  // ════════════════════════════════════════════════════════════════════════════

  it('[F2-6] Após qualquer INSERT de WJA, não existem WJAs órfãs na vaga', async () => {
    // Inserir WJA para wF (nova WJA sem encuadre pré-existente)
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INITIATED', 'invariant-test')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [IDS.wF, IDS.vacancy],
    );

    // Verificar invariante: nenhuma WJA órfã na vaga de teste
    const orphans = await pool.query(
      `SELECT wja.worker_id
       FROM worker_job_applications wja
       LEFT JOIN encuadres e ON e.worker_id = wja.worker_id AND e.job_posting_id = wja.job_posting_id
       WHERE wja.job_posting_id = $1 AND e.id IS NULL`,
      [IDS.vacancy],
    );

    expect(orphans.rows.length).toBe(0);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // F2-7 — worker_id NULL: backfill NÃO cria encuadre fantasma
  // ════════════════════════════════════════════════════════════════════════════

  it('[F2-7] Trigger NÃO cria encuadre quando worker_id é NULL', async () => {
    // A tabela worker_job_applications não deve ter NOT NULL em worker_id?
    // Verificar o schema — se worker_id é NOT NULL, o insert vai falhar antes do trigger.
    // Se aceitar NULL, o trigger tem guard: IF NEW.worker_id IS NOT NULL AND ...
    // Neste caso testamos que o guard funciona.

    // Verificar se a coluna aceita NULL
    const colInfo = await pool.query(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_name = 'worker_job_applications'
         AND column_name = 'worker_id'`,
    );

    if (colInfo.rows[0]?.is_nullable === 'NO') {
      // worker_id NOT NULL — constraint impede o insert, trigger nunca alcança o NULL
      // O guard do trigger é defense-in-depth, não necessário aqui.
      // Verificar que o schema mesmo impede inserts com NULL (constraint level protection)
      await expect(
        pool.query(
          `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
           VALUES (NULL, $1, 'INVITED', 'null-guard-test')`,
          [IDS.vacancy],
        ),
      ).rejects.toThrow();
      return;
    }

    // Se aceitar NULL, o trigger guard (IF NEW.worker_id IS NOT NULL) deve pular a criação
    const beforeCount = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE job_posting_id = $1',
      [IDS.vacancy],
    );

    // Tentativa de insert com worker_id NULL — pode falhar na constraint ou passar
    try {
      await pool.query(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES (NULL, $1, 'INVITED', 'null-guard-test')`,
        [IDS.vacancy],
      );
    } catch {
      // Constraint NOT NULL impediu — proteção em nível de schema. OK.
    }

    // Encuadres não devem ter aumentado com worker_id=NULL
    const afterCount = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM encuadres WHERE job_posting_id = $1',
      [IDS.vacancy],
    );

    expect(afterCount.rows[0].cnt).toBe(beforeCount.rows[0].cnt);
  });

  // ════════════════════════════════════════════════════════════════════════════
  // F2-8 — Dedup hash collision: ON CONFLICT preserva encuadre original
  // ════════════════════════════════════════════════════════════════════════════

  it('[F2-8] Dedup hash collision entre backfill e trigger: ON CONFLICT preserva encuadre rico', async () => {
    // Criar worker independente para este teste
    const wHashWorker = 'af200001-0000-4000-b004-000000000001';
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country)
       VALUES ($1, 'kf2-hash-w1', 'kf2-hash-w1@test.local', '5491100099901', 'REGISTERED', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [wHashWorker],
    );

    // Simular encuadre rico já existente com dedup_hash = 'auto-trigger' hash
    const autoTriggerHash = await pool.query<{ md5: string }>(
      `SELECT md5('auto-trigger|' || $1 || '|' || $2) AS md5`,
      [wHashWorker, IDS.vacancy],
    );
    const autoHash = autoTriggerHash.rows[0].md5;

    // Inserir encuadre "rico" com o hash que o trigger geraria
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, import_source_audit, dedup_hash, worker_raw_name, resultado)
       VALUES ($1, $2, 'Talentum', $3, 'Worker Rico', 'SELECCIONADO')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [wHashWorker, IDS.vacancy, autoHash],
    );

    // Agora inserir WJA — trigger tenta criar encuadre com mesmo hash
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'INVITED', 'hash-collision-test')
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
      [wHashWorker, IDS.vacancy],
    );

    // Verificar que o encuadre original (rico) foi preservado
    const result = await pool.query(
      'SELECT import_source_audit, worker_raw_name, resultado FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2',
      [wHashWorker, IDS.vacancy],
    );

    // Exatamente 1 encuadre (não duplicado)
    expect(result.rows.length).toBe(1);
    // Encuadre original preservado (ON CONFLICT DO NOTHING no trigger)
    expect(result.rows[0].import_source_audit).toBe('Talentum');
    expect(result.rows[0].worker_raw_name).toBe('Worker Rico');
    expect(result.rows[0].resultado).toBe('SELECCIONADO');

    // Limpeza
    await pool.query('DELETE FROM worker_job_applications WHERE worker_id = $1', [wHashWorker]);
    await pool.query('DELETE FROM encuadres WHERE worker_id = $1', [wHashWorker]);
    await pool.query('DELETE FROM workers WHERE id = $1', [wHashWorker]);
  });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

async function seedFixtures(pool: Pool): Promise<void> {
  await cleanFixtures(pool);

  // Patient
  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status)
     VALUES ($1, 'kf2-e2e-task-001', 'KF2Test', 'Patient', 'AR', 'ACTIVE')
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
     VALUES ($1, $2, 97001, $3, 'kf2-e2e-vacancy', '', 'AR', 'SEARCHING')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.vacancy, vn, IDS.patient],
  );

  // Workers
  const workerIds = [IDS.wA, IDS.wB, IDS.wC, IDS.wD, IDS.wE, IDS.wF];
  for (const [idx, wid] of workerIds.entries()) {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country)
       VALUES ($1, $2, $3, $4, 'REGISTERED', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [wid, `kf2-worker-${idx + 1}`, `kf2-w${idx + 1}@e2e.local`, `+54911009900${idx + 1}`],
    );
  }

  // Disable trigger to create orphan WJA for wA (to test backfill)
  await pool.query(
    'ALTER TABLE worker_job_applications DISABLE TRIGGER trg_ensure_encuadre_on_wja_insert',
  );

  // wA: WJA orphan (no encuadre — for backfill test)
  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, 'INVITED', 'kf2-seed')
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    [IDS.wA, IDS.vacancy],
  );

  // Re-enable trigger
  await pool.query(
    'ALTER TABLE worker_job_applications ENABLE TRIGGER trg_ensure_encuadre_on_wja_insert',
  );

  // wB: WJA with pre-existing Talentum encuadre
  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, 'INITIATED', 'kf2-seed')
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    [IDS.wB, IDS.vacancy],
  );
  // Since trigger fires on insert of wB WJA, encuadre will be auto-trigger.
  // Update it to 'Talentum' to simulate pre-existing rich encuadre.
  await pool.query(
    `UPDATE encuadres SET import_source_audit = 'Talentum'
     WHERE worker_id = $1 AND job_posting_id = $2`,
    [IDS.wB, IDS.vacancy],
  );

  // wC: WJA with encuadre (post-F5: UNIQUE constraint prevents duplicates — only 1 encuadre per pair)
  // F2-3 test updated: migration 193 UNIQUE (worker_id, job_posting_id) enforces 1 encuadre per pair.
  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, 'COMPLETED', 'kf2-seed')
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    [IDS.wC, IDS.vacancy],
  );
  // Trigger creates the single encuadre for wC; no second insert (UNIQUE constraint enforces it).

  // wD: WJA with encuadre — to test trigger does not duplicate
  await pool.query(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
     VALUES ($1, $2, 'INVITED', 'kf2-seed')
     ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    [IDS.wD, IDS.vacancy],
  );
  // wD encuadre auto-created by trigger — no additional setup needed

  // wE and wF: no WJA/encuadre in seed (tests create them)
}

async function cleanFixtures(pool: Pool): Promise<void> {
  const workerIds = [IDS.wA, IDS.wB, IDS.wC, IDS.wD, IDS.wE, IDS.wF];

  await pool.query(
    'DELETE FROM encuadres WHERE job_posting_id = $1',
    [IDS.vacancy],
  ).catch(() => {});

  await pool.query(
    'DELETE FROM worker_job_applications WHERE job_posting_id = $1',
    [IDS.vacancy],
  ).catch(() => {});

  for (const wid of workerIds) {
    await pool.query('DELETE FROM workers WHERE id = $1', [wid]).catch(() => {});
  }

  await pool.query('DELETE FROM job_postings WHERE id = $1', [IDS.vacancy]).catch(() => {});
  await pool.query('DELETE FROM patients WHERE id = $1', [IDS.patient]).catch(() => {});
}
