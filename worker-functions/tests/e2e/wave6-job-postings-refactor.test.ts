/**
 * wave6-job-postings-refactor.test.ts
 *
 * Testa os 4 itens do Wave 6 do roadmap de correcao de schema,
 * contra o banco real (sem mocks).
 *
 * N4 Fase 1: dependency_level removido de job_postings
 * N4 Fase 2: job_postings_clickup_sync extraido
 * N3:        patient inline location migrado para patient_addresses
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

let pool: Pool;

// Deterministic UUIDs for test isolation
const IDS = {
  patient1: 'ee440000-0c06-0006-0001-000000000001',
  patient2: 'ee440000-0c06-0006-0001-000000000002',
  job1:     'ee440000-0c06-0006-0002-000000000001',
  job2:     'ee440000-0c06-0006-0002-000000000002',
  worker1:  'ee440000-0c06-0006-0003-000000000001',
};

async function cleanupTestData(p: Pool): Promise<void> {
  // FK order: children first
  await p.query(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id = ANY($1)`, [
    [IDS.job1, IDS.job2],
  ]).catch(() => {});
  await p.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1)`, [
    [IDS.job1, IDS.job2],
  ]).catch(() => {});
  await p.query(`DELETE FROM encuadres WHERE job_posting_id = ANY($1)`, [
    [IDS.job1, IDS.job2],
  ]).catch(() => {});
  await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.job1, IDS.job2]]);
  await p.query(`DELETE FROM patient_addresses WHERE patient_id = ANY($1)`, [
    [IDS.patient1, IDS.patient2],
  ]).catch(() => {});
  await p.query(`DELETE FROM patient_professionals WHERE patient_id = ANY($1)`, [
    [IDS.patient1, IDS.patient2],
  ]).catch(() => {});
  await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patient1, IDS.patient2]]);
  await p.query(`DELETE FROM workers WHERE id = ANY($1)`, [[IDS.worker1]]).catch(() => {});
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  await cleanupTestData(pool);
});

afterAll(async () => {
  await cleanupTestData(pool);
  await pool.end();
});

// =================================================================
// N4 FASE 1 — dependency_level removido de job_postings
// =================================================================

describe('N4 Fase 1 — dependency_level em job_postings', () => {
  // dependency_level foi removido em migration 080, re-adicionado em migration 107,
  // e definitivamente removido em migration 152 (Fase 9 do refactor de vagas).
  // O campo agora vive SOMENTE em patients (via JOIN com patient_id).
  it('job_postings NÃO tem coluna dependency_level (dropada em migration 152)', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name = 'dependency_level'`
    );
    expect(result.rows).toHaveLength(0);
  });

  it('patients manteve coluna dependency_level', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'patients' AND column_name = 'dependency_level'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('dependency_level eh lido de patients via JOIN', async () => {
    // Create a patient with dependency_level — canonical EN after migration 139
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, dependency_level, country)
       VALUES ($1, 'wave6-test-dep-1', 'SEVERE', 'AR')`,
      [IDS.patient1]
    );
    // Create a job_posting linked to the patient
    await pool.query(
      `INSERT INTO job_postings (id, case_number, patient_id, title, country, status)
       VALUES ($1, 99901, $2, 'Caso test dep', 'AR', 'SEARCHING')`,
      [IDS.job1, IDS.patient1]
    );

    const result = await pool.query(
      `SELECT p.dependency_level
       FROM job_postings jp
       LEFT JOIN patients p ON jp.patient_id = p.id
       WHERE jp.id = $1`,
      [IDS.job1]
    );
    // 'SEVERE' = canonical EN for ClickUp 'GRAVE' (es) — migration 139
    expect(result.rows[0].dependency_level).toBe('SEVERE');

    // Cleanup
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [IDS.job1]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient1]);
  });
});

// =================================================================
// N4 FASE 2 — job_postings_clickup_sync
// =================================================================

describe('N4 Fase 2 — job_postings_clickup_sync extraido', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id = ANY($1)`, [
      [IDS.job1, IDS.job2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.job1, IDS.job2]]);
  });

  it('tabela job_postings_clickup_sync existe', async () => {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name = 'job_postings_clickup_sync'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('job_postings nao tem campos clickup_*', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings'
         AND column_name LIKE 'clickup_%'`
    );
    expect(result.rows).toHaveLength(0);
  });

  it('job_postings nao tem source_created_at, source_updated_at, last_comment, comment_count', async () => {
    const removedCols = ['source_created_at', 'source_updated_at', 'last_comment', 'comment_count'];
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings'
         AND column_name = ANY($1)`,
      [removedCols]
    );
    expect(result.rows).toHaveLength(0);
  });

  it('clickup_sync tem a estrutura correta', async () => {
    const result = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'job_postings_clickup_sync'
       ORDER BY ordinal_position`
    );
    const colNames = result.rows.map((r: any) => r.column_name);
    expect(colNames).toContain('job_posting_id');
    expect(colNames).toContain('clickup_task_id');
    expect(colNames).toContain('source_created_at');
    expect(colNames).toContain('source_updated_at');
    expect(colNames).toContain('last_clickup_comment');
    expect(colNames).toContain('comment_count');
    expect(colNames).toContain('synced_at');
  });

  it('INSERT e JOIN retorna dados de sync ClickUp', async () => {
    // Create job_posting
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, country, status)
       VALUES ($1, 99902, 'Caso test sync', 'AR', 'SEARCHING')`,
      [IDS.job1]
    );
    // Insert sync data
    await pool.query(
      `INSERT INTO job_postings_clickup_sync
       (job_posting_id, clickup_task_id, source_created_at, last_clickup_comment, comment_count)
       VALUES ($1, 'task_abc123', '2025-01-15T10:00:00Z', 'Ultimo comentario', 5)`,
      [IDS.job1]
    );

    // JOIN query
    const result = await pool.query(
      `SELECT jp.title, cs.clickup_task_id, cs.last_clickup_comment, cs.comment_count
       FROM job_postings jp
       LEFT JOIN job_postings_clickup_sync cs ON cs.job_posting_id = jp.id
       WHERE jp.id = $1`,
      [IDS.job1]
    );

    expect(result.rows[0].clickup_task_id).toBe('task_abc123');
    expect(result.rows[0].last_clickup_comment).toBe('Ultimo comentario');
    expect(result.rows[0].comment_count).toBe(5);
  });

  it('clickup_task_id permite N vagas por task (migration 143: 1 task pode gerar N job_postings em multi-endereço)', async () => {
    // Migration 143 intencionalmente removeu o UNIQUE em clickup_task_id
    // para suportar paciente com múltiplos endereços → múltiplas vagas
    // compartilhando a mesma task ClickUp em "Estado de Pacientes".
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, country, status)
       VALUES ($1, 99903, 'Caso 1', 'AR', 'SEARCHING')`,
      [IDS.job1]
    );
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, country, status)
       VALUES ($1, 99904, 'Caso 2', 'AR', 'SEARCHING')`,
      [IDS.job2]
    );
    await pool.query(
      `INSERT INTO job_postings_clickup_sync (job_posting_id, clickup_task_id)
       VALUES ($1, 'unique_task')`,
      [IDS.job1]
    );

    // N vagas apontando pro mesmo clickup_task_id deve ser PERMITIDO
    await expect(
      pool.query(
        `INSERT INTO job_postings_clickup_sync (job_posting_id, clickup_task_id)
         VALUES ($1, 'unique_task')`,
        [IDS.job2]
      )
    ).resolves.not.toThrow();

    // Verificar que 2 entries existem pro mesmo task
    const count = await pool.query(
      `SELECT COUNT(*)::int AS c FROM job_postings_clickup_sync WHERE clickup_task_id = 'unique_task'`
    );
    expect(count.rows[0].c).toBe(2);
  });

  it('CASCADE: deletar job_posting remove sync', async () => {
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, country, status)
       VALUES ($1, 99905, 'Caso cascade', 'AR', 'SEARCHING')`,
      [IDS.job1]
    );
    await pool.query(
      `INSERT INTO job_postings_clickup_sync (job_posting_id, clickup_task_id)
       VALUES ($1, 'task_cascade')`,
      [IDS.job1]
    );

    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [IDS.job1]);

    const result = await pool.query(
      `SELECT * FROM job_postings_clickup_sync WHERE job_posting_id = $1`,
      [IDS.job1]
    );
    expect(result.rows).toHaveLength(0);
  });
});

// =================================================================
// N3 — Patient inline location migrado para patient_addresses
// =================================================================

describe('N3 — Patient inline location migrado para patient_addresses', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM patient_addresses WHERE patient_id = ANY($1)`, [
      [IDS.patient1, IDS.patient2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [
      [IDS.patient1, IDS.patient2],
    ]);
  });

  it('patients ainda tem colunas city_locality, province, zone_neighborhood (deprecated)', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'patients'
         AND column_name IN ('city_locality', 'province', 'zone_neighborhood')
       ORDER BY column_name`
    );
    expect(result.rows).toHaveLength(3);
  });

  it('colunas inline tem comentario DEPRECATED', async () => {
    const result = await pool.query(
      `SELECT col_description(
         (SELECT oid FROM pg_class WHERE relname = 'patients'),
         (SELECT attnum FROM pg_attribute
          WHERE attrelid = (SELECT oid FROM pg_class WHERE relname = 'patients')
            AND attname = 'city_locality')
       ) AS comment`
    );
    expect(result.rows[0].comment).toMatch(/DEPRECATED/i);
  });

  it('endereco principal em patient_addresses', async () => {
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, city_locality, province, zone_neighborhood, country)
       VALUES ($1, 'wave6-loc-1', 'Buenos Aires', 'CABA', 'Palermo', 'AR')`,
      [IDS.patient1]
    );

    // Insert a primary address (as the migration would do)
    await pool.query(
      `INSERT INTO patient_addresses (patient_id, address_type, address_raw, source)
       VALUES ($1, 'primary', 'Palermo, Buenos Aires, CABA', 'migration_083_from_inline')`,
      [IDS.patient1]
    );

    const result = await pool.query(
      `SELECT pa.address_raw, pa.address_type
       FROM patient_addresses pa
       WHERE pa.patient_id = $1 AND pa.address_type = 'primary'`,
      [IDS.patient1]
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].address_raw).toContain('Palermo');
    expect(result.rows[0].address_raw).toContain('Buenos Aires');
    expect(result.rows[0].address_raw).toContain('CABA');
  });

  it('idempotencia: migration nao cria duplicatas', async () => {
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, city_locality, province, zone_neighborhood, country)
       VALUES ($1, 'wave6-loc-2', 'Cordoba', 'Cordoba', 'Centro', 'AR')`,
      [IDS.patient1]
    );

    // Simulate migration running twice
    const migrationSQL = `
      INSERT INTO patient_addresses (patient_id, address_type, address_raw, source)
      SELECT p.id, 'primary', CONCAT_WS(', ', p.zone_neighborhood, p.city_locality, p.province),
             'migration_083_from_inline'
      FROM patients p
      WHERE p.id = $1
        AND (p.city_locality IS NOT NULL OR p.province IS NOT NULL OR p.zone_neighborhood IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM patient_addresses pa
          WHERE pa.patient_id = p.id AND pa.address_type = 'primary'
        )
    `;

    await pool.query(migrationSQL, [IDS.patient1]);
    await pool.query(migrationSQL, [IDS.patient1]); // Second run

    const result = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM patient_addresses
       WHERE patient_id = $1 AND address_type = 'primary'`,
      [IDS.patient1]
    );
    expect(result.rows[0].cnt).toBe(1);
  });

  it('paciente sem dados inline nao gera entrada em patient_addresses', async () => {
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, country)
       VALUES ($1, 'wave6-loc-3', 'AR')`,
      [IDS.patient1]
    );

    // Migration logic should skip this patient
    const migrationSQL = `
      INSERT INTO patient_addresses (patient_id, address_type, address_raw, source)
      SELECT p.id, 'primary', CONCAT_WS(', ', p.zone_neighborhood, p.city_locality, p.province),
             'migration_083_from_inline'
      FROM patients p
      WHERE p.id = $1
        AND (p.city_locality IS NOT NULL OR p.province IS NOT NULL OR p.zone_neighborhood IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM patient_addresses pa
          WHERE pa.patient_id = p.id AND pa.address_type = 'primary'
        )
    `;
    await pool.query(migrationSQL, [IDS.patient1]);

    const result = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM patient_addresses WHERE patient_id = $1`,
      [IDS.patient1]
    );
    expect(result.rows[0].cnt).toBe(0);
  });
});

// =================================================================
// REGRESSION — Limites e linters de schema
// =================================================================

describe('Regression — schema limits and linters', () => {
  it('job_postings nao tem campos clickup_* nem llm_* (validacao de limpeza Wave 6)', async () => {
    // Validação da limpeza Wave 6: confirma ausência de campos clickup_* e llm_*
    // (mais relevante que threshold de contagem absoluta, que muda com migrações futuras)
    const clickupResult = await pool.query(
      `SELECT COUNT(*)::int AS col_count
       FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name LIKE 'clickup_%'`
    );
    expect(clickupResult.rows[0].col_count).toBe(0);

    const llmResult = await pool.query(
      `SELECT COUNT(*)::int AS col_count
       FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name LIKE 'llm_%'`
    );
    expect(llmResult.rows[0].col_count).toBe(0);
  });

  it('nenhum campo clickup_* em job_postings', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name LIKE 'clickup_%'`
    );
    expect(result.rows).toHaveLength(0);
  });

  it('nenhum campo llm_* em job_postings', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name LIKE 'llm_%'`
    );
    expect(result.rows).toHaveLength(0);
  });

  // dependency_level foi re-adicionado em migration 107 e dropado definitivamente em migration 152
  it('campo dependency_level NÃO existe em job_postings (dropado em migration 152)', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name = 'dependency_level'`
    );
    expect(result.rows).toHaveLength(0);
  });

  it('job_postings_clickup_sync FK cascade funciona', async () => {
    const result = await pool.query(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'job_postings_clickup_sync'::regclass
         AND contype = 'f'`
    );
    // 'c' = CASCADE
    expect(result.rows.some((r: any) => r.confdeltype === 'c')).toBe(true);
  });

});
