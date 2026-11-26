/**
 * O foguete é o ÚNICO gatilho de Búsqueda (estado-automatico-do-paciente, F1, D1/D2) @integration
 *
 * Pela borda, com banco real e sem mock: `POST /patients/:id/contracted-services/:sid/activate-recruitment`.
 *   - paciente em ADMISSION com 2 serviços ativos, o 2º SEM horário: o foguete no 1º (completo) → 201, o corpo NÃO traz a
 *     chave `patientNotMoved` (o ramo deixou de existir), `patients.status = 'SEARCHING'`, trilha `recruitment_activation` = 1,
 *     vaga `is_draft = true`. Antes da F1 o escritor media o paciente INTEIRO e travava no 2º serviço ("vaga criada, paciente parado");
 *   - foguete no serviço SEM horário → 422 PATIENT_NOT_READY (o gate do foguete mede o serviço clicado), 0 vaga nova, paciente intacto;
 *   - paciente que já está ACTIVE → 201 e o estado fica intacto, sem linha de trilha do foguete.
 *
 * Outbound mapeado: o foguete só faz SELECT/INSERT em Postgres (lock, vaga, trilha) — nenhum Twilio/WhatsApp/Talentum/Ana Care/Google
 * no caminho; o envio à Talentum não é chamado aqui. Fixtures sintéticas (sobrenome " QA"), nenhum texto clínico.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { semearFaixas } from './helpers/seedFaixaDoServico';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'foguete-unico-e2e-%';
const HORARIO = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }];

describe('Foguete único gatilho de Búsqueda (D1/D2) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: StaffAuth;

  async function limpar(): Promise<void> {
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
  }

  /** Paciente com endereço e N serviços ativos (cada um: com ou sem horário), com cobertura e diagnóstico (as outras travas do gate passam). */
  async function criarPaciente(tag: string, status: string, servicos: Array<{ comHorario: boolean }>): Promise<{ patientId: string; serviceIds: string[] }> {
    const patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, insurance_informed)
       VALUES ($1, 'Foguete', 'Unico QA', 'AR', $2, 'Particular') RETURNING id`,
      [`foguete-unico-e2e-${tag}`, status],
    )).rows[0].id;
    await seedPatientDiagnosis(pool, patientId);
    const addressId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1, 'Calle Foguete 1', 1) RETURNING id`,
      [patientId],
    )).rows[0].id;
    const serviceIds: string[] = [];
    for (const s of servicos) {
      const sid = (await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services
           (patient_id, service_code, active, country, created_by, updated_by, address_id,
            required_professions, required_sex, required_experience, work_schedule, payment_day)
         VALUES ($1, 'AT', true, 'AR', 'foguete-unico-e2e', 'foguete-unico-e2e', $2, ARRAY['AT'], 'BOTH', 'EXP-E2E', 'part-time', 'DIA-E2E')
         RETURNING id`,
        [patientId, addressId],
      )).rows[0].id;
      await semearFaixas(pool, sid, s.comHorario ? HORARIO : [], 'foguete-unico-e2e');
      serviceIds.push(sid);
    }
    return { patientId, serviceIds };
  }

  const foguete = (patientId: string, serviceId: string) =>
    api.post(`/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, {}, asAdmin);
  const statusDe = async (patientId: string): Promise<string> =>
    (await pool.query<{ status: string }>('SELECT status FROM patients WHERE id = $1', [patientId])).rows[0].status;
  const vagasDe = async (patientId: string): Promise<number> =>
    Number((await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [patientId])).rows[0].n);
  const trilhaDoFoguete = async (patientId: string): Promise<number> =>
    Number((await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM patient_status_history WHERE patient_id = $1 AND change_source = 'recruitment_activation'`, [patientId],
    )).rows[0].n);

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    asAdmin = await staffAuth('foguete-unico-e2e-admin', 'admin');
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role) VALUES ($1, $2, $3, 'admin') ON CONFLICT (firebase_uid) DO NOTHING`,
      [asAdmin.uid, 'foguete-unico-e2e-admin@e2e.local', 'Foguete Unico E2E Admin'],
    );
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('FELIZ: ADMISSION com 2 serviços, o 2º sem horário — foguete no completo → 201 sem patientNotMoved, SEARCHING, trilha 1, vaga rascunho', async () => {
    const { patientId, serviceIds } = await criarPaciente('feliz', 'ADMISSION', [{ comHorario: true }, { comHorario: false }]);

    // controle positivo: o cenário é REAL — 2 serviços ativos e exatamente 1 sem faixa vigente
    const { rows: [conta] } = await pool.query<{ ativos: string; sem_horario: string }>(
      `SELECT COUNT(*) AS ativos,
              COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM patient_itinerary_slot s WHERE s.contracted_service_id = pcs.id)) AS sem_horario
         FROM patient_contracted_services pcs WHERE pcs.patient_id = $1 AND pcs.active`,
      [patientId],
    );
    expect({ ativos: Number(conta.ativos), semHorario: Number(conta.sem_horario) }).toEqual({ ativos: 2, semHorario: 1 });
    expect(await trilhaDoFoguete(patientId)).toBe(0);

    const r = await foguete(patientId, serviceIds[0]);
    expect(r.status).toBe(201);
    expect(Object.keys(r.data.data).sort()).toEqual(['patientStatus', 'statusChanged', 'vacancyId']);
    expect(r.data.data).not.toHaveProperty('patientNotMoved');
    expect(r.data.data.patientStatus).toBe('SEARCHING');
    expect(r.data.data.statusChanged).toBe(true);

    expect(await statusDe(patientId)).toBe('SEARCHING');
    expect(await trilhaDoFoguete(patientId)).toBe(1);
    const { rows: [vaga] } = await pool.query<{ is_draft: boolean; contracted_service_id: string }>(
      'SELECT is_draft, contracted_service_id FROM job_postings WHERE id = $1', [r.data.data.vacancyId],
    );
    expect(vaga).toEqual({ is_draft: true, contracted_service_id: serviceIds[0] });
  });

  it('ALTERNATIVO 1: foguete no serviço SEM horário → 422 PATIENT_NOT_READY, nenhuma vaga nova, paciente intacto', async () => {
    const { patientId, serviceIds } = await criarPaciente('sem-horario', 'ADMISSION', [{ comHorario: true }, { comHorario: false }]);

    const r = await foguete(patientId, serviceIds[1]);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toContain('SERVICE_SCHEDULE');

    expect(await vagasDe(patientId)).toBe(0);
    expect(await statusDe(patientId)).toBe('ADMISSION');
    expect(await trilhaDoFoguete(patientId)).toBe(0);
  });

  it('ALTERNATIVO 2: paciente já ACTIVE → 201, vaga criada, estado intacto e nenhuma linha de trilha do foguete', async () => {
    const { patientId, serviceIds } = await criarPaciente('ativo', 'ACTIVE', [{ comHorario: true }, { comHorario: false }]);

    const r = await foguete(patientId, serviceIds[0]);
    expect(r.status).toBe(201);
    expect(r.data.data).toMatchObject({ patientStatus: 'ACTIVE', statusChanged: false });
    expect(r.data.data).not.toHaveProperty('patientNotMoved');

    expect(await vagasDe(patientId)).toBe(1);
    expect(await statusDe(patientId)).toBe('ACTIVE');
    expect(await trilhaDoFoguete(patientId)).toBe(0);
  });
});
