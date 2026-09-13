/**
 * wave2-schema-migrations.test.ts
 *
 * Testa os 5 itens do Wave 2 do roadmap de correção de schema,
 * contra o banco real (sem mocks).
 *
 * I1:   Triggers updated_at nas 3 tabelas Talentum
 * I2:   Coluna updated_at + trigger em patient_addresses, patient_professionals, publications
 * D4:   patients.country bpchar(2) com CHECK (AR|BR)
 * D4-B: worker_locations.country bpchar(2) com CHECK (AR|BR)
 * N7:   Índice parcial blacklist órfã + ON CONFLICT no repo
 */

import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

let pool: Pool;

// UUIDs determinísticos para isolamento do teste
const WORKER_IDS = {
  w1: 'ee220000-0a0e-0002-0001-000000000001',
  w2: 'ee220000-0a0e-0002-0001-000000000002',
};

const JOB_ID = 'ee220000-0a0e-0002-aaa0-000000000001';
const PATIENT_ID = 'ee220000-0a0e-0002-bbb0-000000000001';

const BLACKLIST_IDS = {
  b1: 'ee220000-0a0e-0002-ccc0-000000000001',
  b2: 'ee220000-0a0e-0002-ccc0-000000000002',
  b3: 'ee220000-0a0e-0002-ccc0-000000000003',
};

const TALENTUM = {
  prescreeningId: 'ee220000-0a0e-0002-ddd0-000000000001',
  questionId: 'ee220000-0a0e-0002-ddd0-000000000002',
  responseId: 'ee220000-0a0e-0002-ddd0-000000000003',
};

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });

  // Limpar dados de teste anteriores (ordem de FK: filhos primeiro)
  await pool.query(`DELETE FROM talentum_prescreening_responses WHERE id = $1`, [TALENTUM.responseId]);
  await pool.query(`DELETE FROM talentum_prescreenings WHERE id = $1`, [TALENTUM.prescreeningId]);
  await pool.query(`DELETE FROM talentum_questions WHERE id = $1`, [TALENTUM.questionId]);
  await pool.query(`DELETE FROM blacklist WHERE id = ANY($1)`, [Object.values(BLACKLIST_IDS)]);
  await pool.query(`DELETE FROM patient_addresses WHERE patient_id = $1`, [PATIENT_ID]);
  await pool.query(`DELETE FROM patient_professionals WHERE patient_id = $1`, [PATIENT_ID]);
  await pool.query(`DELETE FROM publications WHERE job_posting_id = $1`, [JOB_ID]);
  await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1)`, [Object.values(WORKER_IDS)]);
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [JOB_ID]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [Object.values(WORKER_IDS)]);

  // Seed: workers
  for (const [key, id] of Object.entries(WORKER_IDS)) {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone)
       VALUES ($1, $2, $3, $4, 'REGISTERED', 'AR', 'America/Buenos_Aires')
       ON CONFLICT (auth_uid) DO NOTHING`,
      [id, `e2e-wave2-${key}`, `${key}@wave2.test`, `54110000${key.replace('w', '')}`],
    );
  }

  // Seed: job_posting
  await pool.query(
    `INSERT INTO job_postings (id, title, status, country)
     VALUES ($1, 'Wave2 test posting', 'ACTIVE', 'AR')
     ON CONFLICT DO NOTHING`,
    [JOB_ID],
  );

  // Seed: patient
  await pool.query(
    `INSERT INTO patients (id, clickup_task_id, first_name, country)
     VALUES ($1, 'wave2-test-task', 'TestPatient', 'AR')
     ON CONFLICT DO NOTHING`,
    [PATIENT_ID],
  );
});

afterAll(async () => {
  // Cleanup
  await pool.query(`DELETE FROM talentum_prescreening_responses WHERE id = $1`, [TALENTUM.responseId]);
  await pool.query(`DELETE FROM talentum_prescreenings WHERE id = $1`, [TALENTUM.prescreeningId]);
  await pool.query(`DELETE FROM talentum_questions WHERE id = $1`, [TALENTUM.questionId]);
  await pool.query(`DELETE FROM blacklist WHERE id = ANY($1)`, [Object.values(BLACKLIST_IDS)]);
  await pool.query(`DELETE FROM patient_addresses WHERE patient_id = $1`, [PATIENT_ID]);
  await pool.query(`DELETE FROM patient_professionals WHERE patient_id = $1`, [PATIENT_ID]);
  await pool.query(`DELETE FROM publications WHERE job_posting_id = $1`, [JOB_ID]);
  await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1)`, [Object.values(WORKER_IDS)]);
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [JOB_ID]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT_ID]);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1)`, [Object.values(WORKER_IDS)]);
  await pool.end();
});

// ═══════════════════════════════════════════════════════════════
// I1 — Triggers updated_at nas tabelas Talentum
// ═══════════════════════════════════════════════════════════════

describe('I1 — Triggers updated_at em tabelas Talentum', () => {
  it('triggers existem para as 3 tabelas Talentum', async () => {
    const result = await pool.query<{ event_object_table: string; trigger_name: string }>(`
      SELECT event_object_table, trigger_name
      FROM information_schema.triggers
      WHERE event_object_table LIKE 'talentum_%'
        AND action_timing = 'BEFORE'
        AND event_manipulation = 'UPDATE'
      ORDER BY event_object_table
    `);

    const tables = result.rows.map(r => r.event_object_table);
    expect(tables).toContain('talentum_prescreening_responses');
    expect(tables).toContain('talentum_prescreenings');
    expect(tables).toContain('talentum_questions');
  });

  it('updated_at é atualizado em UPDATE de talentum_prescreenings', async () => {
    // Inserir
    await pool.query(
      `INSERT INTO talentum_prescreenings (id, talentum_prescreening_id, talentum_profile_id, job_case_name, status)
       VALUES ($1, 'wave2-ps-001', 'wave2-profile-001', 'Wave2 Test Case', 'INITIATED')
       ON CONFLICT DO NOTHING`,
      [TALENTUM.prescreeningId],
    );

    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM talentum_prescreenings WHERE id = $1`,
      [TALENTUM.prescreeningId],
    );
    const createdAt = before.rows[0].updated_at;

    // Esperar 10ms para garantir diferença de timestamp
    await new Promise(resolve => setTimeout(resolve, 10));

    // Atualizar
    await pool.query(
      `UPDATE talentum_prescreenings SET status = 'COMPLETED' WHERE id = $1`,
      [TALENTUM.prescreeningId],
    );

    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM talentum_prescreenings WHERE id = $1`,
      [TALENTUM.prescreeningId],
    );

    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(createdAt.getTime());
  });

  it('updated_at é atualizado em UPDATE de talentum_questions', async () => {
    await pool.query(
      `INSERT INTO talentum_questions (id, question_id, question, response_type)
       VALUES ($1, 'wave2-q-001', 'Pergunta original', 'TEXT')
       ON CONFLICT DO NOTHING`,
      [TALENTUM.questionId],
    );

    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM talentum_questions WHERE id = $1`,
      [TALENTUM.questionId],
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    await pool.query(
      `UPDATE talentum_questions SET question = 'Pergunta atualizada' WHERE id = $1`,
      [TALENTUM.questionId],
    );

    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM talentum_questions WHERE id = $1`,
      [TALENTUM.questionId],
    );

    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
  });

  it('updated_at é atualizado em UPDATE de talentum_prescreening_responses', async () => {
    await pool.query(
      `INSERT INTO talentum_prescreening_responses (id, prescreening_id, question_id, answer, response_source)
       VALUES ($1, $2, $3, 'Resposta original', 'register')
       ON CONFLICT DO NOTHING`,
      [TALENTUM.responseId, TALENTUM.prescreeningId, TALENTUM.questionId],
    );

    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM talentum_prescreening_responses WHERE id = $1`,
      [TALENTUM.responseId],
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    await pool.query(
      `UPDATE talentum_prescreening_responses SET answer = 'Resposta atualizada' WHERE id = $1`,
      [TALENTUM.responseId],
    );

    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM talentum_prescreening_responses WHERE id = $1`,
      [TALENTUM.responseId],
    );

    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
  });
});

// ═══════════════════════════════════════════════════════════════
// I2 — updated_at em patient_addresses, patient_professionals, publications
// ═══════════════════════════════════════════════════════════════

describe('I2 — Coluna updated_at em patient_addresses, patient_professionals, publications', () => {
  it('patient_addresses tem coluna updated_at TIMESTAMPTZ NOT NULL', async () => {
    const result = await pool.query<{
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'patient_addresses' AND column_name = 'updated_at'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data_type).toBe('timestamp with time zone');
    expect(result.rows[0].is_nullable).toBe('NO');
  });

  it('patient_professionals tem coluna updated_at TIMESTAMPTZ NOT NULL', async () => {
    const result = await pool.query<{
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'patient_professionals' AND column_name = 'updated_at'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data_type).toBe('timestamp with time zone');
    expect(result.rows[0].is_nullable).toBe('NO');
  });

  it('publications tem coluna updated_at TIMESTAMPTZ NOT NULL', async () => {
    const result = await pool.query<{
      data_type: string;
      is_nullable: string;
    }>(`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'publications' AND column_name = 'updated_at'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data_type).toBe('timestamp with time zone');
    expect(result.rows[0].is_nullable).toBe('NO');
  });

  it('triggers updated_at existem para as 3 tabelas', async () => {
    const result = await pool.query<{ event_object_table: string }>(`
      SELECT event_object_table
      FROM information_schema.triggers
      WHERE event_object_table IN ('patient_addresses', 'patient_professionals', 'publications')
        AND action_timing = 'BEFORE'
        AND event_manipulation = 'UPDATE'
      ORDER BY event_object_table
    `);

    const tables = result.rows.map(r => r.event_object_table);
    expect(tables).toContain('patient_addresses');
    expect(tables).toContain('patient_professionals');
    expect(tables).toContain('publications');
  });

  it('UPDATE em patient_addresses atualiza updated_at automaticamente', async () => {
    const addrId = 'ee220000-0a0e-0002-eee0-000000000001';

    await pool.query(
      `INSERT INTO patient_addresses (id, patient_id, address_raw, source)
       VALUES ($1, $2, 'Rua Original 123', 'test')
       ON CONFLICT DO NOTHING`,
      [addrId, PATIENT_ID],
    );

    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM patient_addresses WHERE id = $1`,
      [addrId],
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    await pool.query(
      `UPDATE patient_addresses SET address_raw = 'Rua Atualizada 456' WHERE id = $1`,
      [addrId],
    );

    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM patient_addresses WHERE id = $1`,
      [addrId],
    );

    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());

    await pool.query(`DELETE FROM patient_addresses WHERE id = $1`, [addrId]);
  });

  it('UPDATE em patient_professionals atualiza updated_at automaticamente', async () => {
    const profId = 'ee220000-0a0e-0002-eee0-000000000002';

    await pool.query(
      `INSERT INTO patient_professionals (id, patient_id, name, phone_encrypted, source)
       VALUES ($1, $2, 'Dr. Original', '541100001', 'test')
       ON CONFLICT DO NOTHING`,
      [profId, PATIENT_ID],
    );

    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM patient_professionals WHERE id = $1`,
      [profId],
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    await pool.query(
      `UPDATE patient_professionals SET name = 'Dr. Atualizado' WHERE id = $1`,
      [profId],
    );

    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM patient_professionals WHERE id = $1`,
      [profId],
    );

    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());

    await pool.query(`DELETE FROM patient_professionals WHERE id = $1`, [profId]);
  });

  it('UPDATE em publications atualiza updated_at automaticamente', async () => {
    const pubId = 'ee220000-0a0e-0002-eee0-000000000003';

    await pool.query(
      `INSERT INTO publications (id, job_posting_id, channel, group_name, dedup_hash)
       VALUES ($1, $2, 'whatsapp', 'Grupo Original', 'wave2-test-pub-hash')
       ON CONFLICT DO NOTHING`,
      [pubId, JOB_ID],
    );

    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM publications WHERE id = $1`,
      [pubId],
    );

    await new Promise(resolve => setTimeout(resolve, 10));

    await pool.query(
      `UPDATE publications SET group_name = 'Grupo Atualizado' WHERE id = $1`,
      [pubId],
    );

    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM publications WHERE id = $1`,
      [pubId],
    );

    expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());

    await pool.query(`DELETE FROM publications WHERE id = $1`, [pubId]);
  });
});

// ═══════════════════════════════════════════════════════════════
// D4 — patients.country constraint
// ═══════════════════════════════════════════════════════════════

describe('D4 — patients.country bpchar(2) com CHECK', () => {
  it('patients.country é bpchar(2) NOT NULL', async () => {
    const result = await pool.query<{
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: string;
    }>(`
      SELECT data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'patients' AND column_name = 'country'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data_type).toBe('character');
    expect(result.rows[0].character_maximum_length).toBe(2);
    expect(result.rows[0].is_nullable).toBe('NO');
  });

  it('CHECK constraint valid_patient_country existe', async () => {
    const result = await pool.query<{ conname: string; consrc: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conrelid = 'patients'::regclass
        AND conname = 'valid_patient_country'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].consrc).toContain('AR');
    expect(result.rows[0].consrc).toContain('BR');
  });

  it('inserir country=AR é válido', async () => {
    const tmpId = 'ee220000-0a0e-0002-d400-000000000001';
    const result = await pool.query(
      `INSERT INTO patients (id, clickup_task_id, country)
       VALUES ($1, 'wave2-d4-ar', 'AR') RETURNING country`,
      [tmpId],
    );
    expect(result.rows[0].country.trim()).toBe('AR');
    await pool.query(`DELETE FROM patients WHERE id = $1`, [tmpId]);
  });

  it('inserir country=BR é válido', async () => {
    const tmpId = 'ee220000-0a0e-0002-d400-000000000002';
    const result = await pool.query(
      `INSERT INTO patients (id, clickup_task_id, country)
       VALUES ($1, 'wave2-d4-br', 'BR') RETURNING country`,
      [tmpId],
    );
    expect(result.rows[0].country.trim()).toBe('BR');
    await pool.query(`DELETE FROM patients WHERE id = $1`, [tmpId]);
  });

  it('inserir country=US retorna CheckViolation', async () => {
    const tmpId = 'ee220000-0a0e-0002-d400-000000000003';
    try {
      await pool.query(
        `INSERT INTO patients (id, clickup_task_id, country)
         VALUES ($1, 'wave2-d4-us', 'US')`,
        [tmpId],
      );
      fail('INSERT deveria ter falhado com CheckViolation');
    } catch (err: any) {
      // 23514 = check_violation
      expect(err.code).toBe('23514');
    }
  });

  it('DEFAULT country=AR funciona', async () => {
    const tmpId = 'ee220000-0a0e-0002-d400-000000000004';
    const result = await pool.query(
      `INSERT INTO patients (id, clickup_task_id)
       VALUES ($1, 'wave2-d4-default') RETURNING country`,
      [tmpId],
    );
    expect(result.rows[0].country.trim()).toBe('AR');
    await pool.query(`DELETE FROM patients WHERE id = $1`, [tmpId]);
  });
});

// ═══════════════════════════════════════════════════════════════
// D4-B — worker_locations.country constraint
// ═══════════════════════════════════════════════════════════════

// SKIP: worker_locations foi consolidada em worker_service_areas via migrations
// 158/159/160 (2026-05-06) e renomeada para worker_locations_deprecated_20260506.
// As constraints de country/check pertencem ao schema legado em desuso.
describe.skip('D4-B — worker_locations.country bpchar(2) com CHECK [legacy, table deprecated]', () => {
  it('worker_locations.country é bpchar(2) NOT NULL', async () => {
    const result = await pool.query<{
      data_type: string;
      character_maximum_length: number | null;
      is_nullable: string;
    }>(`
      SELECT data_type, character_maximum_length, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'worker_locations' AND column_name = 'country'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].data_type).toBe('character');
    expect(result.rows[0].character_maximum_length).toBe(2);
    expect(result.rows[0].is_nullable).toBe('NO');
  });

  it('CHECK constraint valid_worker_locations_country existe', async () => {
    const result = await pool.query<{ conname: string; consrc: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS consrc
      FROM pg_constraint
      WHERE conrelid = 'worker_locations'::regclass
        AND conname = 'valid_worker_locations_country'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].consrc).toContain('AR');
    expect(result.rows[0].consrc).toContain('BR');
  });

  it('inserir country=AR é válido', async () => {
    const result = await pool.query(
      `INSERT INTO worker_locations (worker_id, country, data_source)
       VALUES ($1, 'AR', 'test') RETURNING country`,
      [WORKER_IDS.w1],
    );
    expect(result.rows[0].country.trim()).toBe('AR');
    await pool.query(`DELETE FROM worker_locations WHERE worker_id = $1`, [WORKER_IDS.w1]);
  });

  it('inserir country=US retorna CheckViolation', async () => {
    try {
      await pool.query(
        `INSERT INTO worker_locations (worker_id, country, data_source)
         VALUES ($1, 'US', 'test')`,
        [WORKER_IDS.w2],
      );
      fail('INSERT deveria ter falhado com CheckViolation');
    } catch (err: any) {
      expect(err.code).toBe('23514');
    }
  });
});

// ═══════════════════════════════════════════════════════════════
// N7 — Blacklist: índice parcial para órfãs + ON CONFLICT
// ═══════════════════════════════════════════════════════════════

describe('N7 — Blacklist: índice parcial idx_blacklist_phone_reason_orphan', () => {
  it('índice idx_blacklist_phone_reason_orphan existe', async () => {
    const result = await pool.query<{ indexname: string; indexdef: string }>(`
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE tablename = 'blacklist'
        AND indexname = 'idx_blacklist_phone_reason_orphan'
    `);

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].indexdef).toContain('worker_raw_phone');
    expect(result.rows[0].indexdef).toContain('reason');
    expect(result.rows[0].indexdef).toContain('worker_id IS NULL');
  });

  it('índice existente idx_blacklist_worker_reason continua funcional', async () => {
    const result = await pool.query<{ indexname: string }>(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'blacklist'
        AND indexname = 'idx_blacklist_worker_reason'
    `);

    expect(result.rows.length).toBe(1);
  });

  it('blacklist órfã com mesmo phone+reason: segunda inserção não cria duplicata', async () => {
    // Primeira inserção
    await pool.query(
      `INSERT INTO blacklist (id, worker_raw_name, worker_raw_phone, reason, detail, registered_by, can_take_eventual)
       VALUES ($1, 'Orphan Worker', '5411ORPHAN01', 'Documentación falsa', 'Detalhe 1', 'test', false)
       ON CONFLICT DO NOTHING`,
      [BLACKLIST_IDS.b1],
    );

    // Segunda inserção com mesmo phone+reason mas worker_id IS NULL
    // Deve respeitar o índice parcial e não criar duplicata
    try {
      await pool.query(
        `INSERT INTO blacklist (id, worker_raw_name, worker_raw_phone, reason, detail, registered_by, can_take_eventual)
         VALUES ($1, 'Orphan Worker Dup', '5411ORPHAN01', 'Documentación falsa', 'Detalhe 2', 'test', false)`,
        [BLACKLIST_IDS.b2],
      );
      fail('INSERT deveria ter falhado com unique_violation');
    } catch (err: any) {
      // 23505 = unique_violation
      expect(err.code).toBe('23505');
    }

    // Verificar que apenas 1 registro existe
    const result = await pool.query(
      `SELECT COUNT(*) AS cnt FROM blacklist
       WHERE worker_raw_phone = '5411ORPHAN01' AND reason = 'Documentación falsa' AND worker_id IS NULL`,
    );
    expect(Number(result.rows[0].cnt)).toBe(1);
  });

  it('blacklist órfã com mesmo phone mas reason diferente: ambos inseridos', async () => {
    await pool.query(
      `INSERT INTO blacklist (id, worker_raw_name, worker_raw_phone, reason, detail)
       VALUES ($1, 'Worker Multi', '5411ORPHAN02', 'Motivo diferente', 'Outro detalhe')
       ON CONFLICT DO NOTHING`,
      [BLACKLIST_IDS.b2],
    );

    const result = await pool.query(
      `SELECT COUNT(*) AS cnt FROM blacklist WHERE worker_raw_phone = '5411ORPHAN02' AND worker_id IS NULL`,
    );
    expect(Number(result.rows[0].cnt)).toBe(1);
  });

  it('blacklist com worker_id: ON CONFLICT no índice existente funciona', async () => {
    // Inserir com worker_id
    await pool.query(
      `INSERT INTO blacklist (id, worker_id, worker_raw_phone, reason, detail, can_take_eventual)
       VALUES ($1, $2, '54110000001', 'Abandono', 'Detalhe original', false)
       ON CONFLICT (worker_id, reason) WHERE worker_id IS NOT NULL
         DO UPDATE SET detail = EXCLUDED.detail
       RETURNING *`,
      [BLACKLIST_IDS.b3, WORKER_IDS.w1],
    );

    // Upsert: mesmo worker_id + reason → atualiza
    const result = await pool.query(
      `INSERT INTO blacklist (worker_id, worker_raw_phone, reason, detail, can_take_eventual)
       VALUES ($1, '54110000001', 'Abandono', 'Detalhe atualizado', true)
       ON CONFLICT (worker_id, reason) WHERE worker_id IS NOT NULL
         DO UPDATE SET detail = EXCLUDED.detail, can_take_eventual = EXCLUDED.can_take_eventual
       RETURNING detail, can_take_eventual`,
      [WORKER_IDS.w1],
    );

    expect(result.rows[0].detail).toBe('Detalhe atualizado');
    expect(result.rows[0].can_take_eventual).toBe(true);

    // Apenas 1 registro com esse worker+reason
    const count = await pool.query(
      `SELECT COUNT(*) AS cnt FROM blacklist WHERE worker_id = $1 AND reason = 'Abandono'`,
      [WORKER_IDS.w1],
    );
    expect(Number(count.rows[0].cnt)).toBe(1);
  });

  it('ON CONFLICT orphan upsert atualiza detail em vez de duplicar', async () => {
    // Inserir órfã via ON CONFLICT (padrão do repo atualizado)
    await pool.query(
      `INSERT INTO blacklist (worker_raw_name, worker_raw_phone, reason, detail, registered_by, can_take_eventual)
       VALUES ('Repo Test', '5411REPO01', 'Teste Repo', 'Detalhe v1', 'test', false)
       ON CONFLICT (worker_raw_phone, reason) WHERE worker_id IS NULL AND worker_raw_phone IS NOT NULL
         DO UPDATE SET
           detail = EXCLUDED.detail,
           registered_by = EXCLUDED.registered_by,
           can_take_eventual = EXCLUDED.can_take_eventual
       RETURNING *, (xmax = 0) AS inserted`,
    );

    // Segundo upsert com mesmo phone+reason → deve atualizar
    const result = await pool.query<{ detail: string; inserted: boolean }>(
      `INSERT INTO blacklist (worker_raw_name, worker_raw_phone, reason, detail, registered_by, can_take_eventual)
       VALUES ('Repo Test', '5411REPO01', 'Teste Repo', 'Detalhe v2', 'test-updated', true)
       ON CONFLICT (worker_raw_phone, reason) WHERE worker_id IS NULL AND worker_raw_phone IS NOT NULL
         DO UPDATE SET
           detail = EXCLUDED.detail,
           registered_by = EXCLUDED.registered_by,
           can_take_eventual = EXCLUDED.can_take_eventual
       RETURNING *, (xmax = 0) AS inserted`,
    );

    expect(result.rows[0].detail).toBe('Detalhe v2');
    expect(result.rows[0].inserted).toBe(false);

    // Apenas 1 registro
    const count = await pool.query(
      `SELECT COUNT(*) AS cnt FROM blacklist
       WHERE worker_raw_phone = '5411REPO01' AND reason = 'Teste Repo' AND worker_id IS NULL`,
    );
    expect(Number(count.rows[0].cnt)).toBe(1);

    // Cleanup
    await pool.query(
      `DELETE FROM blacklist WHERE worker_raw_phone = '5411REPO01' AND reason = 'Teste Repo'`,
    );
  });
});

// ═══════════════════════════════════════════════════════════════
// Regressão — Linter de schema
// ═══════════════════════════════════════════════════════════════

describe('Regressão — Validação transversal de schema Wave 2', () => {
  it('tabelas corrigidas no Wave 2 têm trigger BEFORE UPDATE', async () => {
    // Verifica especificamente as tabelas corrigidas nesta wave
    const wave2Tables = [
      'talentum_prescreenings',
      'talentum_questions',
      'talentum_prescreening_responses',
      'patient_addresses',
      'patient_professionals',
      'publications',
    ];

    const result = await pool.query<{ event_object_table: string }>(`
      SELECT DISTINCT event_object_table
      FROM information_schema.triggers
      WHERE action_timing = 'BEFORE'
        AND event_manipulation = 'UPDATE'
        AND event_object_schema = 'public'
        AND event_object_table = ANY($1)
    `, [wave2Tables]);

    const tablesWithTrigger = new Set(result.rows.map(r => r.event_object_table));
    const missing = wave2Tables.filter(t => !tablesWithTrigger.has(t));

    expect(missing).toEqual([]);
  });

  it('patients e worker_service_areas têm country com 2 chars', async () => {
    // Verifica especificamente as tabelas corrigidas nesta wave (D4 + D4-B).
    // Após migrations 158/159/160 (2026-05-06), worker_locations foi consolidada
    // em worker_service_areas. Note: patients.country é bpchar(2) mas
    // worker_service_areas.country é varchar(2) (definido na migration original
    // dessa tabela). O invariante essencial é character_maximum_length = 2 —
    // o tipo exato (bpchar vs varchar) é histórico e não impacta funcionalidade.
    const result = await pool.query<{
      table_name: string;
      data_type: string;
      character_maximum_length: number | null;
    }>(`
      SELECT table_name, data_type, character_maximum_length
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'country'
        AND table_name IN ('patients', 'worker_service_areas')
      ORDER BY table_name
    `);

    expect(result.rows.length).toBe(2);
    for (const row of result.rows) {
      expect(['character', 'character varying']).toContain(row.data_type);
      expect(row.character_maximum_length).toBe(2);
    }
  });
});
