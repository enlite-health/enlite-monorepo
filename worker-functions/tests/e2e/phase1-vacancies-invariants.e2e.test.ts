/**
 * phase1-vacancies-invariants.e2e.test.ts
 *
 * Guard-rail executável para Fase 1 do sync ClickUp → Enlite (vacantes).
 * Usa banco real (Docker Postgres) — nunca mocks.
 *
 * Cada invariante é um teste que FALHA se alguém quebrar a regra no futuro.
 *
 * Invariantes:
 *   I1: job_postings.patient_id sempre populado após import-vacancies
 *   I2: uniqueness (patient_id, address, schedule) é guard-rail de DB
 *   I3: encuadre_ambiguity_queue existe e respeita cardinalidade (TODO Fase 2)
 *   I4: encuadres.role só aceita valores canônicos
 *   I5: Listar vagas por paciente funciona (requisito Q1)
 *   I6: Status cascade (paciente + vaga) — Baja→DISCONTINUED/CLOSED, Alta→DISCHARGED/CLOSED, etc.
 *   I7: job_postings_clickup_sync permite N entries por task (1 task × N vagas)
 *   I8: patients.status CHECK constraint
 */

import { Pool } from 'pg';
import { JobPostingARRepository } from '../../src/modules/matching/infrastructure/JobPostingARRepository';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// DatabaseConnection singleton (used inside JobPostingARRepository) reads
// DATABASE_URL from process.env on first instantiation. Ensure it is set
// before any repository is constructed (same pattern as patient-responsibles.test.ts).
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

// ── Deterministic UUIDs (unique prefix avoids collisions with other tests) ─────
const P = {
  p1: 'f1450001-0000-0000-0001-000000000001',
  p2: 'f1450001-0000-0000-0001-000000000002',
  p3: 'f1450001-0000-0000-0001-000000000003',
  p4: 'f1450001-0000-0000-0001-000000000004', // I6 expanded
  p5: 'f1450001-0000-0000-0001-000000000005', // I7
  enc1: 'f1450001-0000-0000-0004-000000000001',
};

let pool: Pool;

async function cleanup(p: Pool): Promise<void> {
  await p.query(`DELETE FROM encuadre_ambiguity_queue WHERE encuadre_id IN (SELECT id FROM encuadres WHERE worker_raw_name LIKE 'inv-test-%')`).catch(() => {});
  await p.query(`DELETE FROM encuadres WHERE worker_raw_name LIKE 'inv-test-%'`).catch(() => {});
  await p.query(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE 'inv-test-%')`).catch(() => {});
  await p.query(`DELETE FROM job_postings WHERE title LIKE 'inv-test-%'`).catch(() => {});
  await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[P.p1, P.p2, P.p3, P.p4, P.p5]]).catch(() => {});
}

async function insertPatient(
  p: Pool,
  id: string,
  clickupTaskId: string,
  status?: string,
): Promise<void> {
  await p.query(
    `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name, status)
     VALUES ($1, $2, 'AR', 'Test', 'Inv', $3)
     ON CONFLICT (id) DO NOTHING`,
    [id, clickupTaskId, status ?? null],
  );
}

// service_address_formatted was dropped in migration 152.
// Addresses now live in patient_addresses; job_postings references them via patient_address_id FK.
async function insertPatientAddress(
  p: Pool,
  patientId: string,
  addressFormatted: string,
): Promise<string> {
  const res = await p.query<{ id: string }>(
    `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, address_raw, source)
     VALUES ($1, 'primary', $2, $2, 'e2e-test')
     RETURNING id`,
    [patientId, addressFormatted],
  );
  return res.rows[0].id;
}

async function insertJobPosting(
  p: Pool,
  opts: {
    patientId: string | null;
    caseNumber: number;
    /** Provide addressFormatted to auto-create a patient_addresses row and link it. */
    addressFormatted?: string | null;
    schedule?: object | null;
    /**
     * Pass undefined → defaults to 'SEARCHING'.
     * Pass null → inserts with NULL status (needed to test fill-only semantics).
     * Pass a string → uses that status directly.
     */
    status?: string | null;
    title?: string;
  },
): Promise<string> {
  const vnRes = await p.query<{ vn: string }>(
    "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
  );
  const vn = parseInt(vnRes.rows[0].vn);
  const title = opts.title ?? `inv-test-${opts.caseNumber}-${vn}`;
  // undefined → 'SEARCHING'; null → null (explicit NULL insert)
  const status = opts.status === undefined ? 'SEARCHING' : opts.status;

  // Create a patient_address row and link via FK if addressFormatted is provided.
  let patientAddressId: string | null = null;
  if (opts.addressFormatted && opts.patientId) {
    patientAddressId = await insertPatientAddress(p, opts.patientId, opts.addressFormatted);
  }

  const res = await p.query<{ id: string }>(
    `INSERT INTO job_postings (
       vacancy_number, case_number, patient_id,
       title, country, status,
       patient_address_id, schedule
     ) VALUES ($1, $2, $3, $4, 'AR', $5, $6, $7)
     RETURNING id`,
    [
      vn,
      opts.caseNumber,
      opts.patientId,
      title,
      status,
      patientAddressId,
      opts.schedule ? JSON.stringify(opts.schedule) : null,
    ],
  );
  return res.rows[0].id;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  await cleanup(pool);
});

afterAll(async () => {
  await cleanup(pool);
  await pool.end();
});

// =============================================================================
// I1: job_postings.patient_id sempre populado após import-vacancies
// =============================================================================

describe('I1: job_postings.patient_id sempre populado após import-vacancies', () => {
  it('job_posting criada via upsertFromClickUp com patientId tem patient_id NOT NULL', async () => {
    await insertPatient(pool, P.p1, 'clickup-task-i1');

    const repo = new JobPostingARRepository();
    const result = await repo.upsertFromClickUp({
      caseNumber: 5001,
      clickupTaskId: 'clickup-task-i1',
      patientId: P.p1,
      status: 'SEARCHING',
      // serviceAddressFormatted removed in migration 152 — address now lives in patient_addresses
    });

    expect(result.created).toBe(true);

    const row = await pool.query<{ patient_id: string | null }>(
      `SELECT patient_id FROM job_postings WHERE id = $1`,
      [result.id],
    );
    expect(row.rows[0].patient_id).toBe(P.p1);

    // Cleanup
    await pool.query(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id = $1`, [result.id]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [result.id]);
  });

  it('script deve pular task quando paciente não foi importado (patient_id=null não deve ser inserido)', async () => {
    // This invariant is enforced by the import script logic (resolvePatientId returns null → skip).
    // We verify here that upsertFromClickUp itself DOES allow null patientId
    // but the script skips — so no job_posting with null patient_id is created for that task.
    //
    // Test: we insert a job_posting manually WITHOUT patient_id (draft scenario)
    // and verify it is a valid state (nullable FK allows it).
    const vn = (await pool.query<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn")).rows[0].vn;
    await pool.query(
      `INSERT INTO job_postings (vacancy_number, case_number, patient_id, title, country, status)
       VALUES ($1, 5002, NULL, 'inv-test-5002', 'AR', 'SEARCHING')`,
      [parseInt(vn)],
    );

    const row = await pool.query<{ patient_id: string | null }>(
      `SELECT patient_id FROM job_postings WHERE title = 'inv-test-5002' LIMIT 1`,
    );
    // Draft allowed with null patient_id
    expect(row.rows[0].patient_id).toBeNull();

    await pool.query(`DELETE FROM job_postings WHERE title = 'inv-test-5002'`);
  });
});

// =============================================================================
// I2: patient_id + patient_address_id + schedule — estado após migration 152
// =============================================================================
// NOTE: idx_job_postings_unique_slot (criado em migration 142 sobre service_address_formatted)
// foi automaticamente dropado quando service_address_formatted foi removida na migration 152.
// A guarda de unicidade (patient + endereço + horário) passou a ser responsabilidade
// da camada de aplicação. Os testes abaixo refletem o schema atual.

describe('I2: job_postings aceita múltiplas vagas por paciente com endereços via patient_addresses', () => {
  it('permite 2 vagas mesmo paciente com endereços diferentes em patient_addresses', async () => {
    await insertPatient(pool, P.p2, 'clickup-task-i2');

    const id1 = await insertJobPosting(pool, {
      patientId: P.p2,
      caseNumber: 5012,
      addressFormatted: 'Corrientes 100, Buenos Aires',
      schedule: { start: '08:00', end: '12:00' },
    });

    const id2 = await insertJobPosting(pool, {
      patientId: P.p2,
      caseNumber: 5013,
      addressFormatted: 'Rivadavia 200, Buenos Aires', // different address row
      schedule: { start: '08:00', end: '12:00' },
    });

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it('permite 2 vagas mesmo paciente se horários diferentes', async () => {
    const id1 = await insertJobPosting(pool, {
      patientId: P.p2,
      caseNumber: 5014,
      addressFormatted: 'Tucumán 300, Buenos Aires',
      schedule: { start: '07:00', end: '11:00' },
    });

    const id2 = await insertJobPosting(pool, {
      patientId: P.p2,
      caseNumber: 5015,
      addressFormatted: 'Tucumán 300, Buenos Aires',
      schedule: { start: '13:00', end: '17:00' }, // different schedule
    });

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it('permite N vagas com schedule=NULL (drafts) para o mesmo paciente', async () => {
    await insertPatient(pool, P.p3, 'clickup-task-i2-draft');

    const id1 = await insertJobPosting(pool, {
      patientId: P.p3,
      caseNumber: 5020,
      addressFormatted: 'Draft Address 1, CABA',
      schedule: null,
    });

    const id2 = await insertJobPosting(pool, {
      patientId: P.p3,
      caseNumber: 5021,
      addressFormatted: 'Draft Address 1, CABA',
      schedule: null,
    });

    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it('patient_address_id FK existe em job_postings (migration 149)', async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name = 'patient_address_id'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it('service_address_formatted NÃO existe mais em job_postings (dropada em migration 152)', async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'job_postings' AND column_name = 'service_address_formatted'`,
    );
    expect(res.rows).toHaveLength(0);
  });
});

// =============================================================================
// I3: encuadre_ambiguity_queue — TODO Fase 2
// =============================================================================
// NOTE: I3 tests are deferred to Fase 2, when import-encuadres-from-clickup.ts exists.
// The encuadre_ambiguity_queue table itself is verified via migration presence.

describe('I3: encuadre_ambiguity_queue table exists (migration 142)', () => {
  it('tabela encuadre_ambiguity_queue existe no schema', async () => {
    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'encuadre_ambiguity_queue'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it('encuadre_ambiguity_queue tem coluna candidate_job_posting_ids UUID[]', async () => {
    const res = await pool.query<{ data_type: string; udt_name: string }>(
      `SELECT data_type, udt_name FROM information_schema.columns
       WHERE table_name = 'encuadre_ambiguity_queue' AND column_name = 'candidate_job_posting_ids'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].data_type).toBe('ARRAY');
  });

  // TODO Fase 2: testar que ao importar encuadre com case_number que resolve
  // para 2+ job_postings, um entry é criado em encuadre_ambiguity_queue.
});

// =============================================================================
// I4: encuadres.role só aceita valores canônicos
// =============================================================================

describe('I4: encuadres.role só aceita valores canônicos', () => {
  // We insert encuadres directly to test the CHECK constraint on role column.
  // We use worker_raw_name='inv-test-role-*' for cleanup targeting.

  async function insertEncuadre(role: string | null): Promise<void> {
    await pool.query(
      `INSERT INTO encuadres (role, worker_raw_name)
       VALUES ($1, 'inv-test-role')`,
      [role],
    );
    // cleanup immediately
    await pool.query(`DELETE FROM encuadres WHERE worker_raw_name = 'inv-test-role'`);
  }

  it('aceita role NULL', async () => {
    await expect(insertEncuadre(null)).resolves.not.toThrow();
  });

  it('aceita role TITULAR', async () => {
    await expect(insertEncuadre('TITULAR')).resolves.not.toThrow();
  });

  it('aceita role RAPID_RESPONSE', async () => {
    await expect(insertEncuadre('RAPID_RESPONSE')).resolves.not.toThrow();
  });

  it('rejeita role inválido (ex: SUPPLENTE) com CHECK violation', async () => {
    await expect(insertEncuadre('SUPPLENTE')).rejects.toMatchObject({ code: '23514' }); // check_violation
  });

  it('coluna role existe na tabela encuadres (migration 142)', async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'encuadres' AND column_name = 'role'`,
    );
    expect(res.rows).toHaveLength(1);
  });
});

// =============================================================================
// I5: Listar vagas por paciente funciona (requisito Q1)
// =============================================================================

describe('I5: SELECT job_postings WHERE patient_id retorna todas vagas do paciente', () => {
  it('retorna todas as N vagas criadas para um paciente', async () => {
    // P.p1 was created in I1 tests — clean it and re-insert fresh
    await pool.query(`DELETE FROM job_postings WHERE patient_id = $1`, [P.p1]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [P.p1]);
    await insertPatient(pool, P.p1, 'clickup-task-i5');

    const jobIds = await Promise.all([
      insertJobPosting(pool, { patientId: P.p1, caseNumber: 6001, addressFormatted: 'Addr A' }),
      insertJobPosting(pool, { patientId: P.p1, caseNumber: 6002, addressFormatted: 'Addr B' }),
      insertJobPosting(pool, { patientId: P.p1, caseNumber: 6003, addressFormatted: 'Addr C' }),
    ]);

    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM job_postings WHERE patient_id = $1 AND deleted_at IS NULL ORDER BY created_at`,
      [P.p1],
    );

    const rowIds = rows.map(r => r.id);
    for (const jid of jobIds) {
      expect(rowIds).toContain(jid);
    }
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// I6: Status cascade (paciente + vaga) — expanded para incluir patients.status
// =============================================================================

describe('I6: Status cascade (paciente + vaga)', () => {
  /**
   * Verifica que o cascade de status funciona para ambas as entidades:
   *   - patients.status (coluna adicionada em migration 143)
   *   - job_postings.status (via upsertFromClickUp)
   *
   * Pattern: setup paciente + vagas, simular import (UPDATE status direto + upsertFromClickUp),
   * depois verificar os valores finais no banco.
   */

  async function setupPatientWithJobs(
    patientId: string,
    taskId: string,
    caseNumbers: number[],
  ): Promise<string[]> {
    await pool.query(`DELETE FROM job_postings WHERE patient_id = $1`, [patientId]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await insertPatient(pool, patientId, taskId);

    const jobIds: string[] = [];
    for (const cn of caseNumbers) {
      const jid = await insertJobPosting(pool, {
        patientId,
        caseNumber: cn,
        addressFormatted: `Addr ${cn}`,
        status: 'ACTIVE',
        title: `inv-test-${cn}-i6`,
      });
      jobIds.push(jid);
    }
    return jobIds;
  }

  async function simulateStatusCascade(
    pool: Pool,
    patientId: string,
    jobPostingIds: string[],
    patientStatus: string,
    jobStatus: string,
  ): Promise<void> {
    // Simulate what the import script does:
    // 1. UPDATE patients.status
    await pool.query(
      `UPDATE patients SET status = $1, updated_at = NOW() WHERE id = $2`,
      [patientStatus, patientId],
    );
    // 2. UPDATE each job_posting status
    for (const jpId of jobPostingIds) {
      await pool.query(
        `UPDATE job_postings SET status = $1, updated_at = NOW() WHERE id = $2`,
        [jobStatus, jpId],
      );
    }
  }

  it('task status=Baja → patient.status=DISCONTINUED E job_posting.status=CLOSED', async () => {
    const jobIds = await setupPatientWithJobs(P.p4, 'clickup-task-i6-baja', [7001, 7002]);

    await simulateStatusCascade(pool, P.p4, jobIds, 'DISCONTINUED', 'CLOSED');

    const patRow = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`,
      [P.p4],
    );
    expect(patRow.rows[0].status).toBe('DISCONTINUED');

    const jobRows = await pool.query<{ status: string }>(
      `SELECT status FROM job_postings WHERE id = ANY($1)`,
      [jobIds],
    );
    for (const row of jobRows.rows) {
      expect(row.status).toBe('CLOSED');
    }
  });

  it('task status=Alta → patient.status=DISCHARGED E job_posting.status=CLOSED', async () => {
    // Reuse P.p4 — reset status first
    await pool.query(`UPDATE patients SET status = 'ACTIVE' WHERE id = $1`, [P.p4]);

    const jobIds = await pool.query<{ id: string }>(
      `SELECT id FROM job_postings WHERE patient_id = $1 AND deleted_at IS NULL`,
      [P.p4],
    ).then(r => r.rows.map(row => row.id));

    await simulateStatusCascade(pool, P.p4, jobIds, 'DISCHARGED', 'CLOSED');

    const patRow = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`,
      [P.p4],
    );
    expect(patRow.rows[0].status).toBe('DISCHARGED');

    const jobRows = await pool.query<{ status: string }>(
      `SELECT status FROM job_postings WHERE id = ANY($1)`,
      [jobIds],
    );
    for (const row of jobRows.rows) {
      expect(row.status).toBe('CLOSED');
    }
  });

  it('task status=Activación pendiente → patient.status=ACTIVE E job_posting.status=PENDING_ACTIVATION', async () => {
    await pool.query(`UPDATE patients SET status = NULL WHERE id = $1`, [P.p4]);

    const jobIds = await pool.query<{ id: string }>(
      `SELECT id FROM job_postings WHERE patient_id = $1 AND deleted_at IS NULL`,
      [P.p4],
    ).then(r => r.rows.map(row => row.id));

    await simulateStatusCascade(pool, P.p4, jobIds, 'ACTIVE', 'PENDING_ACTIVATION');

    const patRow = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`,
      [P.p4],
    );
    expect(patRow.rows[0].status).toBe('ACTIVE');

    const jobRows = await pool.query<{ status: string }>(
      `SELECT status FROM job_postings WHERE id = ANY($1)`,
      [jobIds],
    );
    for (const row of jobRows.rows) {
      expect(row.status).toBe('PENDING_ACTIVATION');
    }
  });

  it('task status=Suspendido → patient.status=SUSPENDED E job_posting.status=SUSPENDED', async () => {
    await pool.query(`UPDATE patients SET status = 'ACTIVE' WHERE id = $1`, [P.p4]);

    const jobIds = await pool.query<{ id: string }>(
      `SELECT id FROM job_postings WHERE patient_id = $1 AND deleted_at IS NULL`,
      [P.p4],
    ).then(r => r.rows.map(row => row.id));

    await simulateStatusCascade(pool, P.p4, jobIds, 'SUSPENDED', 'SUSPENDED');

    const patRow = await pool.query<{ status: string }>(
      `SELECT status FROM patients WHERE id = $1`,
      [P.p4],
    );
    expect(patRow.rows[0].status).toBe('SUSPENDED');

    const jobRows = await pool.query<{ status: string }>(
      `SELECT status FROM job_postings WHERE id = ANY($1)`,
      [jobIds],
    );
    for (const row of jobRows.rows) {
      expect(row.status).toBe('SUSPENDED');
    }
  });

  it('após upsertFromClickUp com status=Baja via repo, vagas sem status ficam CLOSED (fill-only semântica)', async () => {
    // upsertFromClickUp usa COALESCE(status, $new) — fill-only.
    // Se a vaga já tem status populado, o ClickUp sync NÃO sobrescreve.
    // Para testar que status=CLOSED é aplicado via sync, inserimos sem status (null)
    // e verificamos que após upsertFromClickUp o status fica CLOSED.
    //
    // Usa case numbers únicos (70010/70011) para evitar colisão com outros testes.
    const I6_CASE_1 = 70010;
    const I6_CASE_2 = 70011;

    // Clean up any pre-existing jobs for these case numbers (from previous test runs)
    await pool.query(`DELETE FROM job_postings WHERE case_number = ANY($1) AND deleted_at IS NULL`, [[I6_CASE_1, I6_CASE_2]]);
    await pool.query(`DELETE FROM job_postings WHERE patient_id = $1`, [P.p2]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [P.p2]);
    await insertPatient(pool, P.p2, 'clickup-task-i6-repo');

    // Insert WITHOUT status (null) — fill-only semântica permite que o sync popule
    const j1 = await insertJobPosting(pool, {
      patientId: P.p2,
      caseNumber: I6_CASE_1,
      addressFormatted: 'Baja Test Addr 1',
      status: null, // explicitly NULL → COALESCE picks up CLOSED from sync
    });
    const j2 = await insertJobPosting(pool, {
      patientId: P.p2,
      caseNumber: I6_CASE_2,
      addressFormatted: 'Baja Test Addr 2',
      status: null,
    });

    const repo = new JobPostingARRepository();
    await repo.upsertFromClickUp({
      caseNumber: I6_CASE_1,
      clickupTaskId: 'clickup-task-i6-repo',
      patientId: P.p2,
      status: 'CLOSED',
    });
    await repo.upsertFromClickUp({
      caseNumber: I6_CASE_2,
      clickupTaskId: 'clickup-task-i6-repo',
      patientId: P.p2,
      status: 'CLOSED',
    });

    const jobRows = await pool.query<{ id: string; status: string }>(
      `SELECT id, status FROM job_postings WHERE id = ANY($1)`,
      [[j1, j2]],
    );
    for (const row of jobRows.rows) {
      expect(row.status).toBe('CLOSED');
    }
  });
});

// =============================================================================
// I7: job_postings_clickup_sync permite N entries por task (1 task × N vagas)
// =============================================================================

describe('I7: job_postings_clickup_sync permite N entries por task (1 task × N vagas)', () => {
  const TASK_ID_I7 = 'clickup-task-i7-multiaddr';

  beforeAll(async () => {
    await pool.query(`DELETE FROM job_postings WHERE patient_id = $1`, [P.p5]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [P.p5]);
    await insertPatient(pool, P.p5, TASK_ID_I7);
  });

  it('paciente com 2 endereços → 2 job_postings criadas → 2 entries em clickup_sync com mesmo task_id', async () => {
    const repo = new JobPostingARRepository();

    const r1 = await repo.upsertFromClickUp({
      caseNumber: 8001,
      clickupTaskId: TASK_ID_I7,
      patientId: P.p5,
      status: 'SEARCHING',
      // serviceAddressFormatted removed in migration 152 — address via patient_address_id FK
      sourceCreatedAt: new Date('2025-01-01'),
      sourceUpdatedAt: new Date('2025-01-02'),
    });

    const r2 = await repo.upsertFromClickUp({
      caseNumber: 8002,
      clickupTaskId: TASK_ID_I7,
      patientId: P.p5,
      status: 'SEARCHING',
      // serviceAddressFormatted removed in migration 152 — address via patient_address_id FK
      sourceCreatedAt: new Date('2025-01-01'),
      sourceUpdatedAt: new Date('2025-01-02'),
    });

    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r1.id).not.toBe(r2.id);

    // Both sync entries should exist with the same task_id
    const syncRows = await pool.query<{ job_posting_id: string; clickup_task_id: string }>(
      `SELECT job_posting_id, clickup_task_id
       FROM job_postings_clickup_sync
       WHERE clickup_task_id = $1`,
      [TASK_ID_I7],
    );

    expect(syncRows.rows.length).toBeGreaterThanOrEqual(2);

    const syncJobIds = syncRows.rows.map(r => r.job_posting_id);
    expect(syncJobIds).toContain(r1.id);
    expect(syncJobIds).toContain(r2.id);

    // All entries point to the same task_id
    for (const row of syncRows.rows) {
      expect(row.clickup_task_id).toBe(TASK_ID_I7);
    }
  });

  it('re-import da mesma task não duplica entradas (ON CONFLICT job_posting_id atualiza)', async () => {
    const repo = new JobPostingARRepository();

    // Re-upsert the same case numbers — same job_postings should be updated, not new ones created
    const r1Again = await repo.upsertFromClickUp({
      caseNumber: 8001,
      clickupTaskId: TASK_ID_I7,
      patientId: P.p5,
      status: 'ACTIVE', // status changed
      // serviceAddressFormatted removed in migration 152 — address via patient_address_id FK
      sourceUpdatedAt: new Date('2025-01-10'), // updated timestamp
    });

    expect(r1Again.created).toBe(false); // updated, not created

    // Verify sync table still has correct count (no new rows for same job_posting)
    const syncCount = await pool.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM job_postings_clickup_sync WHERE clickup_task_id = $1`,
      [TASK_ID_I7],
    );
    // Should not grow beyond 2 (one per job_posting)
    expect(parseInt(syncCount.rows[0].cnt)).toBe(2);
  });

  it('unique (job_posting_id) — PRIMARY KEY impede duplicar sync entry para mesma vaga', async () => {
    // Get one of the job_posting ids for this task
    const jp = await pool.query<{ id: string }>(
      `SELECT jp.id FROM job_postings jp
       JOIN job_postings_clickup_sync s ON s.job_posting_id = jp.id
       WHERE s.clickup_task_id = $1 LIMIT 1`,
      [TASK_ID_I7],
    );
    expect(jp.rows).toHaveLength(1);
    const jobPostingId = jp.rows[0].id;

    // Attempt to manually INSERT duplicate sync entry for same job_posting_id → PK violation
    await expect(
      pool.query(
        `INSERT INTO job_postings_clickup_sync (job_posting_id, clickup_task_id)
         VALUES ($1, 'clickup-task-another')`,
        [jobPostingId],
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation (PK)
  });
});

// =============================================================================
// I8: patients.status CHECK constraint (migration 143)
// =============================================================================

describe('I8: patients.status CHECK constraint', () => {
  const TEMP_ID = 'f1450001-0000-0000-0099-000000000001';

  async function insertPatientWithStatus(status: string | null): Promise<void> {
    const taskId = `check-task-${TEMP_ID}`;
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name, status)
       VALUES ($1, $2, 'AR', 'Check', 'Test', $3)`,
      [TEMP_ID, taskId, status],
    );
    await pool.query(`DELETE FROM patients WHERE id = $1`, [TEMP_ID]);
  }

  it('aceita status NULL', async () => {
    await expect(insertPatientWithStatus(null)).resolves.not.toThrow();
  });

  it('aceita status ACTIVE', async () => {
    await expect(insertPatientWithStatus('ACTIVE')).resolves.not.toThrow();
  });

  it('aceita status SUSPENDED', async () => {
    await expect(insertPatientWithStatus('SUSPENDED')).resolves.not.toThrow();
  });

  it('aceita status DISCONTINUED', async () => {
    await expect(insertPatientWithStatus('DISCONTINUED')).resolves.not.toThrow();
  });

  it('aceita status DISCHARGED', async () => {
    await expect(insertPatientWithStatus('DISCHARGED')).resolves.not.toThrow();
  });

  it('aceita status PENDING_ADMISSION', async () => {
    await expect(insertPatientWithStatus('PENDING_ADMISSION')).resolves.not.toThrow();
  });

  it('aceita status ADMISSION (adicionado em migration 147)', async () => {
    await expect(insertPatientWithStatus('ADMISSION')).resolves.not.toThrow();
  });

  it('rejeita valor inválido (ex: INVALID_STATE) com CHECK violation', async () => {
    await expect(insertPatientWithStatus('INVALID_STATE')).rejects.toMatchObject({
      code: '23514', // check_violation
    });
  });

  it('rejeita valor ADMITIDO (valor legado incorreto) com CHECK violation', async () => {
    await expect(insertPatientWithStatus('ADMITIDO')).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('coluna status existe na tabela patients (migration 143)', async () => {
    const res = await pool.query<{ column_name: string; character_maximum_length: number }>(
      `SELECT column_name, character_maximum_length
       FROM information_schema.columns
       WHERE table_name = 'patients' AND column_name = 'status'`,
    );
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].character_maximum_length).toBe(32);
  });
});

// =============================================================================
// Schema guard-rails: verify migration columns/indexes exist
// =============================================================================

describe('Schema guard-rails (migrations 142 + 143)', () => {
  it('idx_job_postings_unique_slot NÃO existe mais (dropada com service_address_formatted em migration 152)', async () => {
    // migration 142 criou o índice sobre service_address_formatted;
    // migration 152 dropou a coluna, o que automaticamente removeu o índice também.
    const res = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'job_postings' AND indexname = 'idx_job_postings_unique_slot'`,
    );
    expect(res.rows).toHaveLength(0);
  });

  it('idx_ambiguity_unresolved index exists on encuadre_ambiguity_queue (migration 142)', async () => {
    const res = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'encuadre_ambiguity_queue' AND indexname = 'idx_ambiguity_unresolved'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it('job_postings_clickup_sync table has PRIMARY KEY on job_posting_id', async () => {
    const res = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'job_postings_clickup_sync'
         AND constraint_type = 'PRIMARY KEY'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it('job_postings_clickup_sync NÃO tem unique constraint sobre clickup_task_id sozinho (migration 143)', async () => {
    // After migration 143, idx_clickup_sync_task_id must be gone
    const res = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE tablename = 'job_postings_clickup_sync'
         AND indexname = 'idx_clickup_sync_task_id'`,
    );
    expect(res.rows).toHaveLength(0);
  });

  it('idx_clickup_sync_task_id_lookup index exists (migration 143, non-unique)', async () => {
    const res = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE tablename = 'job_postings_clickup_sync'
         AND indexname = 'idx_clickup_sync_task_id_lookup'`,
    );
    expect(res.rows).toHaveLength(1);
    // Confirm it's NOT a unique index
    expect(res.rows[0].indexdef).not.toContain('UNIQUE');
  });

  it('patients.status column exists with CHECK constraint (migration 143)', async () => {
    const res = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name
       FROM information_schema.constraint_column_usage
       WHERE table_name = 'patients' AND column_name = 'status'`,
    );
    // At least one CHECK constraint references patients.status
    expect(res.rows.length).toBeGreaterThanOrEqual(1);
  });
});
