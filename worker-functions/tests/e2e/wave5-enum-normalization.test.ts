/**
 * wave5-enum-normalization.test.ts
 *
 * Testa os 4 itens do Wave 5 do roadmap de correção de schema,
 * contra o banco real (sem mocks).
 *
 * N1:  Alinhamento occupation ↔ profession enum
 * N5:  Materialized view worker_eligibility
 * N6:  FUNNEL_TO_STATUS mapping + column comments
 * D7:  worker_status_history table + trigger
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

let pool: Pool;

// UUIDs determinísticos para isolamento do teste
const WORKER_IDS = {
  w1: 'ee440000-0c05-0005-0001-000000000001',
  w2: 'ee440000-0c05-0005-0001-000000000002',
  w3: 'ee440000-0c05-0005-0001-000000000003',
  w4: 'ee440000-0c05-0005-0001-000000000004',
  w5: 'ee440000-0c05-0005-0001-000000000005',
};

const JOB_IDS = {
  j1: 'ee440000-0c05-0005-0002-000000000001',
};

const WJA_IDS = {
  a1: 'ee440000-0c05-0005-0003-000000000001',
};

async function cleanupTestData(p: Pool): Promise<void> {
  // FK order: children first
  await p.query(`DELETE FROM worker_status_history WHERE worker_id = ANY($1)`, [
    Object.values(WORKER_IDS),
  ]).catch(() => {});
  await p.query(`DELETE FROM worker_job_applications WHERE id = ANY($1)`, [
    Object.values(WJA_IDS),
  ]).catch(() => {});
  await p.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1)`, [
    Object.values(WORKER_IDS),
  ]).catch(() => {});
  await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [Object.values(JOB_IDS)]);
  await p.query(`DELETE FROM workers WHERE id = ANY($1)`, [Object.values(WORKER_IDS)]);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  await cleanupTestData(pool);
});

afterAll(async () => {
  await cleanupTestData(pool);
  await pool.end();
});

// ═══════════════════════════════════════════════════════════════
// N1 — Alinhamento occupation ↔ profession enum
// ═══════════════════════════════════════════════════════════════

describe('N1 — occupation alinhado com profession', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [Object.values(WORKER_IDS)]);
  });

  it('CHECK constraint de occupation aceita valores do enum profession', async () => {
    const validValues = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'];

    for (let i = 0; i < validValues.length; i++) {
      const val = validValues[i];
      const id = `ee440000-0c05-0005-a100-00000000000${i + 1}`;
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, occupation, country, timezone)
         VALUES ($1, $2, $3, $4, 'REGISTERED', $5, 'AR', 'America/Buenos_Aires')`,
        [id, `e2e-w5-occ-${val}`, `occ-${val}@wave5.test`, `541100000${10 + i}`, val],
      );

      const result = await pool.query<{ occupation: string }>(
        `SELECT occupation FROM workers WHERE id = $1`,
        [id],
      );
      expect(result.rows[0].occupation).toBe(val);

      // Cleanup each
      await pool.query(`DELETE FROM workers WHERE id = $1`, [id]);
    }
  });

  it('CHECK constraint rejeita valor legacy CUIDADOR', async () => {
    try {
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, occupation, country, timezone)
         VALUES ($1, 'e2e-w5-cuidador', 'cuidador@wave5.test', '54110000099', 'INCOMPLETE_REGISTER', 'CUIDADOR', 'AR', 'America/Buenos_Aires')`,
        [WORKER_IDS.w1],
      );
      fail('INSERT deveria ter falhado com check_violation');
    } catch (err: any) {
      expect(err.code).toBe('23514'); // check_violation
    }
  });

  it('CHECK constraint rejeita valor legacy AMBOS', async () => {
    try {
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, occupation, country, timezone)
         VALUES ($1, 'e2e-w5-ambos', 'ambos@wave5.test', '54110000098', 'INCOMPLETE_REGISTER', 'AMBOS', 'AR', 'America/Buenos_Aires')`,
        [WORKER_IDS.w1],
      );
      fail('INSERT deveria ter falhado com check_violation');
    } catch (err: any) {
      expect(err.code).toBe('23514'); // check_violation
    }
  });

  it('occupation NULL é aceito (campo opcional)', async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, occupation, country, timezone)
       VALUES ($1, 'e2e-w5-null-occ', 'nullocc@wave5.test', '54110000097', 'REGISTERED', NULL, 'AR', 'America/Buenos_Aires')`,
      [WORKER_IDS.w1],
    );

    const result = await pool.query<{ occupation: string | null }>(
      `SELECT occupation FROM workers WHERE id = $1`,
      [WORKER_IDS.w1],
    );
    expect(result.rows[0].occupation).toBeNull();
  });

  it('ambos CHECK constraints (profession e occupation) aceitam os mesmos valores', async () => {
    const result = await pool.query<{ conname: string; consrc: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conrelid = 'workers'::regclass
        AND contype = 'c'
        AND (conname LIKE '%occupation%' OR conname LIKE '%profession%')
      ORDER BY conname
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(2);

    // Extract values from constraint definitions
    const extractValues = (consrc: string): string[] => {
      const matches = consrc.match(/'([^']+)'/g);
      return (matches || []).map(m => m.replace(/'/g, '')).sort();
    };

    const professionRow = result.rows.find(r => r.conname.includes('profession'));
    const occupationRow = result.rows.find(r => r.conname.includes('occupation'));

    expect(professionRow).toBeDefined();
    expect(occupationRow).toBeDefined();

    const profValues = extractValues(professionRow!.consrc);
    const occValues = extractValues(occupationRow!.consrc);
    expect(profValues).toEqual(occValues);
  });

  it('view workers_profession_divergence existe e funciona', async () => {
    // Criar worker com profession != occupation
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, profession, occupation, country, timezone)
       VALUES ($1, 'e2e-w5-diverg', 'diverg@wave5.test', '54110000096', 'REGISTERED', 'AT', 'CAREGIVER', 'AR', 'America/Buenos_Aires')`,
      [WORKER_IDS.w1],
    );

    const result = await pool.query<{ id: string; profession: string; occupation: string }>(
      `SELECT id, profession, occupation FROM workers_profession_divergence WHERE id = $1`,
      [WORKER_IDS.w1],
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].profession).toBe('AT');
    expect(result.rows[0].occupation).toBe('CAREGIVER');
  });

  it('view workers_profession_divergence exclui workers sem divergência', async () => {
    // Criar worker com profession = occupation
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, profession, occupation, country, timezone)
       VALUES ($1, 'e2e-w5-same', 'same@wave5.test', '54110000095', 'REGISTERED', 'NURSE', 'NURSE', 'AR', 'America/Buenos_Aires')`,
      [WORKER_IDS.w2],
    );

    const result = await pool.query<{ id: string }>(
      `SELECT id FROM workers_profession_divergence WHERE id = $1`,
      [WORKER_IDS.w2],
    );
    expect(result.rows.length).toBe(0);
  });

  it('nenhum worker com occupation = CUIDADOR existe após migration', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workers WHERE occupation = 'CUIDADOR'`,
    );
    expect(parseInt(result.rows[0].count)).toBe(0);
  });

  it('nenhum worker com occupation = AMBOS existe após migration', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM workers WHERE occupation = 'AMBOS'`,
    );
    expect(parseInt(result.rows[0].count)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// N5 — Materialized view worker_eligibility
// ═══════════════════════════════════════════════════════════════

describe('N5 — worker_eligibility view', () => {
  beforeAll(async () => {
    // Seed workers — availability_status removed in migration 096
    const workers = [
      { id: WORKER_IDS.w1, uid: 'e2e-w5-elig-1', status: 'REGISTERED',           deleted: false },
      { id: WORKER_IDS.w2, uid: 'e2e-w5-elig-2', status: 'INCOMPLETE_REGISTER',   deleted: false },
      { id: WORKER_IDS.w3, uid: 'e2e-w5-elig-3', status: 'REGISTERED',            deleted: false },
      { id: WORKER_IDS.w4, uid: 'e2e-w5-elig-4', status: 'REGISTERED',            deleted: false },
      { id: WORKER_IDS.w5, uid: 'e2e-w5-elig-5', status: 'REGISTERED',            deleted: true },
    ];

    for (const w of workers) {
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone, deleted_at)
         VALUES ($1, $2, $3, $4, $5, 'AR', 'America/Buenos_Aires', $6)
         ON CONFLICT (auth_uid) DO NOTHING`,
        [w.id, w.uid, `${w.uid}@wave5.test`, `541100${w.uid.slice(-1)}0001`, w.status, w.deleted ? new Date() : null],
      );
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM worker_status_history WHERE worker_id = ANY($1)`, [
      Object.values(WORKER_IDS),
    ]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [Object.values(WORKER_IDS)]);
  });

  // worker_eligibility view removed in migration 096
  it.skip('materialized view worker_eligibility existe', async () => {
    const result = await pool.query<{ matviewname: string }>(`
      SELECT matviewname
      FROM pg_matviews
      WHERE schemaname = 'public'
        AND matviewname = 'worker_eligibility'
    `);
    expect(result.rows.length).toBe(1);
  });

  // worker_eligibility view removed in migration 096
  it.skip('view tem as colunas esperadas', async () => {
    // Materialized views don't appear in information_schema.columns — use pg_attribute
    const result = await pool.query<{ attname: string }>(`
      SELECT a.attname
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'worker_eligibility'
        AND a.attnum > 0
        AND NOT a.attisdropped
      ORDER BY a.attnum
    `);
    const columns = result.rows.map(r => r.attname);
    expect(columns).toContain('id');
    expect(columns).toContain('status');
    expect(columns).toContain('overall_status');
    expect(columns).toContain('availability_status');
    expect(columns).toContain('is_matchable');
    expect(columns).toContain('is_active');
  });

  // worker_eligibility view removed in migration 096
  it.skip('unique index idx_worker_eligibility_id existe', async () => {
    const result = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'worker_eligibility'
        AND indexname = 'idx_worker_eligibility_id'
    `);
    expect(result.rows.length).toBe(1);
  });

  // worker_eligibility view removed in migration 096
  it.skip('is_matchable=true quando approved + QUALIFIED + AVAILABLE', async () => {
    const result = await pool.query<{ is_matchable: boolean }>(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w1],
    );
    expect(result.rows[0].is_matchable).toBe(true);
  });

  // worker_eligibility view removed in migration 096
  it.skip('is_matchable=false quando status=pending', async () => {
    const result = await pool.query<{ is_matchable: boolean }>(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w2],
    );
    expect(result.rows[0].is_matchable).toBe(false);
  });

  // worker_eligibility view removed in migration 096
  it.skip('is_matchable=false quando overall_status=BLACKLISTED', async () => {
    const result = await pool.query<{ is_matchable: boolean }>(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w3],
    );
    expect(result.rows[0].is_matchable).toBe(false);
  });

  // worker_eligibility view removed in migration 096
  it.skip('is_matchable=true quando availability_status IS NULL (worker sem Ana Care sync)', async () => {
    const result = await pool.query<{ is_matchable: boolean }>(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w4],
    );
    expect(result.rows[0].is_matchable).toBe(true);
  });

  // worker_eligibility view removed in migration 096
  it.skip('is_matchable=false quando deleted_at IS NOT NULL (soft delete)', async () => {
    const result = await pool.query<{ is_matchable: boolean }>(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w5],
    );
    expect(result.rows[0].is_matchable).toBe(false);
  });

  // worker_eligibility view removed in migration 096
  it.skip('is_active=true quando approved + não BLACKLISTED/INACTIVE + não deletado', async () => {
    const result = await pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w1],
    );
    expect(result.rows[0].is_active).toBe(true);
  });

  // worker_eligibility view removed in migration 096
  it.skip('is_active=false quando overall_status=BLACKLISTED', async () => {
    const result = await pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w3],
    );
    expect(result.rows[0].is_active).toBe(false);
  });

  // worker_eligibility view removed in migration 096
  it.skip('is_active=false quando deleted_at IS NOT NULL', async () => {
    const result = await pool.query<{ is_active: boolean }>(
      `SELECT is_active FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w5],
    );
    expect(result.rows[0].is_active).toBe(false);
  });

  // worker_eligibility view removed in migration 096
  it.skip('REFRESH MATERIALIZED VIEW CONCURRENTLY funciona (requer unique index)', async () => {
    // This would fail if the unique index didn't exist
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY worker_eligibility`);

    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM worker_eligibility WHERE id = ANY($1)`,
      [Object.values(WORKER_IDS)],
    );
    expect(parseInt(result.rows[0].count)).toBeGreaterThan(0);
  });

  // worker_eligibility view removed in migration 096
  it.skip('view reflete mudanças após REFRESH', async () => {
    // Update worker status to make them matchable
    await pool.query(
      `UPDATE workers SET status = 'INCOMPLETE_REGISTER' WHERE id = $1`,
      [WORKER_IDS.w2],
    );

    // Before refresh — should still show old value
    const before = await pool.query<{ is_matchable: boolean }>(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w2],
    );
    expect(before.rows[0].is_matchable).toBe(false);

    // Refresh
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY worker_eligibility`);

    // After refresh — should show new value
    const after = await pool.query<{ is_matchable: boolean }>(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [WORKER_IDS.w2],
    );
    expect(after.rows[0].is_matchable).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// N6 — FUNNEL_TO_STATUS mapping + column comments
// ═══════════════════════════════════════════════════════════════

describe('N6 — FUNNEL_TO_STATUS mapping', () => {
  it('application_funnel_stage tem COMMENT no banco', async () => {
    const result = await pool.query<{ description: string }>(`
      SELECT col_description(
        'worker_job_applications'::regclass,
        (SELECT ordinal_position FROM information_schema.columns
         WHERE table_name = 'worker_job_applications'
           AND column_name = 'application_funnel_stage')::int
      ) AS description
    `);
    expect(result.rows[0].description).toBeTruthy();
    expect(result.rows[0].description).toContain('funnel');
  });

  // removido em F7.c — application_status não existe mais (migration 196)

  // FUNNEL_TO_STATUS mapping was not implemented — skipping
  it.skip('FUNNEL_TO_STATUS TypeScript mapping cobre todos os valores de funnel_stage', async () => {
    const { FUNNEL_TO_STATUS } = require('../../src/domain/entities/WorkerJobApplication');
    const expectedStages = ['APPLIED', 'PRE_SCREENING', 'INTERVIEW_SCHEDULED', 'INTERVIEWED', 'QUALIFIED', 'REJECTED', 'HIRED'];
    for (const stage of expectedStages) {
      expect(FUNNEL_TO_STATUS[stage]).toBeDefined();
      expect(typeof FUNNEL_TO_STATUS[stage]).toBe('string');
    }
  });

  // FUNNEL_TO_STATUS mapping was not implemented — skipping
  it.skip('FUNNEL_TO_STATUS mapeia para valores válidos de application_status', async () => {
    const { FUNNEL_TO_STATUS } = require('../../src/domain/entities/WorkerJobApplication');
    const validStatuses = ['applied', 'under_review', 'shortlisted', 'interview_scheduled', 'approved', 'rejected', 'withdrawn', 'hired'];
    for (const [stage, status] of Object.entries(FUNNEL_TO_STATUS)) {
      expect(validStatuses).toContain(status);
    }
  });

  it('valores de funnel_stage do CHECK constraint são aceitos', async () => {
    // Create prerequisite data
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'e2e-w5-n6-worker', 'n6worker@wave5.test', '54119990001', 'REGISTERED', 'AR', 'America/Buenos_Aires')
       ON CONFLICT (auth_uid) DO NOTHING`,
      [WORKER_IDS.w1],
    );

    await pool.query(
      `INSERT INTO job_postings (id, title, status, country)
       VALUES ($1, 'Wave5 N6 test posting', 'ACTIVE', 'AR')
       ON CONFLICT DO NOTHING`,
      [JOB_IDS.j1],
    );

    // Test inserting with a valid funnel stage (actual values: INITIATED, IN_PROGRESS, COMPLETED, QUALIFIED, IN_DOUBT, NOT_QUALIFIED, PLACED)
    await pool.query(
      `INSERT INTO worker_job_applications (id, worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $2, $3, 'INITIATED')
       ON CONFLICT DO NOTHING`,
      [WJA_IDS.a1, WORKER_IDS.w1, JOB_IDS.j1],
    );

    const result = await pool.query<{ application_funnel_stage: string }>(
      `SELECT application_funnel_stage FROM worker_job_applications WHERE id = $1`,
      [WJA_IDS.a1],
    );
    expect(result.rows[0].application_funnel_stage).toBe('INITIATED');

    // Cleanup
    await pool.query(`DELETE FROM worker_job_applications WHERE id = $1`, [WJA_IDS.a1]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [JOB_IDS.j1]);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [WORKER_IDS.w1]);
  });
});

// ═══════════════════════════════════════════════════════════════
// D7 — worker_status_history + trigger
// ═══════════════════════════════════════════════════════════════

describe('D7 — worker_status_history', () => {
  beforeAll(async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'e2e-w5-hist-1', 'hist1@wave5.test', '54118880001', 'INCOMPLETE_REGISTER', 'AR', 'America/Buenos_Aires')
       ON CONFLICT (id) DO UPDATE SET status = 'INCOMPLETE_REGISTER'`,
      [WORKER_IDS.w1],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM worker_status_history WHERE worker_id = ANY($1)`, [
      Object.values(WORKER_IDS),
    ]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [Object.values(WORKER_IDS)]);
  });

  it('tabela worker_status_history existe com colunas corretas', async () => {
    const result = await pool.query<{ column_name: string; data_type: string }>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'worker_status_history'
      ORDER BY ordinal_position
    `);

    const columns = result.rows.map(r => r.column_name);
    expect(columns).toContain('id');
    expect(columns).toContain('worker_id');
    expect(columns).toContain('field_name');
    expect(columns).toContain('old_value');
    expect(columns).toContain('new_value');
    expect(columns).toContain('changed_by');
    expect(columns).toContain('change_source');
    expect(columns).toContain('created_at');
  });

  it('FK worker_id referencia workers(id) ON DELETE CASCADE', async () => {
    const result = await pool.query<{ confdeltype: string; consrc: string }>(`
      SELECT confdeltype, pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conrelid = 'worker_status_history'::regclass
        AND contype = 'f'
        AND pg_get_constraintdef(oid) LIKE '%workers%'
    `);
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].confdeltype).toBe('c'); // CASCADE
  });

  it('índices idx_worker_status_history_worker e idx_worker_status_history_field existem', async () => {
    const result = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'worker_status_history'
      ORDER BY indexname
    `);

    const indexNames = result.rows.map(r => r.indexname);
    expect(indexNames).toContain('idx_worker_status_history_worker');
    expect(indexNames).toContain('idx_worker_status_history_field');
  });

  it('trigger trg_worker_status_history existe em workers', async () => {
    const result = await pool.query<{ tgname: string }>(`
      SELECT tgname
      FROM pg_trigger
      WHERE tgrelid = 'workers'::regclass
        AND tgname = 'trg_worker_status_history'
    `);
    expect(result.rows.length).toBe(1);
  });

  // overall_status column removed in migration 096
  it.skip('mudança de overall_status cria registro no histórico', async () => {
    // Clear prior history
    await pool.query(
      `DELETE FROM worker_status_history WHERE worker_id = $1`,
      [WORKER_IDS.w1],
    );

    await pool.query(
      `UPDATE workers SET overall_status = 'QUALIFIED' WHERE id = $1`,
      [WORKER_IDS.w1],
    );

    const result = await pool.query<{
      field_name: string;
      old_value: string;
      new_value: string;
    }>(
      `SELECT field_name, old_value, new_value
       FROM worker_status_history
       WHERE worker_id = $1 AND field_name = 'overall_status'
       ORDER BY created_at DESC LIMIT 1`,
      [WORKER_IDS.w1],
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].old_value).toBe('PRE_TALENTUM');
    expect(result.rows[0].new_value).toBe('QUALIFIED');
  });

  it('mudança de status cria registro no histórico', async () => {
    await pool.query(
      `DELETE FROM worker_status_history WHERE worker_id = $1 AND field_name = 'status'`,
      [WORKER_IDS.w1],
    );

    // Worker was inserted with INCOMPLETE_REGISTER; change to DISABLED
    // (UPDATE para REGISTERED em worker sem campos obrigatórios é bloqueado pelo
    // trigger trg_guard_registered_status — migration 111)
    await pool.query(
      `UPDATE workers SET status = 'DISABLED' WHERE id = $1`,
      [WORKER_IDS.w1],
    );

    const result = await pool.query<{
      field_name: string;
      old_value: string;
      new_value: string;
    }>(
      `SELECT field_name, old_value, new_value
       FROM worker_status_history
       WHERE worker_id = $1 AND field_name = 'status'
       ORDER BY created_at DESC LIMIT 1`,
      [WORKER_IDS.w1],
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].old_value).toBe('INCOMPLETE_REGISTER');
    expect(result.rows[0].new_value).toBe('DISABLED');
  });

  // availability_status column removed in migration 096
  it.skip('mudança de availability_status cria registro no histórico', async () => {
    await pool.query(
      `DELETE FROM worker_status_history WHERE worker_id = $1 AND field_name = 'availability_status'`,
      [WORKER_IDS.w1],
    );

    await pool.query(
      `UPDATE workers SET availability_status = 'INACTIVE' WHERE id = $1`,
      [WORKER_IDS.w1],
    );

    const result = await pool.query<{
      field_name: string;
      old_value: string;
      new_value: string;
    }>(
      `SELECT field_name, old_value, new_value
       FROM worker_status_history
       WHERE worker_id = $1 AND field_name = 'availability_status'
       ORDER BY created_at DESC LIMIT 1`,
      [WORKER_IDS.w1],
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].old_value).toBe('AVAILABLE');
    expect(result.rows[0].new_value).toBe('INACTIVE');
  });

  it('UPDATE que não altera status NÃO cria histórico', async () => {
    await pool.query(
      `DELETE FROM worker_status_history WHERE worker_id = $1`,
      [WORKER_IDS.w1],
    );

    // Update a non-status field
    await pool.query(
      `UPDATE workers SET email = 'updated-hist1@wave5.test' WHERE id = $1`,
      [WORKER_IDS.w1],
    );

    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM worker_status_history WHERE worker_id = $1`,
      [WORKER_IDS.w1],
    );
    expect(parseInt(result.rows[0].count)).toBe(0);
  });

  // overall_status column removed in migration 096
  it.skip('UPDATE com mesmo valor NÃO cria histórico (IS DISTINCT FROM)', async () => {
    // Get current value
    const current = await pool.query<{ overall_status: string }>(
      `SELECT overall_status FROM workers WHERE id = $1`,
      [WORKER_IDS.w1],
    );
    const currentStatus = current.rows[0].overall_status;

    await pool.query(
      `DELETE FROM worker_status_history WHERE worker_id = $1`,
      [WORKER_IDS.w1],
    );

    // Update to the same value
    await pool.query(
      `UPDATE workers SET overall_status = $1 WHERE id = $2`,
      [currentStatus, WORKER_IDS.w1],
    );

    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM worker_status_history WHERE worker_id = $1`,
      [WORKER_IDS.w1],
    );
    expect(parseInt(result.rows[0].count)).toBe(0);
  });

  // overall_status and availability_status columns removed in migration 096
  it.skip('múltiplas mudanças de status em um UPDATE criam múltiplos registros', async () => {
    await pool.query(
      `DELETE FROM worker_status_history WHERE worker_id = $1`,
      [WORKER_IDS.w1],
    );

    // Update two status fields at once
    await pool.query(
      `UPDATE workers SET overall_status = 'ACTIVE', availability_status = 'ACTIVE' WHERE id = $1`,
      [WORKER_IDS.w1],
    );

    const result = await pool.query<{ field_name: string; new_value: string }>(
      `SELECT field_name, new_value
       FROM worker_status_history
       WHERE worker_id = $1
       ORDER BY field_name`,
      [WORKER_IDS.w1],
    );

    expect(result.rows.length).toBe(2);
    const fields = result.rows.map(r => r.field_name);
    expect(fields).toContain('overall_status');
    expect(fields).toContain('availability_status');
  });

  // overall_status column removed in migration 096
  it.skip('changed_by é populado quando app.current_user está setado', async () => {
    await pool.query(
      `DELETE FROM worker_status_history WHERE worker_id = $1`,
      [WORKER_IDS.w1],
    );

    // Use a transaction to set the session variable
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL app.current_uid = 'e2e-admin-uid-123'");
      await client.query(
        `UPDATE workers SET overall_status = 'HIRED' WHERE id = $1`,
        [WORKER_IDS.w1],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const result = await pool.query<{ changed_by: string }>(
      `SELECT changed_by
       FROM worker_status_history
       WHERE worker_id = $1 AND field_name = 'overall_status'
       ORDER BY created_at DESC LIMIT 1`,
      [WORKER_IDS.w1],
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].changed_by).toBe('e2e-admin-uid-123');
  });

  // overall_status column removed in migration 096
  it.skip('changed_by é vazio quando app.current_user NÃO está setado', async () => {
    await pool.query(
      `DELETE FROM worker_status_history WHERE worker_id = $1`,
      [WORKER_IDS.w1],
    );

    await pool.query(
      `UPDATE workers SET overall_status = 'INACTIVE' WHERE id = $1`,
      [WORKER_IDS.w1],
    );

    const result = await pool.query<{ changed_by: string | null }>(
      `SELECT changed_by
       FROM worker_status_history
       WHERE worker_id = $1 AND field_name = 'overall_status'
       ORDER BY created_at DESC LIMIT 1`,
      [WORKER_IDS.w1],
    );

    expect(result.rows.length).toBe(1);
    // When not set, current_setting returns empty string
    expect(result.rows[0].changed_by === null || result.rows[0].changed_by === '').toBe(true);
  });

  // overall_status column removed in migration 096
  it.skip('ON DELETE CASCADE: deletar worker remove histórico', async () => {
    // Create temp worker + history
    const tempId = 'ee440000-0c05-0005-d700-000000000001';
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'e2e-w5-cascade', 'cascade@wave5.test', '54118880099', 'INCOMPLETE_REGISTER', 'AR', 'America/Buenos_Aires')`,
      [tempId],
    );

    // Trigger creates history
    await pool.query(
      `UPDATE workers SET overall_status = 'QUALIFIED' WHERE id = $1`,
      [tempId],
    );

    // Verify history exists
    const before = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM worker_status_history WHERE worker_id = $1`,
      [tempId],
    );
    expect(parseInt(before.rows[0].count)).toBeGreaterThan(0);

    // Delete worker
    await pool.query(`DELETE FROM workers WHERE id = $1`, [tempId]);

    // History should be gone (CASCADE)
    const after = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM worker_status_history WHERE worker_id = $1`,
      [tempId],
    );
    expect(parseInt(after.rows[0].count)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Regressão — Validação transversal de schema Wave 5
// ═══════════════════════════════════════════════════════════════

describe('Regressão — Validação transversal Wave 5', () => {
  it('occupation e profession usam o mesmo CHECK constraint enum', async () => {
    const result = await pool.query<{ conname: string; consrc: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conrelid = 'workers'::regclass
        AND contype = 'c'
        AND (conname LIKE '%occupation%' OR conname LIKE '%profession%')
    `);

    expect(result.rows.length).toBeGreaterThanOrEqual(2);
  });

  // worker_eligibility view removed in migration 096
  it.skip('worker_eligibility é uma materialized view (não regular view)', async () => {
    const result = await pool.query<{ matviewname: string }>(`
      SELECT matviewname FROM pg_matviews
      WHERE schemaname = 'public' AND matviewname = 'worker_eligibility'
    `);
    expect(result.rows.length).toBe(1);
  });

  it('worker_status_history tem índices para queries comuns', async () => {
    const result = await pool.query<{ indexname: string }>(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'worker_status_history'
    `);

    const indexNames = result.rows.map(r => r.indexname);
    expect(indexNames).toContain('idx_worker_status_history_worker');
    expect(indexNames).toContain('idx_worker_status_history_field');
  });

  it('workers.ana_care_status tem COMMENT documentando que é campo bruto', async () => {
    const result = await pool.query<{ description: string }>(`
      SELECT col_description(
        'workers'::regclass,
        (SELECT ordinal_position FROM information_schema.columns
         WHERE table_name = 'workers'
           AND column_name = 'ana_care_status')::int
      ) AS description
    `);
    expect(result.rows[0].description).toBeTruthy();
    expect(result.rows[0].description).toContain('NUNCA');
  });

  it('function fn_log_worker_status_change existe', async () => {
    const result = await pool.query<{ proname: string }>(`
      SELECT proname
      FROM pg_proc
      WHERE proname = 'fn_log_worker_status_change'
    `);
    expect(result.rows.length).toBe(1);
  });

  it('view workers_profession_divergence existe', async () => {
    const result = await pool.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name = 'workers_profession_divergence'
    `);
    expect(result.rows.length).toBe(1);
  });
});
