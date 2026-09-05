/**
 * activate-patient-on-hold-cleanup.e2e.test.ts @integration — QA caça rodada 1, achado 🟡2
 *
 * `ActivatePatientUseCase.execute` fazia `UPDATE patients SET status='ACTIVE'` cru, na sua
 * própria transação (a mesma que cria os rascunhos de vaga) — sem passar por
 * `PatientService.moveStatus`. Duas consequências medidas:
 *   1. `on_hold_reason`/`on_hold_note` NÃO eram limpos: um paciente que estava ON_HOLD com
 *      motivo/nota virava ACTIVE e continuava carregando o motivo do hold anterior.
 *   2. A linha em `patient_status_history` (trigger 254) nascia com `change_source = NULL`,
 *      porque nada dava `set_config('app.change_source', ...)` na transação — diferente de
 *      TODA outra transição de estado, que sempre passa por `moveStatus` e sempre grava a
 *      origem.
 *
 * Prova contra Postgres real + API real (Docker, USE_MOCK_AUTH):
 *   ON_HOLD com motivo+nota, 1 endereço ativo → POST /activate → 200; on_hold_reason e
 *   on_hold_note NULL no banco; história ganha ON_HOLD→ACTIVE com change_source='activate'
 *   (não NULL, não 'admin_panel' — é uma origem própria, distinguível de um PUT /status manual).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

describe('Activate limpa on_hold_* e grava change_source no Historial (QA 🟡2) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let patientId = '';

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('activate-onhold-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'act-oh-e2e-%'`);
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number, on_hold_reason, on_hold_note)
       VALUES ('act-oh-e2e-1', 'Ativa', 'DoHold', 'AR', 'ON_HOLD', 998877, 'INSURER', 'La obra social no autorizó — nota e2e')
       RETURNING id`,
    )).rows[0].id;
    await pool.query(
      `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, display_order, country)
       VALUES ($1, 'primary', 'Calle Falsa 123, CABA', 0, 'AR')`,
      [patientId],
    );
  });

  afterAll(async () => {
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE 'act-oh-e2e-%')`,
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'act-oh-e2e-%'`);
    await pool.end();
  });

  it('ON_HOLD com motivo/nota → activate → 200, ACTIVE, on_hold_* NULL, história com change_source=activate', async () => {
    const before = await pool.query(
      `SELECT status, on_hold_reason, on_hold_note FROM patients WHERE id = $1`, [patientId],
    );
    expect(before.rows[0]).toEqual({ status: 'ON_HOLD', on_hold_reason: 'INSURER', on_hold_note: 'La obra social no autorizó — nota e2e' });

    const r = await api.post(`/api/admin/patients/${patientId}/activate`, {}, asAdmin);
    expect(r.status).toBe(200);
    expect(r.data.data.status).toBe('ACTIVE');
    expect(r.data.data.createdVacancyIds).toHaveLength(1);

    const after = await pool.query(
      `SELECT status, on_hold_reason, on_hold_note FROM patients WHERE id = $1`, [patientId],
    );
    // RED antes do conserto: on_hold_reason/on_hold_note continuavam 'INSURER'/a nota antiga —
    // o UPDATE cru só tocava `status` e `updated_at`.
    expect(after.rows[0]).toEqual({ status: 'ACTIVE', on_hold_reason: null, on_hold_note: null });

    const { rows: hist } = await pool.query(
      `SELECT old_value, new_value, change_source FROM patient_status_history WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [patientId],
    );
    // RED antes do conserto: change_source vinha NULL (nenhum set_config na transação do activate).
    expect(hist[0]).toEqual({ old_value: 'ON_HOLD', new_value: 'ACTIVE', change_source: 'activate' });
  });
});
