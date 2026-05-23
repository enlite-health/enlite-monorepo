/**
 * wave7-operational.test.ts
 *
 * Testa os 5 itens do Wave 7 do roadmap de correcao de schema,
 * contra o banco real (sem mocks).
 *
 * D1: geography em worker_service_areas
 * D2: 3 mecanismos de messaging documentados + ON DELETE SET NULL
 * D8: tokenizacao de variables PII
 * D9: politica de retencao + job de archiving
 * I3: current_applicants removido, funcao computed
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

let pool: Pool;

// Deterministic UUIDs for test isolation (wave7 prefix)
const IDS = {
  worker1: 'ee770000-0007-0007-0001-000000000001',
  worker2: 'ee770000-0007-0007-0001-000000000002',
  worker3: 'ee770000-0007-0007-0001-000000000003',
  job1:    'ee770000-0007-0007-0002-000000000001',
  job2:    'ee770000-0007-0007-0002-000000000002',
};

async function cleanupTestData(p: Pool): Promise<void> {
  // FK order: children first
  await p.query(`DELETE FROM messaging_variable_tokens WHERE worker_id = ANY($1)`, [
    [IDS.worker1, IDS.worker2, IDS.worker3],
  ]).catch(() => {});
  await p.query(`DELETE FROM messaging_outbox WHERE worker_id = ANY($1)`, [
    [IDS.worker1, IDS.worker2, IDS.worker3],
  ]).catch(() => {});
  await p.query(`DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id = ANY($1)`, [
    [IDS.worker1, IDS.worker2, IDS.worker3],
  ]).catch(() => {});
  await p.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1)`, [
    [IDS.job1, IDS.job2],
  ]).catch(() => {});
  await p.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1)`, [
    [IDS.worker1, IDS.worker2, IDS.worker3],
  ]).catch(() => {});
  await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.job1, IDS.job2]]).catch(() => {});
  await p.query(`DELETE FROM workers WHERE id = ANY($1)`, [
    [IDS.worker1, IDS.worker2, IDS.worker3],
  ]).catch(() => {});
}

let workerCounter = 0;
async function createTestWorker(p: Pool, id: string, phone: string): Promise<void> {
  workerCounter++;
  const authUid = `e2e-wave7-uid-${workerCounter}-${Date.now()}`;
  const email = `wave7-${workerCounter}@test.local`;
  await p.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
     VALUES ($1, $2, $3, $4, 'REGISTERED', 'AR', 'America/Buenos_Aires')
     ON CONFLICT (id) DO NOTHING`,
    [id, authUid, email, phone]
  );
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
// D1 — geography em worker_service_areas
// =================================================================

describe('D1 — geography em worker_service_areas', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [IDS.worker1]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.worker1]).catch(() => {});
  });

  it('worker_service_areas tem coluna location geography', async () => {
    const result = await pool.query(
      `SELECT column_name, udt_name FROM information_schema.columns
       WHERE table_name = 'worker_service_areas' AND column_name = 'location'`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].udt_name).toBe('geography');
  });

  it('coluna location eh GENERATED ALWAYS', async () => {
    const result = await pool.query(
      `SELECT is_generated FROM information_schema.columns
       WHERE table_name = 'worker_service_areas' AND column_name = 'location'`
    );
    expect(result.rows[0].is_generated).toBe('ALWAYS');
  });

  it('indice GIST existe em worker_service_areas.location', async () => {
    const result = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'worker_service_areas'
         AND indexname = 'idx_worker_service_areas_location'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('inserir lat/lng popula location automaticamente', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000001');

    await pool.query(
      `INSERT INTO worker_service_areas (worker_id, latitude, longitude, radius_km, country)
       VALUES ($1, -34.603722, -58.381592, 10, 'AR')`,
      [IDS.worker1]
    );

    const result = await pool.query(
      `SELECT location IS NOT NULL AS has_location,
              ST_Y(location::geometry) AS lat,
              ST_X(location::geometry) AS lng
       FROM worker_service_areas WHERE worker_id = $1`,
      [IDS.worker1]
    );
    expect(result.rows[0].has_location).toBe(true);
    expect(parseFloat(result.rows[0].lat)).toBeCloseTo(-34.603722, 4);
    expect(parseFloat(result.rows[0].lng)).toBeCloseTo(-58.381592, 4);
  });

  it('ST_DWithin funciona em worker_service_areas', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000002');

    // Ponto em Buenos Aires: -34.603722, -58.381592
    await pool.query(
      `INSERT INTO worker_service_areas (worker_id, latitude, longitude, radius_km, country)
       VALUES ($1, -34.603722, -58.381592, 10, 'AR')`,
      [IDS.worker1]
    );

    // Ponto proximo (dentro de 5km)
    const nearby = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM worker_service_areas
       WHERE ST_DWithin(
         location,
         ST_MakePoint(-58.380, -34.604)::geography,
         5000
       )
       AND worker_id = $1`,
      [IDS.worker1]
    );
    expect(nearby.rows[0].cnt).toBe(1);

    // Ponto distante (Cordoba, >600km)
    const faraway = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM worker_service_areas
       WHERE ST_DWithin(
         location,
         ST_MakePoint(-64.190, -31.420)::geography,
         5000
       )
       AND worker_id = $1`,
      [IDS.worker1]
    );
    expect(faraway.rows[0].cnt).toBe(0);
  });
});

// =================================================================
// D2 — Tres mecanismos de messaging
// =================================================================

describe('D2 — messaging: TABLE COMMENT + ON DELETE SET NULL', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM messaging_outbox WHERE worker_id = ANY($1::uuid[])`, [
      [IDS.worker1, IDS.worker2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id = ANY($1::uuid[])`, [
      [IDS.worker1, IDS.worker2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [
      [IDS.worker1, IDS.worker2],
    ]).catch(() => {});
  });

  it('messaging_outbox tem TABLE COMMENT', async () => {
    const result = await pool.query(
      `SELECT obj_description('messaging_outbox'::regclass) AS comment`
    );
    expect(result.rows[0].comment).toBeTruthy();
    expect(result.rows[0].comment).toMatch(/transacional|retry/i);
  });

  it('whatsapp_bulk_dispatch_logs tem TABLE COMMENT', async () => {
    const result = await pool.query(
      `SELECT obj_description('whatsapp_bulk_dispatch_logs'::regclass) AS comment`
    );
    expect(result.rows[0].comment).toBeTruthy();
    expect(result.rows[0].comment).toMatch(/massa|bulk/i);
  });

  it('messaging_outbox.worker_id tem ON DELETE SET NULL', async () => {
    const result = await pool.query(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'messaging_outbox'::regclass
         AND contype = 'f'
         AND conname = 'messaging_outbox_worker_id_fkey'`
    );
    // 'n' = SET NULL
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].confdeltype).toBe('n');
  });

  it('whatsapp_bulk_dispatch_logs.worker_id tem ON DELETE SET NULL', async () => {
    const result = await pool.query(
      `SELECT confdeltype FROM pg_constraint
       WHERE conrelid = 'whatsapp_bulk_dispatch_logs'::regclass
         AND contype = 'f'
         AND conname = 'whatsapp_bulk_dispatch_logs_worker_id_fkey'`
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].confdeltype).toBe('n');
  });

  it('deletar worker com mensagens NAO falha com RESTRICT', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000010');

    // Criar registro em messaging_outbox
    await pool.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables)
       VALUES ($1, 'test_template', '{}')`,
      [IDS.worker1]
    );

    // Criar registro em whatsapp_bulk_dispatch_logs
    await pool.query(
      `INSERT INTO whatsapp_bulk_dispatch_logs
       (worker_id, triggered_by, phone, template_slug, status)
       VALUES ($1, 'admin-uid-test', '+5491100000010', 'bulk_test', 'sent')`,
      [IDS.worker1]
    );

    // Deletar worker — NÃO deve falhar
    await expect(
      pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.worker1])
    ).resolves.toBeDefined();

    // worker_id deve ser NULL nos registros remanescentes
    const outbox = await pool.query(
      `SELECT worker_id FROM messaging_outbox WHERE template_slug = 'test_template'`
    );
    if (outbox.rows.length > 0) {
      expect(outbox.rows[0].worker_id).toBeNull();
    }

    const bulk = await pool.query(
      `SELECT worker_id FROM whatsapp_bulk_dispatch_logs WHERE template_slug = 'bulk_test'`
    );
    if (bulk.rows.length > 0) {
      expect(bulk.rows[0].worker_id).toBeNull();
    }

    // Cleanup logs
    await pool.query(`DELETE FROM messaging_outbox WHERE template_slug = 'test_template'`).catch(() => {});
    await pool.query(`DELETE FROM whatsapp_bulk_dispatch_logs WHERE template_slug = 'bulk_test'`).catch(() => {});
  });
});

// =================================================================
// D8 — Tokenizacao de variaveis PII
// =================================================================

describe('D8 — messaging_variable_tokens para PII', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM messaging_variable_tokens WHERE worker_id = $1`, [IDS.worker1]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.worker1]).catch(() => {});
  });

  it('tabela messaging_variable_tokens existe', async () => {
    const result = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name = 'messaging_variable_tokens'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('estrutura correta: id, token, field_name, worker_id, expires_at, created_at', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'messaging_variable_tokens'
       ORDER BY ordinal_position`
    );
    const cols = result.rows.map((r: any) => r.column_name);
    expect(cols).toContain('id');
    expect(cols).toContain('token');
    expect(cols).toContain('field_name');
    expect(cols).toContain('worker_id');
    expect(cols).toContain('expires_at');
    expect(cols).toContain('created_at');
  });

  it('token tem UNIQUE constraint', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000020');

    await pool.query(
      `INSERT INTO messaging_variable_tokens (token, field_name, worker_id)
       VALUES ('tk_unique_test_001', 'worker_phone', $1)`,
      [IDS.worker1]
    );

    await expect(
      pool.query(
        `INSERT INTO messaging_variable_tokens (token, field_name, worker_id)
         VALUES ('tk_unique_test_001', 'worker_name', $1)`,
        [IDS.worker1]
      )
    ).rejects.toThrow(/unique|duplicate/i);
  });

  it('CASCADE: deletar worker remove tokens', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000021');

    await pool.query(
      `INSERT INTO messaging_variable_tokens (token, field_name, worker_id)
       VALUES ('tk_cascade_test', 'worker_phone', $1)`,
      [IDS.worker1]
    );

    await pool.query(`DELETE FROM workers WHERE id = $1`, [IDS.worker1]);

    const result = await pool.query(
      `SELECT * FROM messaging_variable_tokens WHERE token = 'tk_cascade_test'`
    );
    expect(result.rows).toHaveLength(0);
  });

  it('expires_at default eh NOW() + 24 horas', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000022');

    await pool.query(
      `INSERT INTO messaging_variable_tokens (token, field_name, worker_id)
       VALUES ('tk_expiry_test', 'worker_name', $1)`,
      [IDS.worker1]
    );

    const result = await pool.query(
      `SELECT expires_at, created_at,
              EXTRACT(EPOCH FROM (expires_at - created_at))::int AS diff_seconds
       FROM messaging_variable_tokens WHERE token = 'tk_expiry_test'`
    );

    // 24 horas = 86400 segundos (com margem de 60s)
    const diff = result.rows[0].diff_seconds;
    expect(diff).toBeGreaterThan(86300);
    expect(diff).toBeLessThan(86500);
  });

  it('variavel PII usa token no JSONB, nao valor real', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000023');

    // Criar token
    await pool.query(
      `INSERT INTO messaging_variable_tokens (token, field_name, worker_id)
       VALUES ('tk_pii_test_phone', 'worker_phone', $1)`,
      [IDS.worker1]
    );

    // Gravar no outbox com token (não o telefone real)
    await pool.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables)
       VALUES ($1, 'test_pii_template', '{"phone_token": "tk_pii_test_phone"}')`,
      [IDS.worker1]
    );

    const result = await pool.query(
      `SELECT variables FROM messaging_outbox
       WHERE worker_id = $1 AND template_slug = 'test_pii_template'`,
      [IDS.worker1]
    );

    // O JSONB deve conter o token, não um número de telefone
    const vars = result.rows[0].variables;
    expect(vars.phone_token).toBe('tk_pii_test_phone');
    expect(vars.phone).toBeUndefined();

    // Cleanup
    await pool.query(`DELETE FROM messaging_outbox WHERE template_slug = 'test_pii_template'`).catch(() => {});
  });
});

// =================================================================
// D9 — Politica de retencao
// =================================================================

describe('D9 — retencao: indice + funcao de archiving', () => {
  afterEach(async () => {
    await pool.query(
      `DELETE FROM messaging_outbox WHERE template_slug LIKE 'retention_test%'`
    ).catch(() => {});
    await pool.query(
      `DELETE FROM whatsapp_bulk_dispatch_logs WHERE template_slug LIKE 'retention_test%'`
    ).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [
      [IDS.worker1, IDS.worker2],
    ]).catch(() => {});
  });

  it('indice idx_messaging_outbox_processed_at existe', async () => {
    const result = await pool.query(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'messaging_outbox'
         AND indexname = 'idx_messaging_outbox_processed_at'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('funcao archive_old_messages existe', async () => {
    const result = await pool.query(
      `SELECT routine_name FROM information_schema.routines
       WHERE routine_name = 'archive_old_messages'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('funcao cleanup_expired_tokens existe', async () => {
    const result = await pool.query(
      `SELECT routine_name FROM information_schema.routines
       WHERE routine_name = 'cleanup_expired_tokens'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('archiving remove registros expirados do outbox', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000030');

    // Inserir registro "antigo" (processado há 100 dias)
    await pool.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, processed_at)
       VALUES ($1, 'retention_test_old', '{}', 'sent', NOW() - INTERVAL '100 days')`,
      [IDS.worker1]
    );

    // Inserir registro "recente" (processado há 10 dias)
    await pool.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status, processed_at)
       VALUES ($1, 'retention_test_new', '{}', 'sent', NOW() - INTERVAL '10 days')`,
      [IDS.worker1]
    );

    // Executar archiving com 90 dias para outbox
    await pool.query(`SELECT * FROM archive_old_messages(90, 365)`);

    // Registro antigo deve ter sido removido
    const oldResult = await pool.query(
      `SELECT * FROM messaging_outbox WHERE template_slug = 'retention_test_old'`
    );
    expect(oldResult.rows).toHaveLength(0);

    // Registro recente deve permanecer
    const newResult = await pool.query(
      `SELECT * FROM messaging_outbox WHERE template_slug = 'retention_test_new'`
    );
    expect(newResult.rows).toHaveLength(1);
  });

  it('archiving preserva registros pending (nao processados)', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000031');

    // Inserir registro pending (sem processed_at)
    await pool.query(
      `INSERT INTO messaging_outbox (worker_id, template_slug, variables, status)
       VALUES ($1, 'retention_test_pending', '{}', 'pending')`,
      [IDS.worker1]
    );

    await pool.query(`SELECT * FROM archive_old_messages(90, 365)`);

    const result = await pool.query(
      `SELECT * FROM messaging_outbox WHERE template_slug = 'retention_test_pending'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('cleanup_expired_tokens remove tokens expirados', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000032');

    // Token expirado (created 2 days ago, expired 1 day ago)
    await pool.query(
      `INSERT INTO messaging_variable_tokens (token, field_name, worker_id, expires_at)
       VALUES ('tk_expired_cleanup', 'phone', $1, NOW() - INTERVAL '1 day')`,
      [IDS.worker1]
    );

    // Token válido
    await pool.query(
      `INSERT INTO messaging_variable_tokens (token, field_name, worker_id, expires_at)
       VALUES ('tk_valid_cleanup', 'phone', $1, NOW() + INTERVAL '1 day')`,
      [IDS.worker1]
    );

    await pool.query(`SELECT cleanup_expired_tokens()`);

    const expired = await pool.query(
      `SELECT * FROM messaging_variable_tokens WHERE token = 'tk_expired_cleanup'`
    );
    expect(expired.rows).toHaveLength(0);

    const valid = await pool.query(
      `SELECT * FROM messaging_variable_tokens WHERE token = 'tk_valid_cleanup'`
    );
    expect(valid.rows).toHaveLength(1);
  });
});

// =================================================================
// I3 — current_applicants removido, funcao computed
// =================================================================

describe('I3 — current_applicants removido, get_applicant_count()', () => {
  afterEach(async () => {
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1)`, [
      [IDS.job1, IDS.job2],
    ]).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [[IDS.job1, IDS.job2]]).catch(() => {});
    await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [
      [IDS.worker1, IDS.worker2, IDS.worker3],
    ]).catch(() => {});
  });

  it('job_postings NAO tem coluna current_applicants', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name = 'current_applicants'`
    );
    expect(result.rows).toHaveLength(0);
  });

  it('trigger job_applicants_counter NAO existe', async () => {
    const result = await pool.query(
      `SELECT tgname FROM pg_trigger
       WHERE tgname = 'job_applicants_counter'`
    );
    expect(result.rows).toHaveLength(0);
  });

  it('funcao get_applicant_count existe', async () => {
    const result = await pool.query(
      `SELECT routine_name FROM information_schema.routines
       WHERE routine_name = 'get_applicant_count'`
    );
    expect(result.rows).toHaveLength(1);
  });

  it('get_applicant_count retorna 0 para vaga sem candidatos', async () => {
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, country, status)
       VALUES ($1, 99701, 'Vaga sem candidatos', 'AR', 'SEARCHING')`,
      [IDS.job1]
    );

    const result = await pool.query(
      `SELECT get_applicant_count($1) AS cnt`,
      [IDS.job1]
    );
    expect(result.rows[0].cnt).toBe(0);
  });

  it('get_applicant_count retorna count real apos INSERT em worker_job_applications', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000040');
    await createTestWorker(pool, IDS.worker2, '+5491100000041');
    await createTestWorker(pool, IDS.worker3, '+5491100000042');

    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, country, status)
       VALUES ($1, 99702, 'Vaga com candidatos', 'AR', 'SEARCHING')`,
      [IDS.job1]
    );

    // Inserir 3 candidatos
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $3, 'INVITED'), ($2, $3, 'INVITED')`,
      [IDS.worker1, IDS.worker2, IDS.job1]
    );
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $2, 'INVITED')`,
      [IDS.worker3, IDS.job1]
    );

    const result = await pool.query(
      `SELECT get_applicant_count($1) AS cnt`,
      [IDS.job1]
    );
    expect(result.rows[0].cnt).toBe(3);
  });

  it('get_applicant_count atualiza apos DELETE de candidato', async () => {
    await createTestWorker(pool, IDS.worker1, '+5491100000043');
    await createTestWorker(pool, IDS.worker2, '+5491100000044');

    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, country, status)
       VALUES ($1, 99703, 'Vaga delete test', 'AR', 'SEARCHING')`,
      [IDS.job1]
    );

    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $3, 'INVITED'), ($2, $3, 'INVITED')`,
      [IDS.worker1, IDS.worker2, IDS.job1]
    );

    // Deletar um candidato
    await pool.query(
      `DELETE FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [IDS.worker1, IDS.job1]
    );

    const result = await pool.query(
      `SELECT get_applicant_count($1) AS cnt`,
      [IDS.job1]
    );
    expect(result.rows[0].cnt).toBe(1);
  });

  it('funcao eh usavel inline no SELECT com job_postings', async () => {
    await pool.query(
      `INSERT INTO job_postings (id, case_number, title, country, status)
       VALUES ($1, 99704, 'Vaga inline test', 'AR', 'SEARCHING')`,
      [IDS.job1]
    );

    const result = await pool.query(
      `SELECT jp.id, jp.title, get_applicant_count(jp.id) AS current_applicants
       FROM job_postings jp WHERE jp.id = $1`,
      [IDS.job1]
    );

    expect(result.rows[0].title).toBe('Vaga inline test');
    expect(result.rows[0].current_applicants).toBe(0);
  });
});

// =================================================================
// REGRESSION — Wave 7
// =================================================================

describe('Regression — Wave 7 schema integrity', () => {
  it('worker_service_areas tem coluna location geography (fonte canônica do worker)', async () => {
    // Histórico: worker_locations foi consolidado em worker_service_areas via
    // migration 158/159/160 (2026-05-06). worker_service_areas é a única fonte
    // de verdade; worker_locations vive como worker_locations_deprecated_20260506
    // até ser dropada em release futura.
    const result = await pool.query(
      `SELECT table_name FROM information_schema.columns
       WHERE column_name = 'location'
         AND udt_name = 'geography'
         AND table_name = 'worker_service_areas'`
    );
    const tables = result.rows.map((r: any) => r.table_name);
    expect(tables).toContain('worker_service_areas');
  });

  it('ambas tabelas de messaging tem ON DELETE SET NULL', async () => {
    const result = await pool.query(
      `SELECT conrelid::regclass::text AS table_name, confdeltype
       FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid IN ('messaging_outbox'::regclass, 'whatsapp_bulk_dispatch_logs'::regclass)
         AND conname LIKE '%worker_id%'`
    );
    for (const row of result.rows) {
      expect(row.confdeltype).toBe('n');
    }
  });

  it('DECISIONS.md documenta D1, D2, D8, D9, I3', async () => {
    const fs = await import('fs');
    const content = fs.readFileSync(
      require('path').resolve(__dirname, '../../DECISIONS.md'),
      'utf-8'
    );
    expect(content).toMatch(/D1.*geography/i);
    expect(content).toMatch(/D2.*messaging/i);
    expect(content).toMatch(/D8.*tokeniza/i);
    expect(content).toMatch(/D9.*reten/i);
    expect(content).toMatch(/I3.*current_applicants/i);
  });
});
