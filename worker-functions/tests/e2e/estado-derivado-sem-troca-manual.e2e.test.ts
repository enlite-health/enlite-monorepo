/**
 * Estado derivado sem troca manual (estado-automatico-do-paciente, F5, D6) @integration
 *
 * Os ataques que só fazem sentido DEPOIS de o botão manual sair: ninguém grava Búsqueda, Reemplazo ou Activo à mão, e a origem `kanban` não pede
 * destino nenhum. Pela borda, banco real, sem mock: a prova é o que ficou em `patients.status` e a contagem de `patient_status_history`.
 *
 *  Parte 1 — app REAL com o engine de permissão LIGADO (`subirApp058a`, mesmo harness de `patient-status-trava-alocacao-d489`), para provar que a
 *    CÉLULA não abre nada: o ator tem as 3 células antigas (`move_to_{searching,active,replacement}`, que a F5 tirou do código) concedidas por SQL
 *    e continua recusado.
 *     P1  `PUT /status` com `SEARCHING`, `REPLACEMENT` e `ACTIVE` (origem `admin_panel`) → 422 PATIENT_STATUS_NOT_MANUAL, estado e trilha iguais;
 *     P2  o mesmo com `changeSource: 'kanban'` para QUALQUER destino (os 10 estados);
 *     P3  um ator SÓ com `patient:update` (sem nenhuma das 3 antigas) é recusado do mesmo jeito (a célula é irrelevante);
 *     P4  o que é humano fica: `ON_HOLD` com motivo → 200 (trilha +1, origem admin_panel);
 *     P5  `DISCHARGED → ACTIVE` pelo PUT → 422 NOT_MANUAL, mas a ação `reativar` do MESMO paciente → 200 com estado re-derivado e trilha `resume`.
 *  Parte 2 — API REAL (container, engine desligado):
 *     P6  `PUT /vacancies/:id` com cada estado legado/derivado → 400 (repete A2 da F4);
 *     P7  o foguete continua movendo: Admisión → Búsqueda, trilha `recruitment_activation` (regressão do item 1).
 *
 * Outbound mapeado: só SELECT/INSERT/UPDATE em Postgres; nenhum canal externo é chamado. Fixtures sintéticas (sobrenome " QA"), nenhum texto clínico.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { semearFaixas } from './helpers/seedFaixaDoServico';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';
import { seedPatientStatus } from './helpers/seedPatientStatus';
import type { AppDeFamilia } from './helpers/permissionFamilyHarness';
import { atorComCelulas, chamar, fecharApp058a, limparAtores, subirApp058a, type Celula } from './helpers/contrato058aApp';
import { DATABASE_URL } from './helpers/contrato058aDb';
import { PATIENT_STATUSES } from '../../src/modules/case/domain/enums/PatientStatus';

const TAG = 'estado-derivado-';
const CELULAS_ANTIGAS: Celula[] = [['patient_status', 'move_to_searching'], ['patient_status', 'move_to_active'], ['patient_status', 'move_to_replacement']];
const ATOR_COM_ANTIGAS = { uid: 'qa-f5-com-antigas', nome: 'QA F5 Com Antigas' };
const ATOR_SO_UPDATE = { uid: 'qa-f5-so-update', nome: 'QA F5 So Update' };
const LEGADOS = ['SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'PENDING_ACTIVATION'] as const;
const DERIVADOS = ['SEARCHING', 'REPLACEMENT', 'ACTIVE'] as const;
const HORARIO = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }];

describe('Estado derivado sem troca manual (F5) @integration', () => {
  let pool: Pool;
  let seq = 0;

  const criarPaciente = async (status: string, opts: { servico?: boolean } = {}): Promise<{ patientId: string; serviceId: string | null }> => {
    const patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, insurance_informed)
       VALUES ($1, 'Derivado', 'Sem Troca QA', 'AR', $2, 'Particular') RETURNING id`, [`${TAG}${seq++}`, status],
    )).rows[0].id;
    if (!opts.servico) return { patientId, serviceId: null };
    await seedPatientDiagnosis(pool, patientId);
    const addressId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1, 'Calle Derivado 1', 1) RETURNING id`, [patientId],
    )).rows[0].id;
    const serviceId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services
         (patient_id, service_code, active, country, created_by, updated_by, address_id,
          required_professions, required_sex, required_experience, work_schedule, payment_day)
       VALUES ($1, 'AT', true, 'AR', 'estado-derivado', 'estado-derivado', $2, ARRAY['AT'], 'BOTH', 'EXP-E2E', 'part-time', 'DIA-E2E') RETURNING id`,
      [patientId, addressId],
    )).rows[0].id;
    await semearFaixas(pool, serviceId, HORARIO, 'estado-derivado');
    return { patientId, serviceId };
  };
  const estado = async (id: string): Promise<{ status: string; trilha: number }> => (await pool.query(
    `SELECT (SELECT status FROM patients WHERE id = $1) AS status,
            (SELECT count(*)::int FROM patient_status_history WHERE patient_id = $1) AS trilha`, [id])).rows[0];
  const ultimaOrigem = async (id: string): Promise<string | null> => (await pool.query<{ s: string | null }>(
    `SELECT change_source AS s FROM patient_status_history WHERE patient_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [id])).rows[0]?.s ?? null;

  async function limpar(): Promise<void> {
    const pats = `SELECT id FROM patients WHERE clickup_task_id LIKE $1`;
    const arg = [`${TAG}%`];
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id IN (${pats}))`, arg);
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id IN (${pats}))`, arg);
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, arg);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });
  afterAll(async () => { await limpar(); await pool.end(); });

  describe('Parte 1 — engine de permissão LIGADO: a célula não abre nada', () => {
    let app: AppDeFamilia;
    const put = (id: string, uid: string, body: Record<string, unknown>) => chamar(app, 'PUT', `/api/admin/patients/${id}/status`, uid, body);

    const removerAntigasDoCatalogo = async (): Promise<void> => {
      await pool.query(`DELETE FROM iam.permissions WHERE resource = 'patient_status' AND action = ANY($1)`, [CELULAS_ANTIGAS.map(([, a]) => a)]); // fixture local; CASCADE limpa a concessão
    };

    beforeAll(async () => {
      await limparAtores(pool, [ATOR_COM_ANTIGAS, ATOR_SO_UPDATE]);
      await removerAntigasDoCatalogo();
      // As 3 antigas entram no catálogo do banco de teste por SQL (é o que um banco ainda não sincronizado tem): concedidas, e mesmo assim nada abrem.
      await atorComCelulas(pool, ATOR_COM_ANTIGAS.uid, ATOR_COM_ANTIGAS.nome, [['patient', 'update'], ['patient', 'read'], ...CELULAS_ANTIGAS]);
      await atorComCelulas(pool, ATOR_SO_UPDATE.uid, ATOR_SO_UPDATE.nome, [['patient', 'update'], ['patient', 'read']]);
      app = await subirApp058a(DATABASE_URL);
    }, 60000);
    afterAll(async () => {
      await limparAtores(pool, [ATOR_COM_ANTIGAS, ATOR_SO_UPDATE]);
      await removerAntigasDoCatalogo(); // devolve o banco de teste ao catálogo de hoje (a A9 de `patient-status-fora-do-fluxo-051` exige as 3 ausentes)
      await fecharApp058a(app);
    });

    it.each(DERIVADOS)('P1. admin_panel pede %s com as 3 células antigas concedidas → 422 PATIENT_STATUS_NOT_MANUAL; estado e trilha iguais', async (destino) => {
      const { patientId } = await criarPaciente('ON_HOLD');
      const antes = await estado(patientId);
      const r = await put(patientId, ATOR_COM_ANTIGAS.uid, { status: destino });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PATIENT_STATUS_NOT_MANUAL');
      expect(r.body.details).toEqual({ to: destino, changeSource: 'admin_panel' });
      expect(await estado(patientId)).toEqual(antes);
    });

    it.each([...PATIENT_STATUSES])('P2. changeSource kanban pede %s → 422 PATIENT_STATUS_NOT_MANUAL; estado e trilha iguais', async (destino) => {
      const { patientId } = await criarPaciente('ON_HOLD');
      const antes = await estado(patientId);
      const r = await put(patientId, ATOR_COM_ANTIGAS.uid, { status: destino, changeSource: 'kanban', onHoldReason: 'SCHOOL' });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('PATIENT_STATUS_NOT_MANUAL');
      expect(await estado(patientId)).toEqual(antes);
    });

    it('P3. ator SÓ com patient:update (sem as antigas) é recusado do mesmo jeito: a célula é irrelevante', async () => {
      const { patientId } = await criarPaciente('SUSPENDED');
      const antes = await estado(patientId);
      for (const destino of DERIVADOS) {
        const r = await put(patientId, ATOR_SO_UPDATE.uid, { status: destino, suspensionExitReason: 'OTHER' });
        expect(r.status).toBe(422);
        expect(r.body.code).toBe('PATIENT_STATUS_NOT_MANUAL');
      }
      expect(await estado(patientId)).toEqual(antes);
    });

    it('P4. o que é humano fica: ON_HOLD com motivo → 200, trilha +1 com origem admin_panel (controle positivo: o mesmo ator, o mesmo paciente)', async () => {
      const { patientId } = await criarPaciente('ACTIVE');
      const antes = await estado(patientId);
      const r = await put(patientId, ATOR_COM_ANTIGAS.uid, { status: 'ON_HOLD', onHoldReason: 'INSURER' });
      expect(r.status).toBe(200);
      expect(await estado(patientId)).toEqual({ status: 'ON_HOLD', trilha: antes.trilha + 1 });
      expect(await ultimaOrigem(patientId)).toBe('admin_panel');
    });

    it('P5. DISCHARGED → ACTIVE pelo PUT (admin_panel) → 422 NOT_MANUAL; a ação reativar do mesmo paciente → 200, estado re-derivado, trilha resume', async () => {
      const { patientId } = await criarPaciente('ACTIVE');
      await seedPatientStatus(pool, patientId, 'DISCHARGED'); // baja montada por SQL (a F5 tirou o caminho manual)
      const antes = await estado(patientId);
      expect(antes.status).toBe('DISCHARGED');

      const manual = await put(patientId, ATOR_COM_ANTIGAS.uid, { status: 'ACTIVE' });
      expect(manual.status).toBe(422);
      expect(manual.body.code).toBe('PATIENT_STATUS_NOT_MANUAL');
      expect(await estado(patientId)).toEqual(antes);

      const reativar = await chamar(app, 'POST', `/api/admin/patients/${patientId}/status-actions`, ATOR_COM_ANTIGAS.uid, { action: 'reativar' });
      expect(reativar.status).toBe(200);
      const depois = await estado(patientId);
      expect(depois.status).toBe('SEARCHING'); // sem itinerário montado a regra de horas não decide → Búsqueda
      expect(depois.trilha).toBe(antes.trilha + 1);
      expect(await ultimaOrigem(patientId)).toBe('resume');
    });
  });

  describe('Parte 2 — API real, engine desligado', () => {
    const api = createApiClient();
    let asAdmin: StaffAuth;
    beforeAll(async () => {
      await waitForBackend(api);
      asAdmin = await staffAuth('estado-derivado-admin-uid', 'admin');
    });

    const foguete = (patientId: string, serviceId: string) =>
      api.post(`/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, {}, asAdmin);

    it('P7. o foguete continua movendo: Admisión → Búsqueda, trilha recruitment_activation, 1 vaga (regressão do item 1)', async () => {
      const { patientId, serviceId } = await criarPaciente('ADMISSION', { servico: true });
      const antes = await estado(patientId);
      const r = await foguete(patientId, serviceId as string);
      expect(r.status).toBe(201);
      expect(await estado(patientId)).toEqual({ status: 'SEARCHING', trilha: antes.trilha + 1 });
      expect(await ultimaOrigem(patientId)).toBe('recruitment_activation');
      expect(Number((await pool.query('SELECT count(*) AS n FROM job_postings WHERE patient_id = $1', [patientId])).rows[0].n)).toBe(1);
    });

    it.each(LEGADOS)('P6. PUT /vacancies/:id com o estado %s → 400 VACANCY_STATUS_NOT_WRITABLE; vaga e paciente intactos (repete A2)', async (legado) => {
      const { patientId, serviceId } = await criarPaciente('ADMISSION', { servico: true });
      const f = await foguete(patientId, serviceId as string);
      expect(f.status).toBe(201);
      const vacancyId = f.data.data.vacancyId as string;
      const vagaAntes = (await pool.query<{ status: string }>('SELECT status FROM job_postings WHERE id = $1', [vacancyId])).rows[0].status;
      const antes = await estado(patientId);

      const r = await api.put(`/api/admin/vacancies/${vacancyId}`, { status: legado }, asAdmin);
      expect(r.status).toBe(400);
      expect(r.data.code).toBe('VACANCY_STATUS_NOT_WRITABLE');
      expect((await pool.query<{ status: string }>('SELECT status FROM job_postings WHERE id = $1', [vacancyId])).rows[0].status).toBe(vagaAntes);
      expect(await estado(patientId)).toEqual(antes);
    });
  });
});
