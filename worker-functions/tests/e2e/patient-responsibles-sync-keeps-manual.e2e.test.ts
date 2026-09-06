/**
 * patient-responsibles-sync-keeps-manual.e2e.test.ts — QA caça 🔴1 (spec 011, rodada 2), Postgres REAL.
 *
 * O sync do ClickUp (`upsertFromClickUp` → `upsertRelated`) substituía TODOS os
 * responsáveis do paciente (`replaceAll`) sempre que `input.responsibles !== undefined`
 * — e o mapper devolve `[]`, nunca undefined. Um familiar criado no painel
 * (`source='admin_manual'`) ou pelo formulário público (`web_form`) sumia no
 * `taskUpdated` seguinte.
 *
 * Regra nova: o SYNC substitui só as linhas `source='clickup'`; as demais são
 * intocadas. O drawer (seção `support-network`) continua replace-all — é a lista
 * inteira que a tela edita. Como o banco exige no máximo 1 titular por paciente
 * (idx_patient_responsibles_one_primary), quando já existe titular manual a linha
 * do ClickUp entra como não-titular em vez de derrubar o sync.
 */
import { Pool } from 'pg';
import { PatientService } from '../../src/modules/case/application/PatientService';
import type { PatientResponsibleInput } from '../../src/modules/case/domain/PatientResponsible';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
if (!process.env.DATABASE_URL) process.env.DATABASE_URL = DATABASE_URL;

const TASK = 'e2e-sync-keeps-manual-001';
const clickupResp = (over: Partial<PatientResponsibleInput> = {}): PatientResponsibleInput => ({
  firstName: 'Madre', lastName: 'ClickUp', relationship: 'PARENT', phone: '+5491100000041', email: null,
  documentType: 'DNI', documentNumber: '30111222', isPrimary: true, displayOrder: 1, source: 'clickup', ...over,
});

interface Row { first_name: string; source: string; is_primary: boolean }

describe('🔴1 — o sync do ClickUp não apaga familiar criado no painel', () => {
  let pool: Pool;
  const svc = new PatientService();

  const rows = async (id: string): Promise<Row[]> =>
    (await pool.query<Row>('SELECT first_name, source, is_primary FROM patient_responsibles WHERE patient_id = $1 ORDER BY source, first_name', [id])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [`${TASK}%`]);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [`${TASK}%`]).catch(() => {});
    await pool.end();
  });

  it('sync → painel adiciona familiar manual → sync de novo → o manual continua e a linha do ClickUp é a atual', async () => {
    const { id } = await svc.upsertFromClickUp({ clickupTaskId: TASK, firstName: 'Pac', lastName: 'Sync', phoneWhatsapp: '+5491100000040', responsibles: [clickupResp()] });
    expect(await rows(id)).toEqual([{ first_name: 'Madre', source: 'clickup', is_primary: true }]);

    // O drawer reenvia a linha do ClickUp e acrescenta um familiar do painel (não-titular).
    await svc.updatePatientSection(id, 'support-network', {
      responsibles: [clickupResp({ displayOrder: 0 }), { firstName: 'Tio', lastName: 'Painel', isPrimary: false, displayOrder: 1, source: 'admin_manual' }],
    });
    expect(await rows(id)).toHaveLength(2);

    // ClickUp manda um taskUpdated com o telefone da mãe alterado.
    await svc.upsertFromClickUp({ clickupTaskId: TASK, firstName: 'Pac', lastName: 'Sync', phoneWhatsapp: '+5491100000040', responsibles: [clickupResp({ phone: '+5491100000042' })] });
    const after = await rows(id);
    expect(after).toEqual([
      { first_name: 'Tio', source: 'admin_manual', is_primary: false },
      { first_name: 'Madre', source: 'clickup', is_primary: true },
    ]);
    const phone = await pool.query<{ p: string }>("SELECT convert_from(decode(phone_encrypted,'base64'),'UTF8') AS p FROM patient_responsibles WHERE patient_id = $1 AND source = 'clickup'", [id]);
    expect(phone.rows[0].p).toBe('+5491100000042');
  });

  it('titular manual + titular vindo do ClickUp → o sync não quebra e a linha do ClickUp entra como não-titular', async () => {
    const task = `${TASK}-primary`;
    const { id } = await svc.upsertFromClickUp({ clickupTaskId: task, firstName: 'Pac', lastName: 'Prim', phoneWhatsapp: '+5491100000050', responsibles: [clickupResp()] });
    // Painel troca o titular: o familiar do painel passa a ser o titular.
    await svc.updatePatientSection(id, 'support-network', {
      responsibles: [clickupResp({ isPrimary: false, displayOrder: 0 }), { firstName: 'Tia', lastName: 'Painel', phone: '+5491100000051', isPrimary: true, displayOrder: 1, source: 'admin_manual' }],
    });
    await svc.upsertFromClickUp({ clickupTaskId: task, firstName: 'Pac', lastName: 'Prim', phoneWhatsapp: '+5491100000050', responsibles: [clickupResp()] });
    expect(await rows(id)).toEqual([
      { first_name: 'Tia', source: 'admin_manual', is_primary: true },
      { first_name: 'Madre', source: 'clickup', is_primary: false },
    ]);
  });

  it('ClickUp sem responsável ([] do mapper) apaga SÓ as linhas clickup; a manual fica', async () => {
    const task = `${TASK}-empty`;
    const { id } = await svc.upsertFromClickUp({ clickupTaskId: task, firstName: 'Pac', lastName: 'Empty', phoneWhatsapp: '+5491100000060', responsibles: [clickupResp()] });
    await svc.updatePatientSection(id, 'support-network', {
      responsibles: [clickupResp({ displayOrder: 0 }), { firstName: 'Primo', lastName: 'Painel', isPrimary: false, displayOrder: 1, source: 'admin_manual' }],
    });
    await svc.upsertFromClickUp({ clickupTaskId: task, firstName: 'Pac', lastName: 'Empty', phoneWhatsapp: '+5491100000060', responsibles: [] });
    expect(await rows(id)).toEqual([{ first_name: 'Primo', source: 'admin_manual', is_primary: false }]);
  });
});
