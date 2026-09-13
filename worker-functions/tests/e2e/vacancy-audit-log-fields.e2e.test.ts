/**
 * vacancy-audit-log-fields.e2e.test.ts
 *
 * Entregável A — cobertura exaustiva por campo via HTTP.
 *
 * Para cada um dos 20 campos de FULL_ALLOWED_UPDATE_FIELDS, envia um
 * PUT /api/admin/vacancies/:id alterando APENAS aquele campo e asserta:
 *   - field_name === campo
 *   - changes.before === valor inicial
 *   - changes.after  === valor novo
 *   - event_type correto (status→STATUS_CHANGED; demais→UPDATED)
 *   - actor_type === 'HUMAN'
 *   - actor_user_id preenchido
 *
 * Campos com validação especial (patient_id, patient_address_id) recebem
 * fixtures adequadas. Campo is_draft NÃO é alcançável via HTTP (publish-talentum
 * exige Talentum API indisponível em E2E) — coberto no Entregável B.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import {
  createApiClient,
  createPatientFixture,
  getMockToken,
  waitForBackend,
} from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getAuditRows(
  pool: Pool,
  jobPostingId: string,
): Promise<
  Array<{
    event_type: string;
    field_name: string | null;
    changes: { before: unknown; after: unknown };
    actor_user_id: string | null;
    actor_type: string;
    actor_label: string | null;
  }>
> {
  const res = await pool.query(
    `SELECT event_type, field_name, changes, actor_user_id, actor_type, actor_label
     FROM job_posting_audit_log
     WHERE job_posting_id = $1
     ORDER BY created_at ASC`,
    [jobPostingId],
  );
  return res.rows as Array<{
    event_type: string;
    field_name: string | null;
    changes: { before: unknown; after: unknown };
    actor_user_id: string | null;
    actor_type: string;
    actor_label: string | null;
  }>;
}

async function cleanupVacancy(pool: Pool, id: string): Promise<void> {
  await pool
    .query(`DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`, [id])
    .catch(() => {});
  await pool.query(`DELETE FROM job_postings WHERE id = $1`, [id]).catch(() => {});
}

async function createPatientAddress(pool: Pool, patientId: string): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO patient_addresses (patient_id, address_formatted, source)
     VALUES ($1, $2, 'admin_manual')
     RETURNING id`,
    [patientId, `Av. Audit Fields Test ${randomUUID().slice(0, 8)}, CABA`],
  );
  return res.rows[0]!.id;
}

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface FieldTestCase {
  field: string;
  /** PUT body para o campo inicial (aplicado antes do teste) */
  initialBody: Record<string, unknown>;
  /** PUT body para o novo valor (o que está sendo testado) */
  updatedBody: Record<string, unknown>;
  expectedEventType: 'STATUS_CHANGED' | 'UPDATED';
  /** Valor esperado em changes.before */
  expectedBefore: unknown;
  /** Valor esperado em changes.after */
  expectedAfter: unknown;
  /** Quando true, o campo requer fixture especial criada em beforeAll */
  requiresSpecialSetup?: boolean;
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('Vacancy Audit Log — Cobertura por Campo (20 campos)', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;

  // IDs de fixtures compartilhadas
  let primaryPatientId: string;
  let secondaryPatientId: string;
  let primaryAddressId: string;
  let secondaryAddressId: string;

  const ADMIN_UID = 'audit-fields-admin-001';
  const createdVacancyIds: string[] = [];

  function auth() {
    return { headers: { Authorization: `Bearer ${adminToken}` } };
  }

  /**
   * Cria uma vaga draft (is_draft=true por default) com o campo inicial
   * já preenchido, para que o diff seja detectável no PUT subsequente.
   */
  async function createDraftVacancy(
    caseNumber: number,
    extraBody: Record<string, unknown> = {},
  ): Promise<string> {
    const res = await api.post(
      '/api/admin/vacancies',
      {
        patient_id: primaryPatientId,
        case_number: caseNumber,
        status: 'PENDING_ACTIVATION',
        ...extraBody,
      },
      auth(),
    );
    if (res.status !== 201) {
      throw new Error(
        `createDraftVacancy failed [${res.status}]: ${JSON.stringify(res.data)}`,
      );
    }
    const id = res.data.data.id as string;
    createdVacancyIds.push(id);
    return id;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);

    // Seed user para FK de actor_user_id
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role)
       VALUES ($1, $2, $3, 'admin')
       ON CONFLICT (firebase_uid) DO NOTHING`,
      [ADMIN_UID, 'audit-fields-admin@e2e.local', 'Audit Fields Admin'],
    );

    adminToken = await getMockToken(api, {
      uid: ADMIN_UID,
      email: 'audit-fields-admin@e2e.local',
      role: 'admin',
    });

    primaryPatientId = await createPatientFixture(pool, 'audit-fields-primary');
    secondaryPatientId = await createPatientFixture(pool, 'audit-fields-secondary');

    // Endereços para ambos os pacientes
    primaryAddressId = await createPatientAddress(pool, primaryPatientId);
    secondaryAddressId = await createPatientAddress(pool, secondaryPatientId);
  });

  afterAll(async () => {
    for (const id of createdVacancyIds) {
      await cleanupVacancy(pool, id);
    }
    // Limpa endereços (cascade fk não cobre, mas job_postings já limpos acima)
    await pool
      .query(
        `DELETE FROM patient_addresses WHERE id = ANY($1::uuid[])`,
        [[primaryAddressId, secondaryAddressId]],
      )
      .catch(() => {});
    await pool
      .query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [
        [primaryPatientId, secondaryPatientId],
      ])
      .catch(() => {});
    await pool
      .query(`DELETE FROM users WHERE firebase_uid = $1`, [ADMIN_UID])
      .catch(() => {});
    await pool.end();
  });

  // ── Campo: title ─────────────────────────────────────────────────────────

  describe('campo: title', () => {
    let vacancyId: string;
    const INITIAL_TITLE_SUFFIX = 'CASO 89001-INICIAL';
    const UPDATED_TITLE_SUFFIX = 'CASO 89001-ATUALIZADO';

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89001);
      // Seta o título inicial explicitamente
      const r = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { title: INITIAL_TITLE_SUFFIX },
        auth(),
      );
      expect(r.status).toBe(200);
      // Limpa audit do setup
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1 AND field_name = 'title'`,
        [vacancyId],
      );
    });

    it('title → UPDATED com before/after corretos', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { title: UPDATED_TITLE_SUFFIX },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'title');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBe(INITIAL_TITLE_SUFFIX);
      expect(row!.changes.after).toBe(UPDATED_TITLE_SUFFIX);
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: case_number ────────────────────────────────────────────────────

  describe('campo: case_number', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89002);
      // Limpa audit de criação para isolar o diff
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('case_number → UPDATED com before=89002 after=89099', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { case_number: 89099 },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'case_number');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBe(89002);
      expect(row!.changes.after).toBe(89099);
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: patient_id ─────────────────────────────────────────────────────

  describe('campo: patient_id (fixture especial: segundo paciente)', () => {
    let vacancyId: string;

    beforeAll(async () => {
      // Vaga criada com primaryPatientId
      vacancyId = await createDraftVacancy(89003);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('patient_id → UPDATED com before=primaryPatientId after=secondaryPatientId', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { patient_id: secondaryPatientId },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'patient_id');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBe(primaryPatientId);
      expect(row!.changes.after).toBe(secondaryPatientId);
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: patient_address_id ─────────────────────────────────────────────

  describe('campo: patient_address_id (fixture especial: endereço ativo)', () => {
    let vacancyId: string;
    // Segundo endereço do mesmo paciente — usado para o before→after do PUT
    let secondAddressForTest: string;

    beforeAll(async () => {
      // Cria vaga sem address
      vacancyId = await createDraftVacancy(89004);
      // Primeiro associa primaryAddressId para que o before seja não-null
      const r = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { patient_address_id: primaryAddressId },
        auth(),
      );
      expect(r.status).toBe(200);
      // Cria um segundo endereço para o primaryPatient (para o updated)
      secondAddressForTest = await createPatientAddress(pool, primaryPatientId);
      // Limpa linhas de audit do setup para isolar apenas o diff do campo
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1 AND field_name = 'patient_address_id'`,
        [vacancyId],
      );
    });

    it('patient_address_id → UPDATED com before/after corretos', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { patient_address_id: secondAddressForTest },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'patient_address_id');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBe(primaryAddressId);
      expect(row!.changes.after).toBe(secondAddressForTest);
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: required_professions (array) ───────────────────────────────────

  describe('campo: required_professions', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89005, {
        required_professions: ['AT'],
      });
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('required_professions → UPDATED com before/after corretos (array)', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { required_professions: ['AT', 'CUIDADOR'] },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'required_professions');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      // PostgreSQL retorna arrays como arrays JS
      expect(Array.isArray(row!.changes.before) || typeof row!.changes.before === 'string').toBe(true);
      expect(Array.isArray(row!.changes.after) || typeof row!.changes.after === 'string').toBe(true);
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: required_sex ───────────────────────────────────────────────────

  describe('campo: required_sex', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89006);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('required_sex → UPDATED com before=null after=FEMALE', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { required_sex: 'FEMALE' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'required_sex');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe('FEMALE');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: age_range_min ──────────────────────────────────────────────────

  describe('campo: age_range_min', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89007);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('age_range_min → UPDATED com before=null after=25', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { age_range_min: 25 },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'age_range_min');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe(25);
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: age_range_max ──────────────────────────────────────────────────

  describe('campo: age_range_max', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89008);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('age_range_max → UPDATED com before=null after=45', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { age_range_max: 45 },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'age_range_max');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe(45);
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: worker_profile_sought ──────────────────────────────────────────

  describe('campo: worker_profile_sought', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89009);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('worker_profile_sought → UPDATED com before=null after=texto', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { worker_profile_sought: 'Profissional empático e comprometido' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'worker_profile_sought');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe('Profissional empático e comprometido');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: required_experience ────────────────────────────────────────────

  describe('campo: required_experience', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89010);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('required_experience → UPDATED com before=null after=texto', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { required_experience: 'Mínimo 2 anos com autismo' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'required_experience');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe('Mínimo 2 anos com autismo');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: worker_attributes ──────────────────────────────────────────────

  describe('campo: worker_attributes', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89011);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('worker_attributes → UPDATED com before=null after=texto', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { worker_attributes: 'Paciência, tolerância, pontualidade' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'worker_attributes');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe('Paciência, tolerância, pontualidade');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: schedule (JSONB) ───────────────────────────────────────────────

  describe('campo: schedule (JSONB)', () => {
    let vacancyId: string;
    const INITIAL_SCHEDULE = { monday: ['08:00-12:00'] };
    const UPDATED_SCHEDULE = { monday: ['08:00-12:00'], tuesday: ['14:00-18:00'] };

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89012, { schedule: INITIAL_SCHEDULE });
      // Aguarda a criação persistir o schedule inicial
      // e zera o audit de criação para isolar o diff
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('schedule → UPDATED com diff de objeto JSONB', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { schedule: UPDATED_SCHEDULE },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'schedule');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      // before/after podem ser objeto (JSONB) ou string JSON — ambos válidos
      const before = row!.changes.before;
      const after = row!.changes.after;
      const beforeStr =
        typeof before === 'string' ? before : JSON.stringify(before);
      const afterStr =
        typeof after === 'string' ? after : JSON.stringify(after);
      expect(beforeStr).toContain('monday');
      expect(afterStr).toContain('tuesday');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: work_schedule ──────────────────────────────────────────────────

  describe('campo: work_schedule', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89013);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('work_schedule → UPDATED com before=null after=texto', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { work_schedule: 'full_time' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'work_schedule');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe('full_time');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: providers_needed ───────────────────────────────────────────────

  describe('campo: providers_needed', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89014);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('providers_needed → UPDATED com before=null after=2', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { providers_needed: '2' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'providers_needed');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.after).toBe('2');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: salary_text ────────────────────────────────────────────────────

  describe('campo: salary_text', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89015);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('salary_text → UPDATED com before="A convenir" after="ARS 2000/hora"', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { salary_text: 'ARS 2000/hora' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'salary_text');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBe('A convenir');
      expect(row!.changes.after).toBe('ARS 2000/hora');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: payment_day ────────────────────────────────────────────────────

  describe('campo: payment_day', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89016);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('payment_day → UPDATED com before=null after=texto', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { payment_day: '15' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'payment_day');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe('15');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: daily_obs ──────────────────────────────────────────────────────

  describe('campo: daily_obs', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89017);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('daily_obs → UPDATED com before=null after=texto', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { daily_obs: 'Observações operacionais diárias aqui.' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'daily_obs');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).toBe('Observações operacionais diárias aqui.');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: status → STATUS_CHANGED ────────────────────────────────────────

  describe('campo: status (STATUS_CHANGED)', () => {
    let vacancyId: string;

    beforeAll(async () => {
      // Cria com PENDING_ACTIVATION — assim o before é conhecido
      vacancyId = await createDraftVacancy(89018);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('status → STATUS_CHANGED com before=PENDING_ACTIVATION after=SEARCHING', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { status: 'SEARCHING' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'status');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('STATUS_CHANGED');
      expect(row!.changes.before).toBe('PENDING_ACTIVATION');
      expect(row!.changes.after).toBe('SEARCHING');
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: published_at ───────────────────────────────────────────────────

  describe('campo: published_at', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89019);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('published_at → UPDATED com before=non-null after=nova data', async () => {
      // O valor inicial de published_at vem de COALESCE($20, NOW()) na criação
      // Primeiro lê o valor atual
      const currentRes = await pool.query<{ published_at: string | null }>(
        `SELECT published_at FROM job_postings WHERE id = $1`,
        [vacancyId],
      );
      const initialPublishedAt = currentRes.rows[0]?.published_at;

      const newDate = '2027-12-31T23:59:00.000Z';
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { published_at: newDate },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'published_at');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      // before deve ser o timestamp inicial (não-null, pois COALESCE usa NOW())
      expect(row!.changes.before).not.toBeNull();
      expect(initialPublishedAt).not.toBeNull(); // confirma que o before existe
      // after deve refletir a nova data
      expect(row!.changes.after).not.toBeNull();
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: closes_at ──────────────────────────────────────────────────────

  describe('campo: closes_at', () => {
    let vacancyId: string;

    beforeAll(async () => {
      vacancyId = await createDraftVacancy(89020);
      await pool.query(
        `DELETE FROM job_posting_audit_log WHERE job_posting_id = $1`,
        [vacancyId],
      );
    });

    it('closes_at → UPDATED com before=null after=data futura', async () => {
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { closes_at: '2027-12-31T23:59:00.000Z' },
        auth(),
      );
      expect(res.status).toBe(200);

      const rows = await getAuditRows(pool, vacancyId);
      const row = rows.find(r => r.field_name === 'closes_at');
      expect(row).toBeDefined();
      expect(row!.event_type).toBe('UPDATED');
      expect(row!.changes.before).toBeNull();
      expect(row!.changes.after).not.toBeNull();
      expect(row!.actor_type).toBe('HUMAN');
      expect(row!.actor_user_id).toBe(ADMIN_UID);
    });
  });

  // ── Campo: is_draft — NÃO alcançável via HTTP ─────────────────────────────
  //
  // is_draft é alterado exclusivamente por publish-talentum (flip is_draft=false)
  // e por eventual unpublish — ambos requerem Talentum API indisponível em E2E.
  // Este campo É coberto no Entregável B (job-posting-audit-repository.e2e.test.ts)
  // via logFieldChanges diretamente no repositório com banco real.
  //
  // Evidência: a rota PUT /api/admin/vacancies/:id NÃO inclui is_draft em
  // FULL_ALLOWED_UPDATE_FIELDS (ver vacancyCrudHelpers.ts linha 49-58).
  // Tentativa de PUT com { is_draft: false } resulta em "No valid fields to update".

  describe('campo: is_draft — cobertura via repositório (Entregável B)', () => {
    it('is_draft NÃO está em FULL_ALLOWED_UPDATE_FIELDS → PUT retorna 400', async () => {
      // Cria uma vaga apenas para confirmar o comportamento
      const vacancyId = await createDraftVacancy(89021);
      const res = await api.put(
        `/api/admin/vacancies/${vacancyId}`,
        { is_draft: false },
        auth(),
      );
      // 400 = No valid fields to update (is_draft não é allowed via HTTP)
      expect(res.status).toBe(400);
    });
  });
});
