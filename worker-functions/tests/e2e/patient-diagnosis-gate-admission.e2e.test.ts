/**
 * patient-diagnosis-gate-admission.e2e.test.ts @integration — diagnóstico CID-11 obrigatório na ENTRADA em
 * atendimento, vindo de qualquer estágio pré-atendimento (SOLICITANTE, PENDING_ADMISSION, ADMISSION) —
 * pedido do Javier / decisão do Gabriel.
 *
 * API real (Docker, USE_MOCK_AUTH) + Postgres real. O paciente continua nascendo sem diagnóstico; o que
 * esta suíte prova é a trava no SERVIDOR (o front só apresenta):
 *   1. GET /patients/:id → `completeness.missing` traz DIAGNOSIS em estágio pré-atendimento sem diagnóstico ATIVO;
 *   2. PUT /status ADMISSION → SEARCHING sem diagnóstico → 422 PATIENT_STATUS_NOT_READY com DIAGNOSIS;
 *      diagnóstico só INATIVO continua barrando; ALTA (descarte) e andar entre os estágios pré-atendimento NÃO exigem;
 *      o desvio em dois passos (ADMISSION → PENDING_ADMISSION livre, PENDING_ADMISSION → SEARCHING barrado);
 *   3. um diagnóstico ATIVO de QUALQUER source (PANEL, CLICKUP, BACKFILL) libera;
 *   4. activate-recruitment com o paciente pré-atendimento sem diagnóstico → 422 PATIENT_NOT_READY com DIAGNOSIS, e SEM vaga;
 *   5. paciente JÁ em atendimento (SEARCHING → ACTIVE) sem diagnóstico NÃO é afetado.
 * O valor do diagnóstico nunca entra no corpo de nenhuma resposta (só o código DIAGNOSIS).
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth, type StaffAuth } from './helpers/staffAuth';
import { semearFaixas } from './helpers/seedFaixaDoServico';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const UID = 'diag-gate-admin-uid';
const TAG = 'diag-gate-e2e-';

describe('Diagnóstico obrigatório na saída da ADMISSION @integration', () => {
  const api = createApiClient();
  let asAdmin: StaffAuth;
  let pool: Pool;
  let seq = 0;

  async function paciente(status: string, comServico = false): Promise<{ id: string; sid: string | null }> {
    seq += 1;
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, insurance_informed)
       VALUES ($1, 'Diag', 'Gate', 'AR', $2, 'Particular') RETURNING id`,
      [`${TAG}${seq}`, status],
    )).rows[0].id;
    if (!comServico) return { id, sid: null };
    const addr = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_formatted, display_order) VALUES ($1,'Calle Diag 1',1) RETURNING id`,
      [id],
    )).rows[0].id;
    const sid = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services
         (patient_id, service_code, active, country, created_by, updated_by, address_id,
          required_professions, required_sex, required_experience, work_schedule, payment_day)
       VALUES ($1,'AT',true,'AR','diag-gate','diag-gate',$2, ARRAY['AT'],'BOTH','EXP-E2E','part-time','DIA-E2E') RETURNING id`,
      [id, addr],
    )).rows[0].id;
    await semearFaixas(pool, sid, [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }], 'diag-gate');
    return { id, sid };
  }
  const put = (id: string, body: Record<string, unknown>) => api.put(`/api/admin/patients/${id}/status`, body, asAdmin);
  const statusOf = async (id: string) => (await pool.query(`SELECT status FROM patients WHERE id = $1`, [id])).rows[0].status as string;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(UID, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });
  async function limpar(): Promise<void> {
    const ids = (await pool.query<{ id: string }>(`SELECT id FROM patients WHERE clickup_task_id LIKE $1`, [`${TAG}%`])).rows.map((r) => r.id);
    await pool.query(`DELETE FROM job_postings WHERE patient_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM patient_status_history WHERE patient_id = ANY($1)`, [ids]);
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [ids]); // diagnósticos/serviços/endereços caem em cascata
  }
  afterAll(async () => { await limpar(); await pool.end(); });

  it('1. GET /:id em ADMISSION sem diagnóstico ATIVO → completeness.missing traz DIAGNOSIS; com diagnóstico, some', async () => {
    const { id } = await paciente('ADMISSION');
    let c = (await api.get(`/api/admin/patients/${id}`, asAdmin)).data.data.completeness;
    expect(c.missing).toContain('DIAGNOSIS');
    await seedPatientDiagnosis(pool, id);
    c = (await api.get(`/api/admin/patients/${id}`, asAdmin)).data.data.completeness;
    expect(c.missing).not.toContain('DIAGNOSIS');
  });

  it('2. ADMISSION → SEARCHING sem diagnóstico: 422 com DIAGNOSIS, status intacto; só diagnóstico INATIVO continua barrando', async () => {
    const { id } = await paciente('ADMISSION');
    let r = await put(id, { status: 'SEARCHING', changeSource: 'kanban' });
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ code: 'PATIENT_STATUS_NOT_READY', details: { to: 'SEARCHING', missing: ['DIAGNOSIS'] } });
    expect(await statusOf(id)).toBe('ADMISSION');

    await seedPatientDiagnosis(pool, id, { active: false });
    r = await put(id, { status: 'SEARCHING', changeSource: 'kanban' });
    expect(r.status).toBe(422);
    expect(r.data.details.missing).toEqual(['DIAGNOSIS']);
    expect(await statusOf(id)).toBe('ADMISSION');
  });

  it.each(['PANEL', 'CLICKUP', 'BACKFILL'] as const)('3. diagnóstico ATIVO de source %s libera a saída de ADMISSION', async (source) => {
    const { id } = await paciente('ADMISSION');
    await seedPatientDiagnosis(pool, id, { source });
    const r = await put(id, { status: 'SEARCHING', changeSource: 'kanban' });
    expect(r.status).toBe(200);
    expect(await statusOf(id)).toBe('SEARCHING');
  });

  it('4. ALTA (descarte) a partir de ADMISSION NÃO exige diagnóstico', async () => {
    const { id } = await paciente('ADMISSION');
    const r = await put(id, { status: 'ALTA', changeSource: 'admin_panel' });
    expect(r.status).toBe(200);
    expect(await statusOf(id)).toBe('ALTA');
  });

  it.each(['PENDING_ADMISSION', 'SOLICITANTE'])('4b. ADMISSION → %s (volta/movimento no funil) sem diagnóstico → 200', async (to) => {
    const { id } = await paciente('ADMISSION');
    const r = await put(id, { status: to, changeSource: 'kanban' });
    expect(r.status).toBe(200);
    expect(await statusOf(id)).toBe(to);
  });

  it('5. activate-recruitment em ADMISSION sem diagnóstico: 422 PATIENT_NOT_READY com DIAGNOSIS e NENHUMA vaga; com diagnóstico, 201', async () => {
    const { id, sid } = await paciente('ADMISSION', true);
    const url = `/api/admin/patients/${id}/contracted-services/${sid}/activate-recruitment`;
    let r = await api.post(url, {}, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ code: 'PATIENT_NOT_READY', details: { missing: ['DIAGNOSIS'] } });
    expect((await pool.query(`SELECT 1 FROM job_postings WHERE patient_id = $1`, [id])).rowCount).toBe(0);
    expect(await statusOf(id)).toBe('ADMISSION');

    await seedPatientDiagnosis(pool, id);
    r = await api.post(url, {}, asAdmin);
    expect(r.status).toBe(201);
  });

  it('6. o desvio em dois passos está fechado: ADMISSION → PENDING_ADMISSION dá 200, mas PENDING_ADMISSION → SEARCHING sem diagnóstico dá 422', async () => {
    const { id } = await paciente('ADMISSION');
    let r = await put(id, { status: 'PENDING_ADMISSION', changeSource: 'kanban' });
    expect(r.status).toBe(200);
    r = await put(id, { status: 'SEARCHING', changeSource: 'kanban' });
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ code: 'PATIENT_STATUS_NOT_READY', details: { to: 'SEARCHING', missing: ['DIAGNOSIS'] } });
    expect(await statusOf(id)).toBe('PENDING_ADMISSION');
  });

  it('6b. SOLICITANTE → SEARCHING sem diagnóstico: 422; com diagnóstico, 200', async () => {
    const { id } = await paciente('SOLICITANTE');
    let r = await put(id, { status: 'SEARCHING', changeSource: 'kanban' });
    expect(r.status).toBe(422);
    expect(r.data.details.missing).toEqual(['DIAGNOSIS']);
    await seedPatientDiagnosis(pool, id);
    r = await put(id, { status: 'SEARCHING', changeSource: 'kanban' });
    expect(r.status).toBe(200);
  });

  it('6c. activate-recruitment com o paciente em PENDING_ADMISSION sem diagnóstico: 422 e nenhuma vaga; com diagnóstico, 201', async () => {
    const { id, sid } = await paciente('PENDING_ADMISSION', true);
    const url = `/api/admin/patients/${id}/contracted-services/${sid}/activate-recruitment`;
    let r = await api.post(url, {}, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ code: 'PATIENT_NOT_READY', details: { missing: ['DIAGNOSIS'] } });
    expect((await pool.query(`SELECT 1 FROM job_postings WHERE patient_id = $1`, [id])).rowCount).toBe(0);
    await seedPatientDiagnosis(pool, id);
    r = await api.post(url, {}, asAdmin);
    expect(r.status).toBe(201);
  });

  it('6d. paciente JÁ em atendimento (SEARCHING → ACTIVE) sem diagnóstico NÃO é afetado: a regra só olha a entrada', async () => {
    const { id } = await paciente('SEARCHING', true);
    const r = await put(id, { status: 'ACTIVE', changeSource: 'kanban' });
    expect(r.status).toBe(200);
  });

  it('7. nenhuma resposta carrega o VALOR do diagnóstico (só o código DIAGNOSIS)', async () => {
    const { id } = await paciente('ADMISSION');
    await seedPatientDiagnosis(pool, id, { active: false });
    const r = await put(id, { status: 'SEARCHING', changeSource: 'kanban' });
    expect(JSON.stringify(r.data)).not.toContain('Diagnóstico sintético e2e');
  });
});
