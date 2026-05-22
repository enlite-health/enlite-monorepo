/**
 * phase1-patient-extensions.e2e.test.ts
 *
 * Integration tests for Phase 1 of the vacancies refactor sprint:
 *   - Migration 147: patient_addresses.state/city/neighborhood columns
 *   - Migration 184: patient_health_insurance table (replaces columns in patients)
 *   - Migration 147: patients.status ADMISSION value
 *   - Fill-only semantics: PatientHealthInsuranceRepository COALESCE on provider_name/member_id
 *   - PatientService.replaceAddresses writes state/city/neighborhood
 *
 * Uses real Postgres (Docker E2E stack). No mocks.
 *
 * Invariants:
 *   I1: patient_addresses has state, city, neighborhood columns (migration 147)
 *   I2: patient_health_insurance table exists with expected columns (migration 184)
 *   I3: patients.status CHECK accepts ADMISSION (migration 147)
 *   I4: PatientService writes health insurance to patient_health_insurance on INSERT
 *   I5: PatientService fill-only: does NOT overwrite existing provider_name on UPDATE
 *   I6: PatientService fill-only: does NOT overwrite existing member_id on UPDATE
 *   I7: PatientService.replaceAddresses writes state/city/neighborhood
 *   I8: PatientService.replaceAddresses does NOT write state/city/neighborhood when absent
 */

import { Pool } from 'pg';
import { PatientService } from '../../src/modules/case';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

let pool: Pool;

// Deterministic task IDs to avoid cross-test pollution
const TASK = {
  i4: 'phase1-ext-task-i4-ins',
  i5: 'phase1-ext-task-i5-fill',
  i6: 'phase1-ext-task-i6-fill',
  i7: 'phase1-ext-task-i7-addr',
  i8: 'phase1-ext-task-i8-addr-no-loc',
};

async function cleanPatient(taskId: string): Promise<void> {
  // FKs cascade to patient_addresses, patient_responsibles, etc.
  await pool.query(`DELETE FROM patients WHERE clickup_task_id = $1`, [taskId]);
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  for (const taskId of Object.values(TASK)) {
    await cleanPatient(taskId);
  }
});

afterAll(async () => {
  for (const taskId of Object.values(TASK)) {
    await cleanPatient(taskId);
  }
  await pool.end();
});

// =============================================================================
// I1: patient_addresses has state, city, neighborhood columns
// =============================================================================

describe('I1: patient_addresses has state/city/neighborhood columns (migration 147)', () => {
  it('state column exists in patient_addresses', async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'patient_addresses' AND column_name = 'state'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it('city column exists in patient_addresses', async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'patient_addresses' AND column_name = 'city'`,
    );
    expect(res.rows).toHaveLength(1);
  });

  it('neighborhood column exists in patient_addresses', async () => {
    const res = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'patient_addresses' AND column_name = 'neighborhood'`,
    );
    expect(res.rows).toHaveLength(1);
  });
});

// =============================================================================
// I2: patient_health_insurance table exists (migration 184)
// =============================================================================

describe('I2: patient_health_insurance table exists with expected columns (migration 184)', () => {
  const EXPECTED_COLUMNS = ['id', 'patient_id', 'provider_name', 'plan', 'member_id', 'emergency_numbers', 'source', 'created_at', 'updated_at'];

  for (const col of EXPECTED_COLUMNS) {
    it(`column ${col} exists in patient_health_insurance`, async () => {
      const res = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'patient_health_insurance' AND column_name = $1`,
        [col],
      );
      expect(res.rows).toHaveLength(1);
    });
  }
});

// =============================================================================
// I3: patients.status CHECK accepts ADMISSION
// =============================================================================

describe('I3: patients.status CHECK constraint accepts ADMISSION (migration 147)', () => {
  // Use valid UUIDs (UUID v4 format required by patients.id column)
  const TEMP_IDS = {
    admission:         'f1450003-0001-4000-a000-000000000001',
    pendingAdmission:  'f1450003-0001-4000-a000-000000000002',
    invalid:           'f1450003-0001-4000-a000-000000000003',
  };

  async function insertPatientWithStatus(id: string, taskId: string, status: string | null): Promise<void> {
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name, status)
       VALUES ($1, $2, 'AR', 'Check', 'Test', $3)`,
      [id, taskId, status],
    );
    await pool.query(`DELETE FROM patients WHERE id = $1`, [id]);
  }

  afterAll(async () => {
    for (const id of Object.values(TEMP_IDS)) {
      await pool.query(`DELETE FROM patients WHERE id = $1`, [id]).catch(() => {});
    }
  });

  it('aceita status ADMISSION', async () => {
    await expect(
      insertPatientWithStatus(TEMP_IDS.admission, 'check-i3-admission', 'ADMISSION'),
    ).resolves.not.toThrow();
  });

  it('ainda aceita PENDING_ADMISSION (valor pré-existente)', async () => {
    await expect(
      insertPatientWithStatus(TEMP_IDS.pendingAdmission, 'check-i3-pending-admission', 'PENDING_ADMISSION'),
    ).resolves.not.toThrow();
  });

  it('rejeita valor fora do conjunto canônico com CHECK violation', async () => {
    await expect(
      insertPatientWithStatus(TEMP_IDS.invalid, 'check-i3-invalid', 'ONBOARDING'),
    ).rejects.toMatchObject({
      code: '23514', // check_violation
    });
  });
});

// =============================================================================
// I4: PatientService writes health insurance on INSERT
// =============================================================================

describe('I4: PatientService writes health insurance to patient_health_insurance on INSERT', () => {
  it('creates patient_health_insurance row with providerName + memberId', async () => {
    const service = new PatientService();

    await service.upsertFromClickUp({
      clickupTaskId: TASK.i4,
      firstName:     'Test',
      lastName:      'Patient',
      country:       'AR',
      healthInsurance: {
        providerName: 'OSDE 210',
        memberId:     '9876543210',
      },
      responsibles: [{
        firstName: 'Resp',
        lastName:  'Test',
        phone:     '+54 9 11 9999-9999',
        isPrimary: true,
        displayOrder: 1,
        source: 'clickup',
      }],
    }, { onMissingContact: 'flag' });

    const row = await pool.query<{
      provider_name: string | null;
      member_id: string | null;
    }>(
      `SELECT phi.provider_name, phi.member_id
       FROM patient_health_insurance phi
       JOIN patients p ON p.id = phi.patient_id
       WHERE p.clickup_task_id = $1`,
      [TASK.i4],
    );

    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].provider_name).toBe('OSDE 210');
    expect(row.rows[0].member_id).toBe('9876543210');
  });
});

// =============================================================================
// I5: Fill-only: does NOT overwrite existing health_insurance_name on UPDATE
// =============================================================================

describe('I5: fill-only — existing provider_name NOT overwritten on update', () => {
  it('updates patient but keeps original provider_name when new value differs', async () => {
    const service = new PatientService();

    // First upsert: establish original value
    await service.upsertFromClickUp({
      clickupTaskId: TASK.i5,
      firstName:     'Fill',
      lastName:      'Only',
      country:       'AR',
      healthInsurance: {
        providerName: 'Swiss Medical',
        memberId:     '111000',
      },
      responsibles: [{
        firstName: 'Resp',
        lastName:  'Fill',
        phone:     '+54 9 11 8888-8888',
        isPrimary: true,
        displayOrder: 1,
        source: 'clickup',
      }],
    }, { onMissingContact: 'flag' });

    // Second upsert: simulate ClickUp sync with a DIFFERENT value (should NOT overwrite)
    await service.upsertFromClickUp({
      clickupTaskId: TASK.i5,
      firstName:     'Fill',
      lastName:      'Only',
      country:       'AR',
      healthInsurance: {
        providerName: 'IOMA', // different — should NOT replace existing 'Swiss Medical'
      },
      responsibles: [{
        firstName: 'Resp',
        lastName:  'Fill',
        phone:     '+54 9 11 8888-8888',
        isPrimary: true,
        displayOrder: 1,
        source: 'clickup',
      }],
    }, { onMissingContact: 'flag' });

    const row = await pool.query<{ provider_name: string | null }>(
      `SELECT phi.provider_name
       FROM patient_health_insurance phi
       JOIN patients p ON p.id = phi.patient_id
       WHERE p.clickup_task_id = $1`,
      [TASK.i5],
    );

    // Fill-only: original value preserved
    expect(row.rows[0].provider_name).toBe('Swiss Medical');
  });
});

// =============================================================================
// I6: Fill-only: does NOT overwrite existing health_insurance_member_id on UPDATE
// =============================================================================

describe('I6: fill-only — existing member_id NOT overwritten on update', () => {
  it('updates patient but keeps original member_id when new value differs', async () => {
    const service = new PatientService();

    // First upsert: establish original value
    await service.upsertFromClickUp({
      clickupTaskId: TASK.i6,
      firstName:     'Afl',
      lastName:      'Id',
      country:       'AR',
      healthInsurance: {
        providerName: 'Galeno',
        memberId:     '777888999',
      },
      responsibles: [{
        firstName: 'Resp',
        lastName:  'Afl',
        phone:     '+54 9 11 7777-7777',
        isPrimary: true,
        displayOrder: 1,
        source: 'clickup',
      }],
    }, { onMissingContact: 'flag' });

    // Second upsert: simulate with DIFFERENT member ID (should NOT overwrite)
    await service.upsertFromClickUp({
      clickupTaskId: TASK.i6,
      firstName:     'Afl',
      lastName:      'Id',
      country:       'AR',
      healthInsurance: {
        memberId: '000000001', // different — should NOT replace existing
      },
      responsibles: [{
        firstName: 'Resp',
        lastName:  'Afl',
        phone:     '+54 9 11 7777-7777',
        isPrimary: true,
        displayOrder: 1,
        source: 'clickup',
      }],
    }, { onMissingContact: 'flag' });

    const row = await pool.query<{ member_id: string | null }>(
      `SELECT phi.member_id
       FROM patient_health_insurance phi
       JOIN patients p ON p.id = phi.patient_id
       WHERE p.clickup_task_id = $1`,
      [TASK.i6],
    );

    // Fill-only: original value preserved
    expect(row.rows[0].member_id).toBe('777888999');
  });
});

// =============================================================================
// I7: PatientService.replaceAddresses writes state/city/neighborhood
// =============================================================================

describe('I7: PatientService writes state/city/neighborhood in patient_addresses', () => {
  it('INSERT via upsertFromClickUp persists state/city/neighborhood in primary address', async () => {
    const service = new PatientService();

    await service.upsertFromClickUp({
      clickupTaskId: TASK.i7,
      firstName:     'Addr',
      lastName:      'Test',
      country:       'AR',
      addresses: [{
        addressType:      'primary',
        addressFormatted: 'Av. Corrientes 1234, CABA',
        addressRaw:       'Corrientes 1234',
        displayOrder:     1,
        state:            'Buenos Aires',
        city:             'Ciudad Autónoma de Buenos Aires',
        neighborhood:     'San Nicolás',
      }],
      responsibles: [{
        firstName: 'Resp',
        lastName:  'Addr',
        phone:     '+54 9 11 6666-6666',
        isPrimary: true,
        displayOrder: 1,
        source: 'clickup',
      }],
    }, { onMissingContact: 'flag' });

    const rows = await pool.query<{
      state: string | null;
      city: string | null;
      neighborhood: string | null;
    }>(
      `SELECT pa.state, pa.city, pa.neighborhood
       FROM patient_addresses pa
       JOIN patients p ON p.id = pa.patient_id
       WHERE p.clickup_task_id = $1 AND pa.address_type = 'primary'`,
      [TASK.i7],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].state).toBe('Buenos Aires');
    expect(rows.rows[0].city).toBe('Ciudad Autónoma de Buenos Aires');
    expect(rows.rows[0].neighborhood).toBe('San Nicolás');
  });
});

// =============================================================================
// I8: PatientService.replaceAddresses leaves state/city/neighborhood NULL when absent
// =============================================================================

describe('I8: PatientService leaves state/city/neighborhood NULL when not provided', () => {
  it('INSERT without location metadata → state/city/neighborhood are NULL', async () => {
    const service = new PatientService();

    await service.upsertFromClickUp({
      clickupTaskId: TASK.i8,
      firstName:     'NoLoc',
      lastName:      'Test',
      country:       'AR',
      addresses: [{
        addressType:      'primary',
        addressFormatted: 'Rivadavia 500, CABA',
        displayOrder:     1,
        // No state, city, neighborhood
      }],
      responsibles: [{
        firstName: 'Resp',
        lastName:  'NoLoc',
        phone:     '+54 9 11 5555-5555',
        isPrimary: true,
        displayOrder: 1,
        source: 'clickup',
      }],
    }, { onMissingContact: 'flag' });

    const rows = await pool.query<{
      state: string | null;
      city: string | null;
      neighborhood: string | null;
    }>(
      `SELECT pa.state, pa.city, pa.neighborhood
       FROM patient_addresses pa
       JOIN patients p ON p.id = pa.patient_id
       WHERE p.clickup_task_id = $1 AND pa.address_type = 'primary'`,
      [TASK.i8],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].state).toBeNull();
    expect(rows.rows[0].city).toBeNull();
    expect(rows.rows[0].neighborhood).toBeNull();
  });
});
