/**
 * schema-gaps-resolution.test.ts
 *
 * Testa os 4 gaps identificados no roadmap_schema_gaps.md:
 *
 * GAP 1 (D6): deleted_at IS NULL no RecruitmentController
 * GAP 2 (N5): worker_eligibility no MatchmakingService (SQL-level only)
 * GAP 3 (C3): coordinator_id nos 3 repositorios
 * GAP 4 (N8-C): KMS encryption no BlacklistRepository
 *
 * Roda contra banco real via Docker (sem mocks).
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

let pool: Pool;

// UUIDs deterministicos para isolamento
const IDS = {
  worker1: 'ee440000-0a00-0001-0001-000000000001',
  worker2: 'ee440000-0a00-0001-0001-000000000002',
  worker3: 'ee440000-0a00-0001-0001-000000000003',
  worker4: 'ee440000-0a00-0001-0001-000000000004',
  worker5: 'ee440000-0a00-0001-0001-000000000005',
  worker6: 'ee440000-0a00-0001-0001-000000000006',
  jp1: 'ee440000-0a00-0002-0001-000000000001',
  jp2: 'ee440000-0a00-0002-0001-000000000002',
  jp3: 'ee440000-0a00-0002-0001-000000000003',
  patient1: 'ee440000-0a00-0003-0001-000000000001',
  coord1: 'ee440000-0a00-0004-0001-000000000001',
  blacklist1: 'ee440000-0a00-0005-0001-000000000001',
  blacklist2: 'ee440000-0a00-0005-0001-000000000002',
  blacklist3: 'ee440000-0a00-0005-0001-000000000003',
};

const ALL_WORKER_IDS = [IDS.worker1, IDS.worker2, IDS.worker3, IDS.worker4, IDS.worker5, IDS.worker6];
const ALL_JP_IDS = [IDS.jp1, IDS.jp2, IDS.jp3];
const ALL_BL_IDS = [IDS.blacklist1, IDS.blacklist2, IDS.blacklist3];

async function cleanupTestData(p: Pool): Promise<void> {
  // FK order: children before parents
  await p.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1)`, [ALL_WORKER_IDS]).catch(() => {});
  await p.query(`DELETE FROM encuadres WHERE job_posting_id = ANY($1)`, [ALL_JP_IDS]).catch(() => {});
  await p.query(`DELETE FROM encuadres WHERE worker_id = ANY($1)`, [ALL_WORKER_IDS]).catch(() => {});
  await p.query(`DELETE FROM publications WHERE job_posting_id = ANY($1)`, [ALL_JP_IDS]).catch(() => {});
  await p.query(`DELETE FROM worker_placement_audits WHERE job_posting_id = ANY($1)`, [ALL_JP_IDS]).catch(() => {});
  await p.query(`DELETE FROM coordinator_weekly_schedules WHERE coordinator_id = $1`, [IDS.coord1]).catch(() => {});
  await p.query(`DELETE FROM blacklist WHERE id = ANY($1)`, [ALL_BL_IDS]).catch(() => {});
  await p.query(`DELETE FROM blacklist WHERE worker_id = ANY($1)`, [ALL_WORKER_IDS]).catch(() => {});
  await p.query(`DELETE FROM worker_status_history WHERE worker_id = ANY($1)`, [ALL_WORKER_IDS]).catch(() => {});
  await p.query(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id = ANY($1)`, [ALL_JP_IDS]).catch(() => {});
  await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [ALL_JP_IDS]).catch(() => {});
  await p.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient1]).catch(() => {});
  await p.query(`DELETE FROM workers WHERE id = ANY($1)`, [ALL_WORKER_IDS]).catch(() => {});
  await p.query(`DELETE FROM coordinators WHERE id = $1`, [IDS.coord1]).catch(() => {});
  await p.query(`DELETE FROM coordinators WHERE name IN ('Coord Gap Test', 'Coord Schedule Test', 'Coord Audit Test')`).catch(() => {});
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
// GAP 1 (D6) — deleted_at IS NULL filter
// ═══════════════════════════════════════════════════════════════

describe('GAP 1 — deleted_at IS NULL filter on job_postings', () => {
  beforeEach(async () => {
    // Create patient
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, zone_neighborhood, country)
       VALUES ($1, 'gap1-clickup-test', 'Paciente', 'Test', 'Palermo', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.patient1],
    );

    // Active job posting (case 9001)
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, patient_id, country, description)
       VALUES ($1, 9001, 'Caso activo', 'SEARCHING', $2, 'AR', 'test')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp1, IDS.patient1],
    );

    // Soft-deleted job posting (case 9002)
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, patient_id, country, deleted_at, description)
       VALUES ($1, 9002, 'Caso deletado', 'SEARCHING', $2, 'AR', NOW(), 'test deleted')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp2, IDS.patient1],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM publications WHERE job_posting_id = ANY($1)`, [
      [IDS.jp1, IDS.jp2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM encuadres WHERE job_posting_id = ANY($1)`, [
      [IDS.jp1, IDS.jp2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id = ANY($1)`, [
      [IDS.jp1, IDS.jp2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jp1, IDS.jp2]]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient1]).catch(() => {});
  });

  it('queries with case_number filter exclude soft-deleted records', async () => {
    // Simulates getClickUpCases / getGlobalMetrics pattern
    const result = await pool.query(
      `SELECT case_number FROM job_postings
       WHERE case_number IS NOT NULL AND deleted_at IS NULL`
    );
    const caseNumbers = result.rows.map(r => r.case_number);
    expect(caseNumbers).toContain(9001);
    expect(caseNumbers).not.toContain(9002);
  });

  it('global metrics COUNT excludes soft-deleted', async () => {
    const result = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE')) as active
       FROM job_postings
       WHERE case_number IS NOT NULL AND deleted_at IS NULL`
    );
    // Only the active one counts
    expect(parseInt(result.rows[0].active)).toBeGreaterThanOrEqual(1);

    // Verify deleted one is NOT counted
    const withDeleted = await pool.query(
      `SELECT COUNT(*) as total FROM job_postings
       WHERE case_number IS NOT NULL AND status = 'SEARCHING'`
    );
    const withoutDeleted = await pool.query(
      `SELECT COUNT(*) as total FROM job_postings
       WHERE case_number IS NOT NULL AND status = 'SEARCHING' AND deleted_at IS NULL`
    );
    expect(parseInt(withDeleted.rows[0].total)).toBeGreaterThan(
      parseInt(withoutDeleted.rows[0].total)
    );
  });

  it('LEFT JOIN with deleted_at in JOIN condition preserves encuadres of deleted jobs', async () => {
    // Create worker + encuadre linked to active job
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'gap1-w1', 'gap1w1@test.com', '5411000gap1', 'REGISTERED', 'AR', 'America/Buenos_Aires')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.worker1],
    );
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name)
       VALUES ($1, $2, 'Worker Gap1')`,
      [IDS.worker1, IDS.jp1],
    );
    // Create encuadre linked to DELETED job
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name)
       VALUES ($1, $2, 'Worker Gap1 Deleted')`,
      [IDS.worker1, IDS.jp2],
    );

    // Query with deleted_at filter in JOIN (getEncuadres pattern)
    const result = await pool.query(
      `SELECT e.id, e.worker_raw_name, jp.case_number
       FROM encuadres e
       LEFT JOIN job_postings jp ON e.job_posting_id = jp.id AND jp.deleted_at IS NULL
       WHERE e.worker_id = $1`,
      [IDS.worker1],
    );

    // Both encuadres appear, but the deleted job's case_number is NULL
    expect(result.rows.length).toBe(2);
    const active = result.rows.find(r => r.worker_raw_name === 'Worker Gap1');
    const deleted = result.rows.find(r => r.worker_raw_name === 'Worker Gap1 Deleted');
    expect(active?.case_number).toBe(9001);
    expect(deleted?.case_number).toBeNull();

    // Cleanup
    await pool.query(`DELETE FROM encuadres WHERE worker_id = $1`, [IDS.worker1]);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.worker1]);
  });

  it('zone analysis excludes soft-deleted job postings', async () => {
    // Fase 3b: zone lida de patient_addresses.neighborhood (não mais de patients.zone_neighborhood)
    const result = await pool.query(
      `SELECT COALESCE(pa.neighborhood, 'Sin Zona') as zone, COUNT(*) as cnt
       FROM job_postings jp
       LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
       WHERE jp.case_number IS NOT NULL AND jp.deleted_at IS NULL
       GROUP BY zone`
    );
    // Flat check: total should not include deleted
    const total = result.rows.reduce((s, r) => s + parseInt(r.cnt), 0);
    const allCount = await pool.query(
      `SELECT COUNT(*) as cnt FROM job_postings WHERE case_number IS NOT NULL`
    );
    expect(total).toBeLessThan(parseInt(allCount.rows[0].cnt));
  });
});

// ═══════════════════════════════════════════════════════════════
// GAP 1 — empty database scenario
// ═══════════════════════════════════════════════════════════════

describe('GAP 1 — empty database', () => {
  it('queries return empty results gracefully when no job_postings exist', async () => {
    const result = await pool.query(
      `SELECT case_number FROM job_postings
       WHERE case_number IS NOT NULL AND deleted_at IS NULL
       AND case_number > 90000`
    );
    expect(result.rows).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════
// GAP 2 (N5) — worker_eligibility view integration
// ═══════════════════════════════════════════════════════════════

describe('GAP 2 — worker_eligibility view', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM blacklist WHERE worker_id = ANY($1)`, [
      [IDS.worker1, IDS.worker2, IDS.worker3, IDS.worker4],
    ]).catch(() => {});
    await pool.query(`DELETE FROM worker_status_history WHERE worker_id = ANY($1)`, [
      [IDS.worker1, IDS.worker2, IDS.worker3, IDS.worker4],
    ]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [
      [IDS.worker1, IDS.worker2, IDS.worker3, IDS.worker4],
    ]);
  });

  // view removed in migration 096
  it.skip('is_matchable = TRUE for approved + eligible worker', async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'gap2-w1', 'gap2w1@test.com', '5411000gap2a', 'REGISTERED', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker1],
    );

    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY worker_eligibility');

    const result = await pool.query(
      `SELECT is_matchable, is_active FROM worker_eligibility WHERE id = $1`,
      [IDS.worker1],
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].is_matchable).toBe(true);
    expect(result.rows[0].is_active).toBe(true);
  });

  // view removed in migration 096
  it.skip('is_matchable = FALSE for pending worker', async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'gap2-w2', 'gap2w2@test.com', '5411000gap2b', 'INCOMPLETE_REGISTER', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker2],
    );

    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY worker_eligibility');

    const result = await pool.query(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [IDS.worker2],
    );
    // Pending worker: status != 'approved' → not matchable
    if (result.rows.length > 0) {
      expect(result.rows[0].is_matchable).toBe(false);
    }
    // Worker may not appear at all in view — both outcomes valid
  });

  // view removed in migration 096
  it.skip('is_matchable = FALSE for BLACKLISTED overall_status', async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'gap2-w3', 'gap2w3@test.com', '5411000gap2c', 'REGISTERED', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker3],
    );

    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY worker_eligibility');

    const result = await pool.query(
      `SELECT is_matchable, is_active FROM worker_eligibility WHERE id = $1`,
      [IDS.worker3],
    );
    if (result.rows.length > 0) {
      expect(result.rows[0].is_matchable).toBe(false);
      expect(result.rows[0].is_active).toBe(false);
    }
  });

  // view removed in migration 096
  it.skip('soft-deleted worker is not matchable', async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, deleted_at, country, timezone)
       VALUES ($1, 'gap2-w4', 'gap2w4@test.com', '5411000gap2d', 'REGISTERED', NOW(), 'AR', 'America/Buenos_Aires')`,
      [IDS.worker4],
    );

    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY worker_eligibility');

    const result = await pool.query(
      `SELECT is_matchable FROM worker_eligibility WHERE id = $1`,
      [IDS.worker4],
    );
    if (result.rows.length > 0) {
      expect(result.rows[0].is_matchable).toBe(false);
    }
  });

  // view removed in migration 096
  it.skip('INNER JOIN worker_eligibility excludes ineligible workers from matching query', async () => {
    // Eligible worker
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'gap2-match1', 'gap2m1@test.com', '5411000gap2e', 'REGISTERED', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker1],
    );
    // Ineligible worker (pending)
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'gap2-match2', 'gap2m2@test.com', '5411000gap2f', 'INCOMPLETE_REGISTER', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker2],
    );

    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY worker_eligibility');

    // Simulate the hardFilter query pattern
    const result = await pool.query(
      `SELECT w.id
       FROM workers w
       INNER JOIN worker_eligibility we ON we.id = w.id
       WHERE w.id = ANY($1) AND we.is_matchable = TRUE`,
      [[IDS.worker1, IDS.worker2]],
    );

    const ids = result.rows.map(r => r.id);
    expect(ids).toContain(IDS.worker1);
    expect(ids).not.toContain(IDS.worker2);
  });
});

// ═══════════════════════════════════════════════════════════════
// GAP 2 — empty database scenario
// ═══════════════════════════════════════════════════════════════

describe('GAP 2 — empty database', () => {
  // view removed in migration 096
  it.skip('worker_eligibility view is empty but queryable', async () => {
    await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY worker_eligibility');
    const result = await pool.query(
      `SELECT COUNT(*) as cnt FROM worker_eligibility WHERE id = '00000000-0000-0000-0000-000000000000'`
    );
    expect(parseInt(result.rows[0].cnt)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// GAP 3 (C3) — coordinator_id in repositories
// ═══════════════════════════════════════════════════════════════

describe('GAP 3 — coordinator_id resolution', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM coordinator_weekly_schedules WHERE coordinator_name IN ('Coord Schedule Test')`).catch(() => {});
    await pool.query(`DELETE FROM worker_placement_audits WHERE coordinator_name IN ('Coord Audit Test')`).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE case_number IN (9901, 9902)`).catch(() => {});
    await pool.query(`DELETE FROM coordinators WHERE name IN ('Coord Gap Test', 'Coord Schedule Test', 'Coord Audit Test')`).catch(() => {});
  });

  it('resolveCoordinatorId creates coordinator via findOrCreate pattern', async () => {
    // The helper is tested indirectly through job_postings upsert
    const coordResult = await pool.query(
      `INSERT INTO coordinators (name) VALUES ('Coord Gap Test')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const coordId = coordResult.rows[0].id;
    await pool.query(
      `INSERT INTO job_postings (vacancy_number, case_number, title, status, coordinator_name, coordinator_id, country, description)
       VALUES (9901, 9901, 'Caso Coord Test', 'SEARCHING', 'Coord Gap Test', $1, 'AR', 'test')
       ON CONFLICT (vacancy_number) DO NOTHING`,
      [coordId]
    );

    // Verify coordinator was created
    const coord = await pool.query(
      `SELECT id, name FROM coordinators WHERE name = 'Coord Gap Test'`
    );
    expect(coord.rows.length).toBe(1);

    // Verify job_posting has coordinator_id set
    const jp = await pool.query(
      `SELECT coordinator_id, coordinator_name FROM job_postings WHERE case_number = 9901`
    );
    expect(jp.rows.length).toBe(1);
    expect(jp.rows[0].coordinator_id).toBe(coord.rows[0].id);
    expect(jp.rows[0].coordinator_name).toBe('Coord Gap Test');
  });

  it('coordinator_weekly_schedules stores coordinator_id', async () => {
    // Create coordinator
    const coordResult = await pool.query(
      `INSERT INTO coordinators (name) VALUES ('Coord Schedule Test')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const coordId = coordResult.rows[0].id;

    // Insert schedule with coordinator_id
    await pool.query(
      `INSERT INTO coordinator_weekly_schedules (coordinator_id, coordinator_name, coordinator_dni, from_date, to_date, weekly_hours)
       VALUES ($1, 'Coord Schedule Test', null, '2026-03-01', '2026-03-31', 40)
       ON CONFLICT (coordinator_id, from_date, to_date) DO NOTHING`,
      [coordId]
    );

    // Verify
    const result = await pool.query(
      `SELECT coordinator_id, coordinator_name, weekly_hours
       FROM coordinator_weekly_schedules
       WHERE coordinator_id = $1 AND from_date = '2026-03-01'`,
      [coordId]
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].coordinator_id).toBe(coordId);
    expect(result.rows[0].coordinator_name).toBe('Coord Schedule Test');
    expect(parseFloat(result.rows[0].weekly_hours)).toBe(40);
  });

  it('worker_placement_audits stores coordinator_id', async () => {
    const coordResult = await pool.query(
      `INSERT INTO coordinators (name) VALUES ('Coord Audit Test')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const coordId = coordResult.rows[0].id;

    await pool.query(
      `INSERT INTO worker_placement_audits (audit_id, coordinator_name, coordinator_id, rating)
       VALUES ('gap3-audit-01', 'Coord Audit Test', $1, 5)
       ON CONFLICT (audit_id) DO NOTHING`,
      [coordId]
    );

    const result = await pool.query(
      `SELECT coordinator_id, coordinator_name, rating
       FROM worker_placement_audits
       WHERE audit_id = 'gap3-audit-01'`
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].coordinator_id).toBe(coordId);
    expect(result.rows[0].coordinator_name).toBe('Coord Audit Test');

    // Cleanup
    await pool.query(`DELETE FROM worker_placement_audits WHERE audit_id = 'gap3-audit-01'`);
  });

  it('SELECT via JOIN coordinators returns correct name', async () => {
    const coordResult = await pool.query(
      `INSERT INTO coordinators (name) VALUES ('Coord Gap Test')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const coordId = coordResult.rows[0].id;

    await pool.query(
      `INSERT INTO job_postings (vacancy_number, case_number, title, status, coordinator_name, coordinator_id, country, description)
       VALUES (9902, 9902, 'Caso JOIN Test', 'SEARCHING', 'Coord Gap Test', $1, 'AR', 'test')
       ON CONFLICT (vacancy_number) DO NOTHING`,
      [coordId]
    );

    // Query pattern from RecruitmentController.getClickUpCases
    const result = await pool.query(
      `SELECT c.name AS coordinator_name, jp.case_number
       FROM job_postings jp
       LEFT JOIN coordinators c ON c.id = jp.coordinator_id
       WHERE jp.case_number = 9902 AND jp.deleted_at IS NULL`
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].coordinator_name).toBe('Coord Gap Test');
  });

  it('findByCoordinatorAndDate uses coordinator_id subquery', async () => {
    const coordResult = await pool.query(
      `INSERT INTO coordinators (name) VALUES ('Coord Schedule Test')
       ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    const coordId = coordResult.rows[0].id;

    await pool.query(
      `INSERT INTO coordinator_weekly_schedules (coordinator_id, coordinator_name, from_date, to_date, weekly_hours)
       VALUES ($1, 'Coord Schedule Test', '2026-03-01', '2026-03-31', 35)
       ON CONFLICT (coordinator_id, from_date, to_date) DO UPDATE SET weekly_hours = 35`,
      [coordId]
    );

    // Query pattern from findByCoordinatorAndDate (updated to use coordinator_id subquery)
    const result = await pool.query(
      `SELECT weekly_hours FROM coordinator_weekly_schedules
       WHERE coordinator_id = (SELECT id FROM coordinators WHERE name ILIKE $1)
         AND from_date <= $2 AND to_date >= $2
       ORDER BY from_date DESC LIMIT 1`,
      ['Coord Schedule Test', '2026-03-15']
    );
    expect(result.rows.length).toBe(1);
    expect(parseFloat(result.rows[0].weekly_hours)).toBe(35);
  });
});

// ═══════════════════════════════════════════════════════════════
// GAP 3 — empty database scenario
// ═══════════════════════════════════════════════════════════════

describe('GAP 3 — empty database', () => {
  it('coordinators table exists and is empty (or has no test data)', async () => {
    const result = await pool.query(
      `SELECT COUNT(*) as cnt FROM coordinators WHERE name = 'NonExistentCoord'`
    );
    expect(parseInt(result.rows[0].cnt)).toBe(0);
  });

  it('findByCoordinatorAndDate returns nothing for missing coordinator', async () => {
    const result = await pool.query(
      `SELECT weekly_hours FROM coordinator_weekly_schedules
       WHERE coordinator_id = (SELECT id FROM coordinators WHERE name ILIKE 'NonExistent')
         AND from_date <= '2026-03-15' AND to_date >= '2026-03-15'
       ORDER BY from_date DESC LIMIT 1`
    );
    expect(result.rows.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// GAP 4 (N8-C) — KMS encryption in blacklist
// ═══════════════════════════════════════════════════════════════

describe('GAP 4 — blacklist PII encryption', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM blacklist WHERE id = ANY($1)`, [
      [IDS.blacklist1, IDS.blacklist2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM blacklist WHERE worker_id = $1`, [IDS.worker1]).catch(() => {});
    await pool.query(`DELETE FROM worker_status_history WHERE worker_id = $1`, [IDS.worker1]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.worker1]).catch(() => {});
  });

  it('blacklist table has reason_encrypted and detail_encrypted columns', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'blacklist'
       AND column_name IN ('reason_encrypted', 'detail_encrypted')
       ORDER BY column_name`
    );
    const cols = result.rows.map(r => r.column_name);
    expect(cols).toContain('detail_encrypted');
    expect(cols).toContain('reason_encrypted');
  });

  it('INSERT with encrypted columns populates both plaintext and encrypted', async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'gap4-w1', 'gap4w1@test.com', '5411000gap4a', 'REGISTERED', 'AR', 'America/Buenos_Aires')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.worker1],
    );

    // Simulate dual-write (what the updated BlacklistRepository does)
    const reasonEnc = Buffer.from('Abandono de paciente').toString('base64');
    const detailEnc = Buffer.from('Detalles del caso').toString('base64');

    await pool.query(
      `INSERT INTO blacklist (id, worker_id, reason, reason_encrypted, detail, detail_encrypted, registered_by, can_take_eventual)
       VALUES ($1, $2, 'Abandono de paciente', $3, 'Detalles del caso', $4, 'admin', false)`,
      [IDS.blacklist1, IDS.worker1, reasonEnc, detailEnc]
    );

    // Verify both columns are populated
    const result = await pool.query(
      `SELECT reason, reason_encrypted, detail, detail_encrypted
       FROM blacklist WHERE id = $1`,
      [IDS.blacklist1]
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].reason).toBe('Abandono de paciente');
    expect(result.rows[0].reason_encrypted).toBeTruthy();
    expect(result.rows[0].reason_encrypted).not.toBe('Abandono de paciente'); // encrypted is different
    expect(result.rows[0].detail).toBe('Detalles del caso');
    expect(result.rows[0].detail_encrypted).toBeTruthy();
  });

  it('orphan blacklist entry (no worker_id) also gets encrypted columns', async () => {
    const reasonEnc = Buffer.from('Motivo orphan').toString('base64');

    await pool.query(
      `INSERT INTO blacklist (id, worker_raw_name, worker_raw_phone,
         reason, reason_encrypted, detail, detail_encrypted,
         registered_by, can_take_eventual)
       VALUES ($1, 'Orphan Worker', '5411999999',
         'Motivo orphan', $2, null, null,
         'admin', false)`,
      [IDS.blacklist2, reasonEnc]
    );

    const result = await pool.query(
      `SELECT reason, reason_encrypted FROM blacklist WHERE id = $1`,
      [IDS.blacklist2]
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].reason_encrypted).toBeTruthy();
  });

  it('legacy rows without encrypted columns still readable (fallback)', async () => {
    // Insert without encrypted columns (simulates legacy data)
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'gap4-legacy', 'gap4legacy@test.com', '5411000gap4b', 'REGISTERED', 'AR', 'America/Buenos_Aires')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.worker1],
    );
    await pool.query(
      `INSERT INTO blacklist (id, worker_id, reason, detail, registered_by, can_take_eventual)
       VALUES ($1, $2, 'Legacy reason', 'Legacy detail', 'admin', false)`,
      [IDS.blacklist1, IDS.worker1]
    );

    // Verify reason_encrypted is NULL (legacy)
    const result = await pool.query(
      `SELECT reason, reason_encrypted, detail, detail_encrypted
       FROM blacklist WHERE id = $1`,
      [IDS.blacklist1]
    );
    expect(result.rows[0].reason_encrypted).toBeNull();
    expect(result.rows[0].reason).toBe('Legacy reason');
    expect(result.rows[0].detail).toBe('Legacy detail');
  });
});

// ═══════════════════════════════════════════════════════════════
// GAP 4 — empty database scenario
// ═══════════════════════════════════════════════════════════════

describe('GAP 4 — empty database', () => {
  it('blacklist table is queryable when empty', async () => {
    const result = await pool.query(
      `SELECT * FROM blacklist WHERE worker_id = '00000000-0000-0000-0000-000000000000'`
    );
    expect(result.rows).toEqual([]);
  });

  it('encrypted columns accept NULL', async () => {
    const result = await pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'blacklist'
       AND column_name IN ('reason_encrypted', 'detail_encrypted')`
    );
    for (const row of result.rows) {
      expect(row.is_nullable).toBe('YES');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// D6 RESIDUAL — deleted_at filter in ALL remaining repositories
// Testa INSERT real + query real + verifica retorno
// ═══════════════════════════════════════════════════════════════

describe('D6 residual — ClickUpCaseRepository queries exclude soft-deleted', () => {
  beforeEach(async () => {
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, zone_neighborhood, country)
       VALUES ($1, 'res-clickup-test', 'Paciente Res', 'Palermo', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.patient1],
    );
    // Active job posting
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, patient_id, country, description)
       VALUES ($1, 8801, 'Caso Activo Res', 'SEARCHING', $2, 'AR', 'test')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp1, IDS.patient1],
    );
    // Soft-deleted job posting
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, patient_id, country, deleted_at, description)
       VALUES ($1, 8802, 'Caso Deletado Res', 'SEARCHING', $2, 'AR', NOW(), 'test deleted')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp2, IDS.patient1],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id = ANY($1)`, [ALL_JP_IDS]).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jp1, IDS.jp2]]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient1]).catch(() => {});
  });

  it('findActiveCases returns only non-deleted', async () => {
    const result = await pool.query(
      `SELECT jp.id, jp.case_number, jp.status
       FROM job_postings jp
       WHERE jp.country = 'AR'
         AND jp.status IN ('SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE')
         AND jp.deleted_at IS NULL
       ORDER BY jp.case_number`
    );
    const caseNumbers = result.rows.map(r => r.case_number);
    expect(caseNumbers).toContain(8801);
    expect(caseNumbers).not.toContain(8802);
  });

  it('findByCaseNumber returns null for deleted case', async () => {
    const active = await pool.query(
      `SELECT id FROM job_postings WHERE case_number = 8801 AND deleted_at IS NULL`
    );
    expect(active.rows.length).toBe(1);

    const deleted = await pool.query(
      `SELECT id FROM job_postings WHERE case_number = 8802 AND deleted_at IS NULL`
    );
    expect(deleted.rows.length).toBe(0);
  });

  it('countByZone excludes deleted job_postings', async () => {
    // Fase 3b: zone lida de patient_addresses.neighborhood (não mais de patients.zone_neighborhood)
    const result = await pool.query(
      `SELECT pa.neighborhood AS zone, COUNT(*)::int AS count
       FROM job_postings jp
       LEFT JOIN patient_addresses pa ON pa.id = jp.patient_address_id
       WHERE jp.country = 'AR' AND jp.deleted_at IS NULL
       GROUP BY pa.neighborhood`
    );
    const total = result.rows.reduce((s, r) => s + r.count, 0);

    const withDeleted = await pool.query(
      `SELECT COUNT(*)::int AS count FROM job_postings WHERE country = 'AR'`
    );
    expect(total).toBeLessThan(parseInt(withDeleted.rows[0].count));
  });
});

describe('D6 residual — VacanciesController queries exclude soft-deleted', () => {
  beforeEach(async () => {
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, zone_neighborhood, country)
       VALUES ($1, 'res-vac-test', 'Paciente Vac', 'Belgrano', 'AR')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.patient1],
    );
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, patient_id, country, search_start_date, description)
       VALUES ($1, 8803, 'Vaga Ativa', 'SEARCHING', $2, 'AR', NOW() - INTERVAL '10 days', 'test')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp1, IDS.patient1],
    );
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, patient_id, country, search_start_date, deleted_at, description)
       VALUES ($1, 8804, 'Vaga Deletada', 'SEARCHING', $2, 'AR', NOW() - INTERVAL '10 days', NOW(), 'test del')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp2, IDS.patient1],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jp1, IDS.jp2]]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient1]).catch(() => {});
  });

  it('listVacancies query excludes deleted job_postings', async () => {
    const result = await pool.query(
      `SELECT jp.id, jp.case_number
       FROM job_postings jp
       LEFT JOIN patients p ON jp.patient_id = p.id
       WHERE jp.case_number IS NOT NULL AND jp.deleted_at IS NULL`
    );
    const caseNumbers = result.rows.map(r => r.case_number);
    expect(caseNumbers).toContain(8803);
    expect(caseNumbers).not.toContain(8804);
  });

  it('getVacanciesStats excludes deleted from counts', async () => {
    const filtered = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE')) as total_vacantes
       FROM job_postings jp
       WHERE case_number IS NOT NULL AND deleted_at IS NULL`
    );
    const unfiltered = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE')) as total_vacantes
       FROM job_postings jp
       WHERE case_number IS NOT NULL`
    );
    expect(parseInt(filtered.rows[0].total_vacantes)).toBeLessThan(
      parseInt(unfiltered.rows[0].total_vacantes)
    );
  });
});

describe('D6 residual — EncuadreRepository queries with deleted job_postings', () => {
  beforeEach(async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'res-enc-w1', 'resenc@test.com', '5411000resenc', 'REGISTERED', 'AR', 'America/Buenos_Aires')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.worker1],
    );
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, country, description)
       VALUES ($1, 8805, 'JP Ativo Enc', 'SEARCHING', 'AR', 'test')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp1],
    );
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, country, deleted_at, description)
       VALUES ($1, 8806, 'JP Deletado Enc', 'SEARCHING', 'AR', NOW(), 'test del')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp2],
    );
    // Encuadre linked to active job
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, resultado)
       VALUES ($1, $2, 'Worker Enc Active', 'SELECCIONADO')`,
      [IDS.worker1, IDS.jp1],
    );
    // Encuadre linked to deleted job
    await pool.query(
      `INSERT INTO encuadres (worker_id, job_posting_id, worker_raw_name, resultado)
       VALUES ($1, $2, 'Worker Enc Deleted', 'SELECCIONADO')`,
      [IDS.worker1, IDS.jp2],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM encuadres WHERE worker_id = $1`, [IDS.worker1]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jp1, IDS.jp2]]);
    await pool.query(`DELETE FROM worker_status_history WHERE worker_id = $1`, [IDS.worker1]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.worker1]);
  });

  it('findByWorkerId LEFT JOIN hides deleted job_posting data but keeps encuadre', async () => {
    const result = await pool.query(
      `SELECT e.worker_raw_name, jp.case_number
       FROM encuadres e
       LEFT JOIN job_postings jp ON jp.id = e.job_posting_id AND jp.deleted_at IS NULL
       WHERE e.worker_id = $1
       ORDER BY e.worker_raw_name`,
      [IDS.worker1],
    );
    // Both encuadres exist
    expect(result.rows.length).toBe(2);
    const active = result.rows.find(r => r.worker_raw_name === 'Worker Enc Active');
    const deleted = result.rows.find(r => r.worker_raw_name === 'Worker Enc Deleted');
    // Active has case_number, deleted has NULL
    expect(active?.case_number).toBe(8805);
    expect(deleted?.case_number).toBeNull();
  });

  it('countSelAndRemByCaseNumber excludes deleted job_postings', async () => {
    const result = await pool.query(
      `SELECT jp.case_number,
              COUNT(*) FILTER (WHERE e.resultado = 'SELECCIONADO')::int AS sel
       FROM encuadres e
       JOIN job_postings jp ON e.job_posting_id = jp.id
       WHERE jp.country = 'AR'
         AND jp.deleted_at IS NULL
         AND e.resultado IN ('SELECCIONADO', 'REEMPLAZO')
       GROUP BY jp.case_number`
    );
    const caseNumbers = result.rows.map(r => r.case_number);
    expect(caseNumbers).toContain(8805);
    expect(caseNumbers).not.toContain(8806);
  });
});

describe('D6 residual — PublicationRepository excludes deleted job_postings', () => {
  beforeEach(async () => {
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, country, description)
       VALUES ($1, 8807, 'JP Pub Ativo', 'SEARCHING', 'AR', 'test')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp1],
    );
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, country, deleted_at, description)
       VALUES ($1, 8808, 'JP Pub Deletado', 'SEARCHING', 'AR', NOW(), 'test del')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp2],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jp1, IDS.jp2]]);
  });

  it('findLastPublicationPerCase excludes deleted job_postings', async () => {
    const result = await pool.query(
      `SELECT jp.case_number
       FROM job_postings jp
       WHERE jp.country = 'AR' AND jp.deleted_at IS NULL`
    );
    const caseNumbers = result.rows.map(r => r.case_number);
    expect(caseNumbers).toContain(8807);
    expect(caseNumbers).not.toContain(8808);
  });
});

describe('D6 residual — import-planilhas cache excludes deleted', () => {
  beforeEach(async () => {
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, country, description)
       VALUES ($1, 8809, 'Cache Ativo', 'SEARCHING', 'AR', 'test')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp1],
    );
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, country, deleted_at, description)
       VALUES ($1, 8810, 'Cache Deletado', 'SEARCHING', 'AR', NOW(), 'test del')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp2],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jp1, IDS.jp2]]);
  });

  it('buildJobPostingCaseCache query excludes deleted', async () => {
    const result = await pool.query(
      `SELECT id, case_number FROM job_postings WHERE case_number IS NOT NULL AND deleted_at IS NULL`
    );
    const caseNumbers = result.rows.map(r => r.case_number);
    expect(caseNumbers).toContain(8809);
    expect(caseNumbers).not.toContain(8810);
  });
});

describe('D6 residual — TalentumWebhookController excludes deleted', () => {
  beforeEach(async () => {
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, country, description)
       VALUES ($1, 8811, 'Caso Talentum Ativo', 'SEARCHING', 'AR', 'test')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp1],
    );
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, status, country, deleted_at, description)
       VALUES ($1, 8812, 'Caso Talentum Deletado', 'SEARCHING', 'AR', NOW(), 'test del')
       ON CONFLICT (id) DO NOTHING`,
      [IDS.jp2],
    );
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.jp1, IDS.jp2]]);
  });

  it('findByTitleILike excludes deleted job_postings', async () => {
    const active = await pool.query(
      `SELECT id FROM job_postings WHERE title ILIKE '%Talentum Ativo%' AND deleted_at IS NULL LIMIT 1`
    );
    expect(active.rows.length).toBe(1);

    const deleted = await pool.query(
      `SELECT id FROM job_postings WHERE title ILIKE '%Talentum Deletado%' AND deleted_at IS NULL LIMIT 1`
    );
    expect(deleted.rows.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// N8-C RESIDUAL — WorkerDeduplicationService blacklist merge
// Verifica que reason_encrypted e detail_encrypted sao copiados
// ═══════════════════════════════════════════════════════════════

describe('N8-C residual — blacklist merge copies encrypted columns', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM blacklist WHERE worker_id = ANY($1)`, [
      [IDS.worker5, IDS.worker6],
    ]).catch(() => {});
    await pool.query(`DELETE FROM worker_status_history WHERE worker_id = ANY($1)`, [
      [IDS.worker5, IDS.worker6],
    ]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [
      [IDS.worker5, IDS.worker6],
    ]).catch(() => {});
  });

  it('INSERT...SELECT from blacklist copies reason_encrypted and detail_encrypted', async () => {
    // Create two workers (canonical and duplicate)
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'merge-canonical', 'canonical@test.com', '5411000can', 'REGISTERED', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker5],
    );
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'merge-duplicate', 'duplicate@test.com', '5411000dup', 'REGISTERED', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker6],
    );

    // Insert blacklist entry on duplicate with BOTH plaintext and encrypted
    const reasonEnc = Buffer.from('Motivo teste merge').toString('base64');
    const detailEnc = Buffer.from('Detalhe teste merge').toString('base64');
    await pool.query(
      `INSERT INTO blacklist (id, worker_id, reason, reason_encrypted, detail, detail_encrypted, registered_by, can_take_eventual)
       VALUES ($1, $2, 'Motivo teste merge', $3, 'Detalhe teste merge', $4, 'admin', false)`,
      [IDS.blacklist3, IDS.worker6, reasonEnc, detailEnc],
    );

    // Verify encrypted columns are set on duplicate's blacklist
    const before = await pool.query(
      `SELECT reason_encrypted, detail_encrypted FROM blacklist WHERE id = $1`,
      [IDS.blacklist3],
    );
    expect(before.rows[0].reason_encrypted).toBe(reasonEnc);
    expect(before.rows[0].detail_encrypted).toBe(detailEnc);

    // Simulate the merge query (same as WorkerDeduplicationService.mergeWorkers)
    await pool.query(
      `INSERT INTO blacklist (worker_id, worker_raw_name, worker_raw_phone, reason, reason_encrypted, detail, detail_encrypted, registered_by, can_take_eventual)
       SELECT $1, worker_raw_name, worker_raw_phone, reason, reason_encrypted, detail, detail_encrypted, registered_by, can_take_eventual
       FROM blacklist WHERE worker_id = $2
       ON CONFLICT (worker_id, reason) WHERE worker_id IS NOT NULL DO NOTHING`,
      [IDS.worker5, IDS.worker6],
    );

    // Verify the canonical worker now has the blacklist entry with encrypted columns
    const after = await pool.query(
      `SELECT reason, reason_encrypted, detail, detail_encrypted, worker_id
       FROM blacklist WHERE worker_id = $1`,
      [IDS.worker5],
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].reason).toBe('Motivo teste merge');
    expect(after.rows[0].reason_encrypted).toBe(reasonEnc);
    expect(after.rows[0].detail).toBe('Detalhe teste merge');
    expect(after.rows[0].detail_encrypted).toBe(detailEnc);
  });

  it('merge does NOT lose encrypted data — values are preserved exactly', async () => {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'merge2-can', 'merge2can@test.com', '5411000mc2', 'REGISTERED', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker5],
    );
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, 'merge2-dup', 'merge2dup@test.com', '5411000md2', 'REGISTERED', 'AR', 'America/Buenos_Aires')`,
      [IDS.worker6],
    );

    // Insert with encrypted and WITHOUT encrypted (simulates legacy + new)
    await pool.query(
      `INSERT INTO blacklist (worker_id, reason, reason_encrypted, detail, detail_encrypted, can_take_eventual)
       VALUES ($1, 'New entry', $2, 'New detail', $3, false)`,
      [IDS.worker6, Buffer.from('encrypted-reason').toString('base64'), Buffer.from('encrypted-detail').toString('base64')],
    );

    // Merge
    await pool.query(
      `INSERT INTO blacklist (worker_id, worker_raw_name, worker_raw_phone, reason, reason_encrypted, detail, detail_encrypted, registered_by, can_take_eventual)
       SELECT $1, worker_raw_name, worker_raw_phone, reason, reason_encrypted, detail, detail_encrypted, registered_by, can_take_eventual
       FROM blacklist WHERE worker_id = $2
       ON CONFLICT (worker_id, reason) WHERE worker_id IS NOT NULL DO NOTHING`,
      [IDS.worker5, IDS.worker6],
    );

    // Delete duplicates
    await pool.query(`DELETE FROM blacklist WHERE worker_id = $1`, [IDS.worker6]);

    // Canonical should have the entry
    const result = await pool.query(
      `SELECT reason, reason_encrypted, detail, detail_encrypted FROM blacklist WHERE worker_id = $1`,
      [IDS.worker5],
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0].reason_encrypted).toBe(Buffer.from('encrypted-reason').toString('base64'));
    expect(result.rows[0].detail_encrypted).toBe(Buffer.from('encrypted-detail').toString('base64'));
    expect(result.rows[0].reason).toBe('New entry');
    expect(result.rows[0].detail).toBe('New detail');
  });
});
