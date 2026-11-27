/**
 * Ataques ao fluxo automático do estado do paciente, com o botão manual AINDA presente (estado-automatico-do-paciente, F4, D807 item 2) @integration
 *
 * Pela borda, com banco real e sem mock: API REAL (container) + Postgres. A prova é o que ficou no banco (`patients.status`, a trilha
 * `patient_status_history`, as vagas), nunca só o código HTTP. Um `it` por ataque do `a-testar/2026-11-25-remover-botao-manual-de-status.md`:
 *   A1  foguete em serviço INCOMPLETO (sem horário; sem diagnóstico) → 422 PATIENT_NOT_READY, 0 vaga nova, paciente e trilha intactos;
 *   A2  `PUT /vacancies/:id` com cada um dos 4 valores de estado derivado (SEARCHING_REPLACEMENT, RAPID_RESPONSE, ACTIVE, PENDING_ACTIVATION)
 *       → 400 VACANCY_STATUS_NOT_WRITABLE, vaga e paciente intactos (4 casos);
 *   A3  envio à Talentum (STUB) com o paciente devolvido ao funil por SQL → o estado continua no funil (o lançamento não move) — com controle
 *       positivo: o stub RECEBEU o projeto;
 *   A4  `PUT /vacancies/:id` com campos do ciclo de vida (título, `ON_HOLD`, de volta a `SEARCHING`) → 200 e `patients.status` + trilha do
 *       paciente com a MESMA contagem;
 *   A5  a derivação não toca estado humano: paciente `ON_HOLD` com o itinerário quase cheio, evento de alocação → continua `ON_HOLD`
 *       (controle positivo: o MESMO evento num paciente `SEARCHING` deriva para `ACTIVE` e grava 1 linha `system`);
 *   A6  ação humana com alocação viva → 422 PATIENT_STATUS_LOCKED_BY_ALLOCATION (pausar, suspender, dar alta, dar baja; retomar de `ON_HOLD`).
 *  A7  item 19: S1 completo e coberto + S2 ATIVO e INCOMPLETO (sem endereço, sem horário) SEM vaga viva → a derivação pela alocação sai de Búsqueda
 *       (REPLACEMENT com metade coberta, ACTIVE com tudo coberto, 1 linha `system` cada); o S2 sem vaga viva não entra na completude.
 * Os ataques que só fazem sentido SEM o botão (PUT/arrasto direto do estado derivado) são da F5 (D6).
 *
 * Outbound mapeado: foguete, vagas, ações de estado e alocação só fazem SELECT/INSERT/UPDATE em Postgres. O único caminho que sai do processo é
 * o envio à Talentum (A3) e ele vai ao STUB local (`TalentumV2Stub`, porta 9914 = a que o `docker-compose.test.yml` entrega ao container); Twilio,
 * WhatsApp, Ana Care, Google e Short.io nunca são chamados. Fixtures sintéticas (sobrenome " QA"), nenhum texto clínico.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { semearFaixas } from './helpers/seedFaixaDoServico';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';
import { TalentumV2Stub } from '../../src/modules/integration/infrastructure/__tests__/talentumV2Stub';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const TAG = 'estado-auto-ataques-';
const HORARIO = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }];
const STUB_PORT = Number(process.env.TALENTUM_STUB_PORT ?? 9914);
const LEGADOS = ['SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'ACTIVE', 'PENDING_ACTIVATION'] as const;

describe('Ataques ao fluxo automático do estado do paciente (D807) @integration', () => {
  const api = createApiClient();
  const stub = new TalentumV2Stub();
  let closeStub: () => Promise<void>;
  let pool: Pool;
  let asAdmin: StaffAuth;
  let seq = 0;

  async function limpar(): Promise<void> {
    const pats = `SELECT id FROM patients WHERE clickup_task_id LIKE $1`;
    const arg = [`${TAG}%`];
    await pool.query(
      `DELETE FROM patient_itinerary_assignment WHERE slot_id IN (
         SELECT s.id FROM patient_itinerary_slot s JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id WHERE pcs.patient_id IN (${pats}))`, arg);
    await pool.query(`DELETE FROM patient_itinerary_assembly WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id IN (${pats}))`, arg);
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, arg);
    await pool.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT id FROM patient_contracted_services WHERE patient_id IN (${pats}))`, arg);
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (${pats})`, arg);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, arg);
  }

  /** Paciente com endereço e N serviços ativos criados por SQL (com ou sem horário), com diagnóstico (as outras travas do gate passam). */
  async function criarPaciente(
    tag: string, status: string, servicos: Array<{ comHorario: boolean }>, opts: { comDiagnostico?: boolean } = {},
  ): Promise<{ patientId: string; serviceIds: string[] }> {
    const patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, insurance_informed)
       VALUES ($1, 'Ataque', 'Estado QA', 'AR', $2, 'Particular') RETURNING id`,
      [`${TAG}${tag}-${seq++}`, status],
    )).rows[0].id;
    if (opts.comDiagnostico !== false) await seedPatientDiagnosis(pool, patientId);
    const addressId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1, 'Calle Ataque 1', 1) RETURNING id`, [patientId],
    )).rows[0].id;
    const serviceIds: string[] = [];
    for (const s of servicos) {
      const sid = (await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services
           (patient_id, service_code, active, country, created_by, updated_by, address_id,
            required_professions, required_sex, required_experience, work_schedule, payment_day)
         VALUES ($1, 'AT', true, 'AR', 'estado-auto-ataques', 'estado-auto-ataques', $2, ARRAY['AT'], 'BOTH', 'EXP-E2E', 'part-time', 'DIA-E2E')
         RETURNING id`, [patientId, addressId],
      )).rows[0].id;
      await semearFaixas(pool, sid, s.comHorario ? HORARIO : [], 'estado-auto-ataques');
      serviceIds.push(sid);
    }
    return { patientId, serviceIds };
  }

  const foguete = (patientId: string, serviceId: string) =>
    api.post(`/api/admin/patients/${patientId}/contracted-services/${serviceId}/activate-recruitment`, {}, asAdmin);
  const statusDe = async (id: string): Promise<string> =>
    (await pool.query<{ status: string }>('SELECT status FROM patients WHERE id = $1', [id])).rows[0].status;
  const trilha = async (id: string, fonte?: string): Promise<number> =>
    Number((await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM patient_status_history WHERE patient_id = $1 AND ($2::text IS NULL OR change_source = $2)`, [id, fonte ?? null],
    )).rows[0].n);
  const vagasDe = async (id: string): Promise<number> =>
    Number((await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [id])).rows[0].n);
  const statusDaVaga = async (id: string): Promise<string> =>
    (await pool.query<{ status: string }>('SELECT status FROM job_postings WHERE id = $1', [id])).rows[0].status;

  /** Paciente SEARCHING que acabou de passar pelo foguete: devolve ids e a vaga rascunho nascida dele. */
  async function pacienteComVaga(tag: string): Promise<{ patientId: string; serviceId: string; vacancyId: string }> {
    const { patientId, serviceIds } = await criarPaciente(tag, 'ADMISSION', [{ comHorario: true }]);
    const r = await foguete(patientId, serviceIds[0]);
    expect(r.status).toBe(201);
    return { patientId, serviceId: serviceIds[0], vacancyId: r.data.data.vacancyId as string };
  }

  /**
   * Paciente com serviço (criado pela API, 2 faixas), vaga, itinerário MONTADO e `preAlocadas` faixas cobertas por SQL por um worker A; devolve
   * o 2º worker (B, em Selecionado) e a faixa livre para o evento de alocação feito pela API.
   */
  async function cenarioDeItinerario(tag: string, status: string, preAlocadas: number): Promise<{
    patientId: string; serviceId: string; slots: string[]; workerB: string;
  }> {
    const base = `${TAG}${tag}-${seq++}`;
    const patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, has_consent, insurance_informed)
       VALUES ($1, 'Ataque', 'Itinerario QA', 'AR', $2, true, 'OSDE') RETURNING id`, [base, status],
    )).rows[0].id;
    const addressId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, country, lat, lng) VALUES ($1, 'AR', -34.6, -58.4) RETURNING id`, [patientId],
    )).rows[0].id;
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }, { dayOfWeek: 2, startTime: '08:00', durationMinutes: 240 }] },
      asAdmin,
    );
    expect(created.status).toBe(201);
    const serviceId = created.data.data.id as string;
    const slots = (await pool.query<{ id: string }>(
      `SELECT id FROM patient_itinerary_slot WHERE contracted_service_id = $1 ORDER BY weekday`, [serviceId],
    )).rows.map((r) => r.id);
    expect(slots).toHaveLength(2);
    const jobId = (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`, [`${base}-vaga`, serviceId, patientId],
    )).rows[0].id;
    const mkWorker = async (sufixo: string): Promise<{ workerId: string; applicationId: string }> => {
      const workerId = (await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country, status, occupation) VALUES ($1, $2, 'AR', 'REGISTERED', 'AT') RETURNING id`,
        [`${base}-${sufixo}`, `${base}-${sufixo}@e2e.local`],
      )).rows[0].id;
      const applicationId = (await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'manual') RETURNING id`,
        [workerId, jobId],
      )).rows[0].id;
      return { workerId, applicationId };
    };
    await pool.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, $2, 'AR')`, [patientId, TAG]);
    if (preAlocadas > 0) {
      const a = await mkWorker('wa');
      const inicio = (await pool.query<{ d: string }>(
        `SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 7, 'YYYY-MM-DD') AS d`)).rows[0].d;
      for (const slotId of slots.slice(0, preAlocadas)) {
        await pool.query(
          `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
           VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)`, [slotId, a.workerId, a.applicationId, inicio, TAG],
        );
      }
    }
    const b = await mkWorker('wb');
    return { patientId, serviceId, slots, workerB: b.workerId };
  }

  const alocar = (c: { patientId: string; serviceId: string }, slotId: string, workerId: string) =>
    api.post(`/api/admin/patients/${c.patientId}/contracted-services/${c.serviceId}/itinerary/slots/${slotId}/allocations`, { workerId }, asAdmin);
  const acao = (patientId: string, corpo: Record<string, unknown>) =>
    api.post(`/api/admin/patients/${patientId}/status-actions`, corpo, asAdmin);

  beforeAll(async () => {
    closeStub = (await stub.serve(STUB_PORT)).close;
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    asAdmin = await staffAuth('estado-auto-ataques-admin', 'admin');
    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role) VALUES ($1, $2, $3, 'admin') ON CONFLICT (firebase_uid) DO NOTHING`,
      [asAdmin.uid, 'estado-auto-ataques-admin@e2e.local', 'Estado Auto Ataques Admin'],
    );
    await limpar();
  }, 60000);

  afterAll(async () => {
    await limpar();
    // O admin inserido no beforeAll não pode sobrar: staff ACTIVE sem grupo reprova a pré-condição de `iam-config-export-import` (F12) quando esta suíte roda antes dela.
    await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [asAdmin.uid]);
    await pool.end();
    if (closeStub) await closeStub();
  });

  it('A1: foguete em serviço INCOMPLETO (sem horário; sem diagnóstico) → 422 PATIENT_NOT_READY, 0 vaga nova, paciente e trilha intactos', async () => {
    const semHorario = await criarPaciente('a1-horario', 'ADMISSION', [{ comHorario: true }, { comHorario: false }]);
    const r1 = await foguete(semHorario.patientId, semHorario.serviceIds[1]);
    expect(r1.status).toBe(422);
    expect(r1.data.code).toBe('PATIENT_NOT_READY');
    expect(r1.data.details.missing).toContain('SERVICE_SCHEDULE');
    expect(await vagasDe(semHorario.patientId)).toBe(0);
    expect(await statusDe(semHorario.patientId)).toBe('ADMISSION');
    expect(await trilha(semHorario.patientId, 'recruitment_activation')).toBe(0);

    const semDiagnostico = await criarPaciente('a1-diagnostico', 'ADMISSION', [{ comHorario: true }], { comDiagnostico: false });
    const trilhaAntes = await trilha(semDiagnostico.patientId);
    const r2 = await foguete(semDiagnostico.patientId, semDiagnostico.serviceIds[0]);
    expect(r2.status).toBe(422);
    expect(r2.data.code).toBe('PATIENT_NOT_READY');
    expect(await vagasDe(semDiagnostico.patientId)).toBe(0);
    expect(await statusDe(semDiagnostico.patientId)).toBe('ADMISSION');
    expect(await trilha(semDiagnostico.patientId)).toBe(trilhaAntes);

    // controle positivo do MESMO ator/rota: o serviço completo do 1º paciente passa (o 422 acima é o gate, não a rota)
    const ok = await foguete(semHorario.patientId, semHorario.serviceIds[0]);
    expect(ok.status).toBe(201);
    expect(await statusDe(semHorario.patientId)).toBe('SEARCHING');
  });

  describe.each(LEGADOS)('A2: PUT /vacancies/:id com status derivado %s', (legado) => {
    it('→ 400 VACANCY_STATUS_NOT_WRITABLE; vaga e paciente intactos, trilha do paciente sem linha nova', async () => {
      const { patientId, vacancyId } = await pacienteComVaga(`a2-${legado.toLowerCase()}`);
      const vagaAntes = await statusDaVaga(vacancyId);
      const trilhaAntes = await trilha(patientId);
      expect(await statusDe(patientId)).toBe('SEARCHING');

      const r = await api.put(`/api/admin/vacancies/${vacancyId}`, { status: legado }, asAdmin);
      expect(r.status).toBe(400);
      expect(r.data.code).toBe('VACANCY_STATUS_NOT_WRITABLE');
      expect(await statusDaVaga(vacancyId)).toBe(vagaAntes);
      expect(await statusDe(patientId)).toBe('SEARCHING');
      expect(await trilha(patientId)).toBe(trilhaAntes);
    });
  });

  it('A3: envio à Talentum (STUB) com o paciente devolvido ao funil (ADMISSION) ou a Activo por SQL → o estado não muda; nenhuma linha vacancy_launch', async () => {
    for (const estado of ['ADMISSION', 'ACTIVE']) {
      const { patientId, vacancyId } = await pacienteComVaga(`a3-${estado.toLowerCase()}`);
      // fixture: devolve o paciente ao estado (a trilha ganha 1 linha sem change_source) e prepara o envio (pergunta + descrição prontas)
      await pool.query(`UPDATE patients SET status = $2 WHERE id = $1`, [patientId, estado]);
      await pool.query(
        `INSERT INTO job_posting_prescreening_questions (job_posting_id, question_order, question, desired_response, weight) VALUES ($1, 1, '¿Tiene experiencia?', 'Sí', 5)`,
        [vacancyId],
      );
      await pool.query(`UPDATE job_postings SET talentum_description = 'Descripción de prueba' WHERE id = $1`, [vacancyId]);
      const trilhaAntes = await trilha(patientId);
      const projetosAntes = stub.projects.size;

      const pub = await api.post(`/api/admin/vacancies/${vacancyId}/publish-talentum`, {}, asAdmin);
      expect(pub.status).toBe(200);
      // controle positivo: o envio ACONTECEU (o stub recebeu o projeto e a vaga guardou o vínculo) — senão "não moveu" seria vazio
      expect(stub.projects.size).toBe(projetosAntes + 1);
      const { rows: [vaga] } = await pool.query<{ talentum_project_id: string | null }>('SELECT talentum_project_id FROM job_postings WHERE id = $1', [vacancyId]);
      expect(vaga.talentum_project_id).toMatch(/^stub-proj-\d+$/);

      expect(await statusDe(patientId)).toBe(estado);
      expect(await trilha(patientId)).toBe(trilhaAntes);
      expect(await trilha(patientId, 'vacancy_launch')).toBe(0);
    }
  });

  it('A4: PUT /vacancies/:id — o título passa (200); ON_HOLD e SEARCHING dão 400 (F4: ninguém grava status); patients.status, trilha e vaga com a MESMA contagem', async () => {
    const { patientId, vacancyId } = await pacienteComVaga('a4');
    const trilhaAntes = await trilha(patientId);
    expect(await statusDe(patientId)).toBe('SEARCHING');
    const vagaAntes = await statusDaVaga(vacancyId);

    for (const [corpo, esperado] of [[{ title: `${TAG}a4 titulo novo` }, 200], [{ status: 'ON_HOLD' }, 400], [{ status: 'SEARCHING' }, 400]] as const) {
      const r = await api.put(`/api/admin/vacancies/${vacancyId}`, corpo, asAdmin);
      expect({ corpo, status: r.status }).toEqual({ corpo, status: esperado }); // controle: o ator e a rota funcionam (o título passa), então "intacto" abaixo é medida
      expect(await statusDe(patientId)).toBe('SEARCHING');
      expect(await trilha(patientId)).toBe(trilhaAntes);
    }
    expect(await statusDaVaga(vacancyId)).toBe(vagaAntes); // nem a vaga se move mais: o estado dela não é editável
  });

  it('A5: a derivação não toca estado humano — ON_HOLD com o itinerário quase cheio + evento de alocação continua ON_HOLD (controle: SEARCHING deriva ACTIVE)', async () => {
    const pausado = await cenarioDeItinerario('a5-pausado', 'ON_HOLD', 1);
    const trilhaAntes = await trilha(pausado.patientId);
    const r = await alocar(pausado, pausado.slots[1], pausado.workerB);
    expect(r.status).toBe(201); // o itinerário ACEITA alocar com o paciente pausado (o evento aconteceu)
    expect((await pool.query(`SELECT 1 FROM patient_itinerary_assignment WHERE slot_id = $1 AND status = 'ACTIVE'`, [pausado.slots[1]])).rowCount).toBe(1);
    expect(await statusDe(pausado.patientId)).toBe('ON_HOLD');
    expect(await trilha(pausado.patientId)).toBe(trilhaAntes);
    expect(await trilha(pausado.patientId, 'system')).toBe(0);

    // controle positivo: o MESMO evento, sem o estado humano, deriva (as 2 faixas cobertas → ACTIVE) e grava a linha `system`
    const livre = await cenarioDeItinerario('a5-livre', 'SEARCHING', 1);
    const rc = await alocar(livre, livre.slots[1], livre.workerB);
    expect(rc.status).toBe(201);
    expect(await statusDe(livre.patientId)).toBe('ACTIVE');
    expect(await trilha(livre.patientId, 'system')).toBe(1);
  });

  it('A6: ação humana com alocação viva → 422 PATIENT_STATUS_LOCKED_BY_ALLOCATION (4 ações do painel e retomar); nada muda', async () => {
    const ativo = await cenarioDeItinerario('a6-ativo', 'ACTIVE', 2); // as 2 faixas cobertas por SQL: alocação viva
    const antes = { status: await statusDe(ativo.patientId), trilha: await trilha(ativo.patientId) };
    for (const corpo of [{ action: 'pausar', onHoldReason: 'SCHOOL' }, { action: 'suspender' }, { action: 'dar_alta' }, { action: 'dar_baja' }]) {
      const r = await acao(ativo.patientId, corpo);
      expect({ acao: corpo.action, status: r.status, code: r.data.code }).toEqual({ acao: corpo.action, status: 422, code: 'PATIENT_STATUS_LOCKED_BY_ALLOCATION' });
      expect(await statusDe(ativo.patientId)).toBe(antes.status);
      expect(await trilha(ativo.patientId)).toBe(antes.trilha);
    }

    const pausado = await cenarioDeItinerario('a6-pausado', 'ON_HOLD', 2);
    const rr = await acao(pausado.patientId, { action: 'retomar' });
    expect(rr.status).toBe(422);
    expect(rr.data.code).toBe('PATIENT_STATUS_LOCKED_BY_ALLOCATION');
    expect(await statusDe(pausado.patientId)).toBe('ON_HOLD');

    // controle positivo: a MESMA ação, sem alocação viva, é aceita (o 422 acima é a trava, não a rota)
    const sem = await cenarioDeItinerario('a6-sem', 'ACTIVE', 0);
    const ok = await acao(sem.patientId, { action: 'pausar', onHoldReason: 'SCHOOL' });
    expect(ok.status).toBe(200);
    expect(await statusDe(sem.patientId)).toBe('ON_HOLD');
  });

  it.each([
    { cobertas: 'metade das faixas', preAlocadas: 0, esperado: 'REPLACEMENT' },
    { cobertas: 'todas as faixas', preAlocadas: 1, esperado: 'ACTIVE' },
  ])('A7 (item 19): S1 completo ($cobertas cobertas) + S2 ativo e incompleto sem vaga viva → a derivação leva SEARCHING a $esperado', async ({ preAlocadas, esperado }) => {
    const c = await cenarioDeItinerario(`a7-${esperado.toLowerCase()}`, 'SEARCHING', preAlocadas);
    // S2: ativo, SEM endereço e SEM faixa (SERVICE_ADDRESS e SERVICE_SCHEDULE faltando), SEM vaga (job_postings) = sem vaga viva.
    const s2 = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
       VALUES ($1, 'AT', true, 'AR', 'estado-auto-ataques', 'estado-auto-ataques') RETURNING id`, [c.patientId],
    )).rows[0].id;
    // controle de premissa: o S2 está ativo e não tem vaga viva; o S1 tem
    expect((await pool.query(`SELECT 1 FROM patient_contracted_services WHERE id = $1 AND active`, [s2])).rowCount).toBe(1);
    expect((await pool.query(`SELECT 1 FROM job_postings WHERE contracted_service_id = $1 AND deleted_at IS NULL`, [s2])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM job_postings WHERE contracted_service_id = $1 AND deleted_at IS NULL`, [c.serviceId])).rowCount).toBe(1);

    const r = await alocar(c, c.slots[preAlocadas], c.workerB);
    expect(r.status).toBe(201);
    expect(await statusDe(c.patientId)).toBe(esperado);
    expect(await trilha(c.patientId, 'system')).toBe(1);
  });
});
