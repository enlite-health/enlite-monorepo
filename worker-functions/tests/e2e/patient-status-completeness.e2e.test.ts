/**
 * Horário do serviço trava a MUDANÇA DE STATUS (decisão do Gabriel, 07/09/2026) @integration
 *
 * O que só o e2e prova, e o teste unitário não:
 *   - a cláusula SQL de `SERVICE_SCHEDULE` roda contra Postgres de verdade (`jsonb_array_length`
 *     num JSONB real, não num mock que devolve o número que eu quiser);
 *   - o CHECK `pcs_schedule_is_array` aceita `'[]'::jsonb` — então o array VAZIO É gravável por
 *     SQL, e o predicado tem de pegá-lo (a borda zod, que normaliza `[] → null`, não protege
 *     seed, sync do ClickUp nem psql);
 *   - o CONTRATO da rota (422 + `code` + `details.missing`), que só o e2e vê (D188).
 *
 * A régua por status-alvo: ACTIVE cobra o checklist bloqueante inteiro (fecha o atalho do drop no
 * Kanban); SEARCHING/REPLACEMENT cobram só o horário; ON_HOLD/SUSPENDED/DISCHARGED não cobram nada.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const UID = 'sched-gate-e2e-admin';
const TAG = 'sched-gate-e2e-%';
const HORARIO = '[{"dayOfWeek":1,"startTime":"08:00","endTime":"12:00"}]';

describe('Horário do serviço trava a mudança de status (07/09) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: { headers: { Authorization: string } };

  /** Cria paciente com endereço e UM serviço; `schedule` decide se ele fica "pronto". */
  async function criarPaciente(opts: {
    tag: string;
    status: string;
    schedule: string | null;
    comServico?: boolean;
    comEndereco?: boolean;
  }): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'Horario', 'Gate', 'AR', $2) RETURNING id`,
      [opts.tag, opts.status],
    )).rows[0].id;

    let addr: string | null = null;
    if (opts.comEndereco !== false) {
      addr = (await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, address_formatted, display_order)
         VALUES ($1,'Calle Horario 1',1) RETURNING id`,
        [id],
      )).rows[0].id;
    }
    if (opts.comServico !== false) {
      await pool.query(
        `INSERT INTO patient_contracted_services
           (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
         VALUES ($1,'AT',true,'AR','sched-gate-e2e','sched-gate-e2e',$2,$3::jsonb)`,
        [id, addr, opts.schedule],
      );
    }
    return id;
  }

  const put = (id: string, body: Record<string, unknown>) =>
    api.put(`/api/admin/patients/${id}/status`, body, asAdmin);

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(UID, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
  });

  afterAll(async () => {
    // As vagas criadas pelo `POST /activate` referenciam o paciente (FK sem CASCADE) — saem antes.
    await pool.query(
      `DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`,
      [TAG],
    );
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
    await pool.end();
  });

  it('1. serviço sem horário (NULL) → PUT status ACTIVE devolve 422 PATIENT_STATUS_NOT_READY com SERVICE_SCHEDULE, e o banco NÃO muda', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-1', status: 'PENDING_ADMISSION', schedule: null });

    const r = await put(id, { status: 'ACTIVE' });
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({
      success: false,
      code: 'PATIENT_STATUS_NOT_READY',
      details: { to: 'ACTIVE', missing: ['SERVICE_SCHEDULE'] },
    });

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM patients WHERE id = $1', [id]);
    expect(rows[0].status).toBe('PENDING_ADMISSION');
  });

  it('2. ARRAY VAZIO gravado por SQL conta como sem horário — o CHECK do banco o aceita, o predicado tem de pegá-lo', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-2', status: 'PENDING_ADMISSION', schedule: '[]' });

    // controle positivo: o `[]` REALMENTE está gravado (se o CHECK o tivesse recusado, o teste
    // estaria medindo um NULL e passaria pelo motivo errado)
    const { rows } = await pool.query<{ schedule: unknown }>(
      `SELECT schedule FROM patient_contracted_services WHERE patient_id = $1`, [id],
    );
    expect(rows[0].schedule).toEqual([]);

    const r = await put(id, { status: 'ACTIVE' });
    expect(r.status).toBe(422);
    expect(r.data.details.missing).toContain('SERVICE_SCHEDULE');
  });

  it('3. COM horário → ACTIVE passa (200) e o banco grava', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-3', status: 'PENDING_ADMISSION', schedule: HORARIO });

    const r = await put(id, { status: 'ACTIVE' });
    expect(r.status).toBe(200);
    const { rows } = await pool.query<{ status: string }>('SELECT status FROM patients WHERE id = $1', [id]);
    expect(rows[0].status).toBe('ACTIVE');
  });

  it('4. o DROP NO KANBAN (changeSource kanban) passa a cobrar o checklist INTEIRO — sem endereço é 422 ADDRESS', async () => {
    const id = await criarPaciente({
      tag: 'sched-gate-e2e-4', status: 'PENDING_ADMISSION', schedule: HORARIO, comEndereco: false,
    });

    const r = await put(id, { status: 'ACTIVE', changeSource: 'kanban' });
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_STATUS_NOT_READY');
    // o serviço nasceu sem endereço junto — os dois códigos bloqueiam
    expect(r.data.details.missing).toEqual(expect.arrayContaining(['ADDRESS', 'SERVICE_ADDRESS']));

    const { rows } = await pool.query<{ status: string }>('SELECT status FROM patients WHERE id = $1', [id]);
    expect(rows[0].status).toBe('PENDING_ADMISSION');
  });

  it('5. SEARCHING e REPLACEMENT exigem só o horário — recusados sem ele, aceitos com ele', async () => {
    const semHorario = await criarPaciente({ tag: 'sched-gate-e2e-5a', status: 'ACTIVE', schedule: null });
    const r1 = await put(semHorario, { status: 'REPLACEMENT' });
    expect(r1.status).toBe(422);
    expect(r1.data.details.missing).toEqual(['SERVICE_SCHEDULE']);

    const comHorario = await criarPaciente({ tag: 'sched-gate-e2e-5b', status: 'ACTIVE', schedule: HORARIO });
    expect((await put(comHorario, { status: 'REPLACEMENT' })).status).toBe(200);
    expect((await put(comHorario, { status: 'SEARCHING' })).status).toBe(200);
  });

  it('6. pausa e saída NÃO exigem horário — ON_HOLD, SUSPENDED e DISCHARGED passam com a ficha incompleta', async () => {
    const a = await criarPaciente({ tag: 'sched-gate-e2e-6a', status: 'ACTIVE', schedule: null });
    expect((await put(a, { status: 'ON_HOLD', onHoldReason: 'OTHER' })).status).toBe(200);

    const b = await criarPaciente({ tag: 'sched-gate-e2e-6b', status: 'ACTIVE', schedule: null });
    expect((await put(b, { status: 'SUSPENDED' })).status).toBe(200);

    const c = await criarPaciente({ tag: 'sched-gate-e2e-6c', status: 'ACTIVE', schedule: null });
    expect((await put(c, { status: 'DISCHARGED' })).status).toBe(200);
  });

  it('7. paciente SEM serviço nenhum não é barrado pelo horário (mesmo fallback do endereço do serviço)', async () => {
    const id = await criarPaciente({
      tag: 'sched-gate-e2e-7', status: 'PENDING_ADMISSION', schedule: null, comServico: false,
    });
    expect((await put(id, { status: 'ACTIVE' })).status).toBe(200);
  });

  it('8. UM serviço com horário e outro SEM → bloqueia (a régua é "todo serviço ativo", não "algum")', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-8', status: 'PENDING_ADMISSION', schedule: HORARIO });
    const addr = (await pool.query<{ id: string }>(
      `SELECT id FROM patient_addresses WHERE patient_id = $1`, [id],
    )).rows[0].id;
    await pool.query(
      `INSERT INTO patient_contracted_services
         (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule)
       VALUES ($1,'CAREGIVER',true,'AR','sched-gate-e2e','sched-gate-e2e',$2,NULL)`,
      [id, addr],
    );

    const r = await put(id, { status: 'ACTIVE' });
    expect(r.status).toBe(422);
    expect(r.data.details.missing).toEqual(['SERVICE_SCHEDULE']);
  });

  it('9. serviço INATIVO sem horário não bloqueia — a régua é sobre serviço ATIVO', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-9', status: 'PENDING_ADMISSION', schedule: HORARIO });
    await pool.query(
      // `ended_at` é obrigatório quando `active=false` (CHECK pcs_active_ended_coerente)
      `INSERT INTO patient_contracted_services
         (patient_id, service_code, active, ended_at, country, created_by, updated_by, schedule)
       VALUES ($1,'CAREGIVER',false,NOW(),'AR','sched-gate-e2e','sched-gate-e2e',NULL)`,
      [id],
    );
    expect((await put(id, { status: 'ACTIVE' })).status).toBe(200);
  });

  it('10. o checklist da ficha mostra SERVICE_SCHEDULE em missing E em blocking — a tela avisa o mesmo que a rota recusa', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-10', status: 'PENDING_ADMISSION', schedule: null });

    const g = await api.get(`/api/admin/patients/${id}`, asAdmin);
    expect(g.status).toBe(200);
    expect(g.data.data.completeness.missing).toContain('SERVICE_SCHEDULE');
    expect(g.data.data.completeness.blocking).toContain('SERVICE_SCHEDULE');
    expect(g.data.data.completeness.canActivate).toBe(false);
  });

  it('11. `POST /activate` recusa pelo mesmo código, e NÃO cria vaga nenhuma', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-11', status: 'PENDING_ADMISSION', schedule: null });

    const r = await api.post(`/api/admin/patients/${id}/activate`, {}, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.details.missing).toContain('SERVICE_SCHEDULE');

    const { rows } = await pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('12. com horário, o `POST /activate` cria a vaga E copia o horário do serviço para ela', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-12', status: 'PENDING_ADMISSION', schedule: HORARIO });

    const r = await api.post(`/api/admin/patients/${id}/activate`, {}, asAdmin);
    expect(r.status).toBe(200);

    const { rows } = await pool.query<{ schedule: unknown }>(
      'SELECT schedule FROM job_postings WHERE patient_id = $1', [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].schedule).toEqual([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }]);
  });
});
