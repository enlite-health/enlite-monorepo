/**
 * patient-device-type-source-isolation.e2e.test.ts @integration — QA caça rodada 1, achado 🔴1
 *
 * `PatientDeviceTypeRepository.replaceForPatient` (webhook ClickUp) e `.replaceCodesForPatient`
 * (painel) faziam `DELETE FROM patient_device_types WHERE patient_id = $1` SEM `AND source = $2`
 * — cada caminho apagava o conjunto INTEIRO do paciente, inclusive o que o outro caminho tinha
 * gravado. Mesma classe de defeito que `PatientInsuranceVerifiedRepository` já resolve (ver
 * `patient-coverage-catalog.e2e.test.ts`, teste 4).
 *
 * Prova contra Postgres real, nos dois sentidos:
 *   1. webhook grava HOME (source=clickup) → painel grava SCHOOL (source=admin_manual) → os DOIS
 *      sobrevivem, e o escalar derivado `patients.device_type` (trigger 310) reflete um dos dois
 *      (união: o leitor de `patient_device_types` — `PatientDetailQueryHelper.deviceTypes` — e o
 *      próprio `findByPatientId` já leem TODAS as origens, sem filtro de source).
 *   2. o inverso: painel grava SCHOOL → webhook grava HOME → os DOIS sobrevivem.
 *
 * Controle positivo (D157): comentado ao lado de cada asserção-chave — reverter o `AND source =
 * $2` da migration desta rodada faz o teste cair, porque o segundo `replace*` apagaria o
 * primeiro. Colado no relatório.
 */
import { Pool } from 'pg';
import {
  PatientDeviceTypeRepository,
} from '../../src/modules/case/infrastructure/PatientDeviceTypeRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

describe('Tipo de Dispositivo: DELETE isolado por origem (QA 🔴1) @integration', () => {
  let pool: Pool;
  let repo: PatientDeviceTypeRepository;
  let patientA = '';
  let patientB = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new PatientDeviceTypeRepository();
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'dvt-e2e-%'`);
    patientA = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('dvt-e2e-a', 'Isola', 'WebhookPrimeiro', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
    patientB = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ('dvt-e2e-b', 'Isola', 'PainelPrimeiro', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE 'dvt-e2e-%'`);
    await pool.end();
  });

  it('1. webhook HOME → painel SCHOOL → os DOIS ficam', async () => {
    const w = await repo.replaceForPatient({ patientId: patientA, read: { readable: true, labels: ['Domiciliario'] } });
    expect(w.outcome).toBe('written');
    expect(w.accepted).toEqual(['HOME']);

    const p = await repo.replaceCodesForPatient(patientA, ['SCHOOL']);
    expect(p.changed).toBe(true);

    const { rows } = await pool.query(
      `SELECT device_type, source FROM patient_device_types WHERE patient_id = $1 ORDER BY device_type`, [patientA],
    );
    // Controle positivo: sem `AND source = $2` no DELETE de replaceCodesForPatient, a linha
    // ('HOME','clickup') teria sido apagada por este 2º replace, e este `toEqual` cairia com
    // só 1 linha (SCHOOL).
    expect(rows).toEqual([
      { device_type: 'HOME', source: 'clickup' },
      { device_type: 'SCHOOL', source: 'admin_manual' },
    ]);

    // O leitor (findByPatientId) já é união entre origens — sem filtro de source.
    expect((await repo.findByPatientId(patientA)).sort()).toEqual(['HOME', 'SCHOOL']);

    // O escalar derivado (trigger 310) reflete UM dos dois, por sort_order — não fica vazio.
    const { rows: [pt] } = await pool.query<{ device_type: string }>(
      `SELECT device_type FROM patients WHERE id = $1`, [patientA],
    );
    expect(['HOME', 'SCHOOL']).toContain(pt.device_type);
  });

  it('2. painel SCHOOL → webhook HOME → os DOIS ficam (sentido inverso)', async () => {
    const p = await repo.replaceCodesForPatient(patientB, ['SCHOOL']);
    expect(p.changed).toBe(true);

    const w = await repo.replaceForPatient({ patientId: patientB, read: { readable: true, labels: ['Domiciliario'] } });
    expect(w.outcome).toBe('written');
    expect(w.accepted).toEqual(['HOME']);

    const { rows } = await pool.query(
      `SELECT device_type, source FROM patient_device_types WHERE patient_id = $1 ORDER BY device_type`, [patientB],
    );
    // Controle positivo: sem o filtro de source no DELETE de replaceForPatient (webhook), a
    // linha ('SCHOOL','admin_manual') gravada pelo painel teria sido apagada aqui.
    expect(rows).toEqual([
      { device_type: 'HOME', source: 'clickup' },
      { device_type: 'SCHOOL', source: 'admin_manual' },
    ]);
    expect((await repo.findByPatientId(patientB)).sort()).toEqual(['HOME', 'SCHOOL']);
  });
});
