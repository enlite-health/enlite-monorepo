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
import { semearFaixas, type FaixaSemente } from './helpers/seedFaixaDoServico';
import { seedPatientDiagnosis } from './helpers/seedPatientDiagnosis';
import { vacancyEffectiveJoinSql, vacancyEffectiveScheduleSql } from '../../src/shared/sql/vacancyEffectiveFieldsSql';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const UID = 'sched-gate-e2e-admin';
const TAG = 'sched-gate-e2e-%';
// spec 056: o horário do serviço = faixas em patient_itinerary_slot (08:00 + 240 min = 12:00)
const HORARIO: FaixaSemente[] = [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }];

describe('Horário do serviço trava a mudança de status (07/09) @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: { headers: { Authorization: string } };

  /** Cria paciente com endereço e UM serviço; `schedule` decide se ele fica "pronto". */
  async function criarPaciente(opts: {
    tag: string;
    status: string;
    schedule: readonly FaixaSemente[] | null;
    comServico?: boolean;
    comEndereco?: boolean;
    /** `insurance_informed` — só usado pelos testes de `activate-recruitment` (RECRUITMENT_BLOCKING_CODES cobra COVERAGE). */
    coverage?: string | null;
    /** Diagnóstico CID-11 ativo (pedido do Javier): ativar recrutamento com o paciente pré-atendimento o exige. Default: não. */
    comDiagnostico?: boolean;
  }): Promise<string> {
    const id = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, insurance_informed)
       VALUES ($1, 'Horario', 'Gate', 'AR', $2, $3) RETURNING id`,
      [opts.tag, opts.status, opts.coverage ?? null],
    )).rows[0].id;

    if (opts.comDiagnostico) await seedPatientDiagnosis(pool, id);

    let addr: string | null = null;
    if (opts.comEndereco !== false) {
      addr = (await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, address_formatted, display_order)
         VALUES ($1,'Calle Horario 1',1) RETURNING id`,
        [id],
      )).rows[0].id;
    }
    if (opts.comServico !== false) {
      const sid = (await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services
           (patient_id, service_code, active, country, created_by, updated_by, address_id,
            required_professions, required_sex, required_experience, work_schedule, payment_day)
         -- spec 027 Fase 3: os 5 campos do portão "ativar recrutamento" (D508 c) vêm preenchidos por padrão
         VALUES ($1,'AT',true,'AR','sched-gate-e2e','sched-gate-e2e',$2,
                 ARRAY['AT'],'BOTH','EXP-E2E','part-time','DIA-E2E') RETURNING id`,
        [id, addr],
      )).rows[0].id;
      await semearFaixas(pool, sid, opts.schedule ?? [], 'sched-gate-e2e');
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

  // F5 (estado-automatico-do-paciente): a troca MANUAL para ACTIVE/SEARCHING/REPLACEMENT acabou — o `PUT /status` devolve
  // 422 PATIENT_STATUS_NOT_MANUAL ANTES de olhar FSM ou completude. Logo o gate de completude (SERVICE_SCHEDULE/ADDRESS) deixou de ser
  // alcançável por esse caminho; fica provado pelo único caminho real que ainda o cobra: `activate-recruitment` (o foguete). Os casos
  // que mediam a régua pelo PUT viraram dois pares: (a) o PUT recusa com NOT_MANUAL mesmo com a ficha incompleta (prova que a recusa
  // não depende da completude e que o gate antigo não responde mais) e (b) o foguete recusa/aceita pela mesma régua.
  const trilha = async (id: string): Promise<number> =>
    Number((await pool.query('SELECT count(*) AS n FROM patient_status_history WHERE patient_id = $1', [id])).rows[0].n);
  const sidDe = async (id: string): Promise<string> =>
    (await pool.query<{ id: string }>('SELECT id FROM patient_contracted_services WHERE patient_id = $1 ORDER BY created_at LIMIT 1', [id])).rows[0].id;
  const foguete = (id: string, sid: string) =>
    api.post(`/api/admin/patients/${id}/contracted-services/${sid}/activate-recruitment`, {}, asAdmin);
  const recusaNotManual = async (id: string, status: string, changeSource?: string) => {
    const antes = { status: (await pool.query('SELECT status FROM patients WHERE id = $1', [id])).rows[0].status, trilha: await trilha(id) };
    const r = await put(id, changeSource ? { status, changeSource } : { status });
    expect(r.status).toBe(422);
    expect(r.data).toMatchObject({ success: false, code: 'PATIENT_STATUS_NOT_MANUAL', details: { to: status, changeSource: changeSource ?? 'admin_panel' } });
    expect(r.data.details.missing).toBeUndefined(); // a completude nem foi consultada
    expect({ status: (await pool.query('SELECT status FROM patients WHERE id = $1', [id])).rows[0].status, trilha: await trilha(id) }).toEqual(antes);
  };

  it('1. serviço sem horário (NULL): PUT status ACTIVE devolve 422 PATIENT_STATUS_NOT_MANUAL (não NOT_READY) e o banco NÃO muda; o foguete recusa com SERVICE_SCHEDULE', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-1', status: 'SEARCHING', schedule: null });
    await recusaNotManual(id, 'ACTIVE');

    const f = await criarPaciente({ tag: 'sched-gate-e2e-1f', status: 'PENDING_ADMISSION', schedule: null, coverage: 'Particular', comDiagnostico: true });
    const r = await foguete(f, await sidDe(f));
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toContain('SERVICE_SCHEDULE');
    expect((await pool.query('SELECT status FROM patients WHERE id = $1', [f])).rows[0].status).toBe('PENDING_ADMISSION');
  });

  it('2. serviço com ZERO faixas conta como sem horário — o serviço existe, a lista é vazia, o foguete tem de pegá-lo', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-2', status: 'PENDING_ADMISSION', schedule: [], coverage: 'Particular', comDiagnostico: true });

    // controle positivo: o serviço REALMENTE existe e tem 0 faixas (senão o teste mediria "sem serviço")
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(s.id) AS n FROM patient_contracted_services pcs
         LEFT JOIN patient_itinerary_slot s ON s.contracted_service_id = pcs.id
        WHERE pcs.patient_id = $1 GROUP BY pcs.id`, [id],
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].n)).toBe(0);

    const r = await foguete(id, await sidDe(id));
    expect(r.status).toBe(422);
    expect(r.data.details.missing).toContain('SERVICE_SCHEDULE');
    expect((await pool.query('SELECT count(*) AS n FROM job_postings WHERE patient_id = $1', [id])).rows[0].n).toBe('0');
  });

  it('3. COM horário o PUT ACTIVE continua recusado (NOT_MANUAL): a recusa não depende de a ficha estar completa', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-3', status: 'SEARCHING', schedule: HORARIO });
    await recusaNotManual(id, 'ACTIVE');
  });

  it('4. o DROP NO KANBAN (changeSource kanban) é NOT_MANUAL para QUALQUER destino; o foguete sem endereço do serviço é recusado', async () => {
    const id = await criarPaciente({
      tag: 'sched-gate-e2e-4', status: 'SEARCHING', schedule: HORARIO, comEndereco: false,
    });
    await recusaNotManual(id, 'ACTIVE', 'kanban');
    await recusaNotManual(id, 'ON_HOLD', 'kanban');

    const f = await criarPaciente({
      tag: 'sched-gate-e2e-4f', status: 'PENDING_ADMISSION', schedule: HORARIO, comEndereco: false, coverage: 'Particular', comDiagnostico: true,
    });
    const r = await foguete(f, await sidDe(f));
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toEqual(expect.arrayContaining(['SERVICE_ADDRESS']));
    expect((await pool.query('SELECT status FROM patients WHERE id = $1', [f])).rows[0].status).toBe('PENDING_ADMISSION');
  });

  it('5. SEARCHING e REPLACEMENT pelo PUT são NOT_MANUAL com e sem horário (a recusa é pelo destino, não pela ficha)', async () => {
    const semHorario = await criarPaciente({ tag: 'sched-gate-e2e-5a', status: 'ACTIVE', schedule: null });
    await recusaNotManual(semHorario, 'REPLACEMENT');
    await recusaNotManual(semHorario, 'SEARCHING');

    const comHorario = await criarPaciente({ tag: 'sched-gate-e2e-5b', status: 'ACTIVE', schedule: HORARIO });
    await recusaNotManual(comHorario, 'REPLACEMENT');
    await recusaNotManual(comHorario, 'SEARCHING');
  });

  it('6. pausa e saída NÃO exigem horário — ON_HOLD, SUSPENDED e DISCHARGED passam com a ficha incompleta', async () => {
    const a = await criarPaciente({ tag: 'sched-gate-e2e-6a', status: 'ACTIVE', schedule: null });
    expect((await put(a, { status: 'ON_HOLD', onHoldReason: 'OTHER' })).status).toBe(200);

    const b = await criarPaciente({ tag: 'sched-gate-e2e-6b', status: 'ACTIVE', schedule: null });
    expect((await put(b, { status: 'SUSPENDED' })).status).toBe(200);

    const c = await criarPaciente({ tag: 'sched-gate-e2e-6c', status: 'ACTIVE', schedule: null });
    expect((await put(c, { status: 'DISCHARGED' })).status).toBe(200);
  });

  it('7. paciente SEM serviço nenhum: o PUT ACTIVE é NOT_MANUAL e o foguete não tem serviço para ativar', async () => {
    const id = await criarPaciente({
      tag: 'sched-gate-e2e-7', status: 'SEARCHING', schedule: null, comServico: false,
    });
    await recusaNotManual(id, 'ACTIVE');
    const { rows } = await pool.query('SELECT 1 FROM patient_contracted_services WHERE patient_id = $1', [id]);
    expect(rows).toHaveLength(0);
  });

  it('8. UM serviço com horário e outro SEM: o foguete do serviço sem horário é recusado (a régua olha o serviço que se ativa)', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-8', status: 'PENDING_ADMISSION', schedule: HORARIO, coverage: 'Particular', comDiagnostico: true });
    const addr = (await pool.query<{ id: string }>(
      `SELECT id FROM patient_addresses WHERE patient_id = $1`, [id],
    )).rows[0].id;
    const semHorario = (await pool.query<{ id: string }>(
      `INSERT INTO patient_contracted_services
         (patient_id, service_code, active, country, created_by, updated_by, address_id, schedule,
          required_professions, required_sex, required_experience, work_schedule, payment_day)
       VALUES ($1,'CAREGIVER',true,'AR','sched-gate-e2e','sched-gate-e2e',$2,NULL,
               ARRAY['AT'],'BOTH','EXP-E2E','part-time','DIA-E2E') RETURNING id`,
      [id, addr],
    )).rows[0].id;

    const r = await foguete(id, semHorario);
    expect(r.status).toBe(422);
    expect(r.data.details.missing).toContain('SERVICE_SCHEDULE');
    expect((await pool.query('SELECT count(*) AS n FROM job_postings WHERE patient_id = $1', [id])).rows[0].n).toBe('0');
  });

  it('9. serviço INATIVO sem horário não bloqueia o foguete do serviço ativo — a régua é sobre serviço ATIVO', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-9', status: 'PENDING_ADMISSION', schedule: HORARIO, coverage: 'Particular', comDiagnostico: true });
    const sid = await sidDe(id);
    await pool.query(
      // `ended_at` é obrigatório quando `active=false` (CHECK pcs_active_ended_coerente)
      `INSERT INTO patient_contracted_services
         (patient_id, service_code, active, ended_at, country, created_by, updated_by, schedule)
       VALUES ($1,'CAREGIVER',false,NOW(),'AR','sched-gate-e2e','sched-gate-e2e',NULL)`,
      [id],
    );
    const r = await foguete(id, sid);
    expect(r.status).toBe(201);
    expect(r.data.data.patientStatus).toBe('SEARCHING');
  });

  it('10. o checklist da ficha mostra SERVICE_SCHEDULE em missing E em blocking — a tela avisa o mesmo que a rota recusa', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-10', status: 'PENDING_ADMISSION', schedule: null });

    const g = await api.get(`/api/admin/patients/${id}`, asAdmin);
    expect(g.status).toBe(200);
    expect(g.data.data.completeness.missing).toContain('SERVICE_SCHEDULE');
    expect(g.data.data.completeness.blocking).toContain('SERVICE_SCHEDULE');
    expect(g.data.data.completeness.canActivate).toBe(false);
  });

  // Spec 018, PR-6, ADR-5: `POST /:id/activate` virou 410 (`ACTIVATION_SPLIT`) — ativar
  // recrutamento agora é POR SERVIÇO, em `POST /:id/contracted-services/:sid/activate-recruitment`
  // (`RECRUITMENT_BLOCKING_CODES`, contracts/activation.md). Testes 11/12 migrados para a rota nova.

  it('11. `POST /:id/activate` (removido) → 410 ACTIVATION_SPLIT, nunca 422/200', async () => {
    const id = await criarPaciente({ tag: 'sched-gate-e2e-11', status: 'PENDING_ADMISSION', schedule: null });
    const r = await api.post(`/api/admin/patients/${id}/activate`, {}, asAdmin);
    expect(r.status).toBe(410);
    expect(r.data.code).toBe('ACTIVATION_SPLIT');
  });

  it('12. sem horário no serviço, `activate-recruitment` recusa (422 SERVICE_SCHEDULE) e não cria vaga', async () => {
    const id = await criarPaciente({
      tag: 'sched-gate-e2e-12',
      status: 'PENDING_ADMISSION',
      schedule: null,
      coverage: 'Particular',
    });
    const { rows: svcRows } = await pool.query<{ id: string }>(
      'SELECT id FROM patient_contracted_services WHERE patient_id = $1', [id],
    );
    const sid = svcRows[0].id;

    const r = await api.post(`/api/admin/patients/${id}/contracted-services/${sid}/activate-recruitment`, {}, asAdmin);
    expect(r.status).toBe(422);
    expect(r.data.code).toBe('PATIENT_NOT_READY');
    expect(r.data.details.missing).toContain('SERVICE_SCHEDULE');

    const { rows } = await pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM job_postings WHERE patient_id = $1', [id],
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('13. com horário e cobertura, `activate-recruitment` cria a vaga (201) SEM copiar o horário: a vaga lê do serviço', async () => {
    const id = await criarPaciente({
      tag: 'sched-gate-e2e-13',
      status: 'PENDING_ADMISSION',
      schedule: HORARIO,
      coverage: 'Particular',
      comDiagnostico: true,
    });
    const { rows: svcRows } = await pool.query<{ id: string }>(
      'SELECT id FROM patient_contracted_services WHERE patient_id = $1', [id],
    );
    const sid = svcRows[0].id;

    const r = await api.post(`/api/admin/patients/${id}/contracted-services/${sid}/activate-recruitment`, {}, asAdmin);
    expect(r.status).toBe(201);
    expect(r.data.data.patientStatus).toBe('SEARCHING');
    expect(r.data.data.statusChanged).toBe(true);
    const { rows: hist } = await pool.query<{ change_source: string }>(
      'SELECT change_source FROM patient_status_history WHERE patient_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [id],
    );
    expect(hist[0].change_source).toBe('recruitment_activation');

    // Fonte única: a coluna da vaga fica vazia e o horário efetivo vem do serviço, pela peça.
    const { rows } = await pool.query<{ copia: unknown; efetivo: unknown; contracted_service_id: string }>(
      `SELECT jp.schedule AS copia, ${vacancyEffectiveScheduleSql()} AS efetivo, jp.contracted_service_id
         FROM job_postings jp ${vacancyEffectiveJoinSql()}
        WHERE jp.patient_id = $1`, [id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].contracted_service_id).toBe(sid);
    expect(rows[0].copia).toBeNull();
    expect(rows[0].efetivo).toEqual([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00', durationMinutes: 240 }]);
  });
});
