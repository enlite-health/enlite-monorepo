/**
 * clickup-mapper-roundtrip.test.ts
 *
 * Integration test: ClickUp API → ClickUpPatientMapper → PatientService → DB.
 *
 * Roundtrip completo usando uma task seed dedicada no ClickUp
 * (`86ahcdkx2` — `[E2E_TEST_DO_NOT_EDIT] Test Patient`). Se ops modificar
 * essa task, o test pode quebrar — por design, é o sinal pra revisar.
 *
 * Detecta drift mapper↔DB que unit tests com fixture local NÃO pegariam:
 *   - Tipos serializados pela ClickUp diferentes do esperado (string vs number vs boolean)
 *   - Campos que o repo INSERT esquece de incluir
 *   - Triggers/defaults DB que sobrescrevem o input
 *
 * Pula automaticamente se CLICKUP_API_TOKEN ausente — CI safe.
 */

import { Pool } from 'pg';
import { ClickUpFieldResolver } from '../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import { ClickUpPatientMapper } from '../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpTask } from '../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import { PatientService } from '../../src/modules/case/application/PatientService';

const TEST_TASK_ID = '86ahcdkx2';
const PATIENT_LIST_ID = '901304883903';
const CLICKUP_API_BASE = 'https://api.clickup.com/api/v2';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const TOKEN = process.env.CLICKUP_API_TOKEN;

// Pula tudo se token ausente — CI safe
const describeIfToken = TOKEN ? describe : describe.skip;

describeIfToken('ClickUp → DB roundtrip (real task)', () => {
  let pool: Pool;
  let mapper: ClickUpPatientMapper;
  let patientService: PatientService;
  let task: ClickUpTask;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    const resolver = await ClickUpFieldResolver.fromList(PATIENT_LIST_ID, { token: TOKEN! });
    mapper = new ClickUpPatientMapper(resolver);
    patientService = new PatientService();

    const res = await fetch(`${CLICKUP_API_BASE}/task/${TEST_TASK_ID}`, {
      headers: { Authorization: TOKEN! },
    });
    if (!res.ok) {
      throw new Error(
        `Failed to fetch seed task ${TEST_TASK_ID}: HTTP ${res.status}. ` +
        `Verifique se a task ainda existe na lista 901 com prefixo [E2E_TEST_DO_NOT_EDIT].`,
      );
    }
    task = (await res.json()) as ClickUpTask;
  });

  afterAll(async () => {
    // Cleanup do DB — não toca na task ClickUp
    await pool.query('DELETE FROM patients WHERE clickup_task_id = $1', [TEST_TASK_ID]);
    await pool.end();
  });

  it('mapper extrai task seed sem retornar null', () => {
    const input = mapper.map(task);
    expect(input).not.toBeNull();
  });

  it('persiste paciente com TODOS os campos esperados no DB (roundtrip completo)', async () => {
    // Cleanup prévio caso run anterior tenha deixado lixo
    await pool.query('DELETE FROM patients WHERE clickup_task_id = $1', [TEST_TASK_ID]);

    const input = mapper.map(task);
    expect(input).not.toBeNull();

    const result = await patientService.upsertFromClickUp(input!, { onMissingContact: 'flag' });
    expect(result.id).toBeDefined();
    expect(result.created).toBe(true);

    // ── Validar coluna por coluna no DB ──
    const { rows } = await pool.query(
      `SELECT
         clickup_task_id, first_name, last_name, birth_date,
         document_type, document_number, sex,
         diagnosis, dependency_level,
         has_cud, has_consent, has_judicial_protection,
         country, status, case_number,
         needs_attention, attention_reasons
       FROM patients
       WHERE id = $1`,
      [result.id],
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];

    // Identity
    expect(row.clickup_task_id).toBe(TEST_TASK_ID);
    expect(row.first_name).toBe('Test (E2E)');
    expect(row.last_name).toBe('SeedPatient');
    expect(row.birth_date.toISOString().slice(0, 10)).toBe('1990-01-14');
    expect(row.document_type).toBe('DNI');
    expect(row.document_number).toBe('99.999.999');
    expect(row.sex).toBe('MALE');

    // Clinical
    expect(row.diagnosis).toBe('E2E test diagnosis');
    expect(row.dependency_level).toBe('MODERATE');

    // Booleans (pegariam o bug que corrigimos: ClickUp envia 'true' como string)
    expect(row.has_cud).toBe(true);
    expect(row.has_consent).toBe(false);             // não populamos na task
    expect(row.has_judicial_protection).toBe(false); // não populamos na task

    // Operational
    expect(row.country).toBe('AR');
    expect(row.status).toBe('ACTIVE');               // status ClickUp 'busqueda'
    expect(row.case_number).toBe(99999);

    // ── Responsibles (1 row, isPrimary=true) ──
    const respRows = await pool.query(
      `SELECT first_name, last_name, relationship, is_primary, display_order, source
       FROM patient_responsibles
       WHERE patient_id = $1`,
      [result.id],
    );
    expect(respRows.rows).toHaveLength(1);
    expect(respRows.rows[0]).toMatchObject({
      first_name: 'Tutor',
      relationship: 'PARENT',
      is_primary: true,
      display_order: 1,
      source: 'clickup',
    });
  });

  it('re-executar (taskUpdated) é idempotente — mesmo patient_id, sem duplicatas', async () => {
    const input = mapper.map(task);
    const first = await patientService.upsertFromClickUp(input!, { onMissingContact: 'flag' });
    const second = await patientService.upsertFromClickUp(input!, { onMissingContact: 'flag' });

    expect(second.id).toBe(first.id);
    expect(second.created).toBe(false);

    const { rows } = await pool.query(
      'SELECT COUNT(*) FROM patients WHERE clickup_task_id = $1',
      [TEST_TASK_ID],
    );
    expect(parseInt(rows[0].count, 10)).toBe(1);

    const respRows = await pool.query(
      'SELECT COUNT(*) FROM patient_responsibles WHERE patient_id = $1',
      [first.id],
    );
    expect(parseInt(respRows.rows[0].count, 10)).toBe(1);
  });
});
