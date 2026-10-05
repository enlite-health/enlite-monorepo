/**
 * itinerary-allocation-pool.e2e.test.ts @integration — spec 041 R1 (DEC-04/DEC-05).
 *
 * Prova, contra a API REAL + Postgres real, que as opções do itinerário (GET .../allocation-options)
 * e o gate de alocação (POST .../slots/:slotId/allocations) vêm do STEP FINAL DA VACANTE:
 * "Selecionados" (SELECTED) ∪ "Equipe de Resposta Rápida" (QUICK_RESPONSE_TEAM) da vaga viva, menos
 * quem tem marca de rejeição no serviço. Quem já está alocado continua na lista como IN_SERVICE.
 *
 * Teste que MORRE se desfizerem: o prestador SÓ em "Selecionados" aparece e ALOCA (201); se o pool
 * voltar a `QUICK_RESPONSE_TEAM` só, ele some das opções e a alocação vira 422.
 * O semeio é SQL direto (worker/vaga/candidatura/marca); as leituras e a alocação passam pela API.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pool-e2e-${RUN}-`;

interface Option {
  workerId: string;
  status: 'IN_SERVICE' | 'QUICK_RESPONSE' | 'SELECTED';
}

describe('allocation-options e gate de alocação — pool do step final da vacante (041 R1) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;

  let patientId = '';
  let serviceId = '';
  let jobId = '';
  let slotId = '';
  const ids: Record<string, string> = {};

  async function mkWorker(label: string, stage: string): Promise<void> {
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}${label}`, `${TASK_PREFIX}${label}@e2e.local`],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, $3, 'import')`,
      [workerId, jobId, stage],
    );
    ids[label] = workerId;
  }

  const allocationsUrl = () =>
    `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slotId}/allocations`;

  async function options(): Promise<Option[]> {
    const res = await api.get(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/allocation-options`,
      { headers: asAdmin.headers },
    );
    expect(res.status).toBe(200);
    return res.data.data.options as Option[];
  }

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`pool-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });

    patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'PoolVacante', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p1`],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patientId],
      )
    ).rows[0].id;
    serviceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patientId, addressId, TASK_PREFIX],
      )
    ).rows[0].id;
    jobId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${TASK_PREFIX}vaga`, serviceId, patientId],
      )
    ).rows[0].id;
    slotId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 1, '08:00', '12:00', $2, $2) RETURNING id`,
        [serviceId, TASK_PREFIX],
      )
    ).rows[0].id;

    await mkWorker('soSelecionado', 'SELECTED');
    await mkWorker('respostaRapida', 'QUICK_RESPONSE_TEAM');
    await mkWorker('rejeitado', 'SELECTED');
    await mkWorker('colunaAnterior', 'CONFIRMED');
    await pool.query(
      `INSERT INTO contracted_service_rejections (service_id, worker_id, reject_reason_category, rejected_by, created_by, updated_by)
       VALUES ($1, $2, 'OTHER', $3, $3, $3)`,
      [serviceId, ids.rejeitado, TASK_PREFIX],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM patient_itinerary_change_log WHERE contracted_service_id = $1`, [serviceId]);
    await pool.query(
      `DELETE FROM patient_itinerary_assignment a USING patient_itinerary_slot s
        WHERE a.slot_id = s.id AND s.contracted_service_id = $1`,
      [serviceId],
    );
    await pool.query(`DELETE FROM contracted_service_rejections WHERE service_id = $1`, [serviceId]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobId]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.end();
  });

  it('opções: Selecionados e Resposta Rápida entram (QRT antes); rejeitado e coluna anterior ficam fora', async () => {
    const opts = await options();
    const byId = new Map(opts.map((o) => [o.workerId, o.status]));

    expect(byId.get(ids.soSelecionado)).toBe('SELECTED');
    expect(byId.get(ids.respostaRapida)).toBe('QUICK_RESPONSE');
    expect(byId.has(ids.rejeitado)).toBe(false);
    expect(byId.has(ids.colunaAnterior)).toBe(false);
    expect(opts.map((o) => o.workerId).indexOf(ids.respostaRapida)).toBeLessThan(
      opts.map((o) => o.workerId).indexOf(ids.soSelecionado),
    );
  });

  it('rejeitado (mesmo em Selecionados) → alocação RECUSADA 422; coluna anterior → 422', async () => {
    const rej = await api.post(allocationsUrl(), { workerId: ids.rejeitado }, { headers: asAdmin.headers });
    expect(rej.status).toBe(422);
    expect(rej.data.code).toBe('NOT_SELECTED_FOR_SERVICE');
    const prev = await api.post(allocationsUrl(), { workerId: ids.colunaAnterior }, { headers: asAdmin.headers });
    expect(prev.status).toBe(422);
  });

  it('SÓ em "Selecionados" → alocação ACEITA (201) e passa a IN_SERVICE, primeiro da lista', async () => {
    const res = await api.post(allocationsUrl(), { workerId: ids.soSelecionado }, { headers: asAdmin.headers });
    expect(res.status).toBe(201);

    const opts = await options();
    expect(opts[0]).toMatchObject({ workerId: ids.soSelecionado, status: 'IN_SERVICE' });
    expect(opts.find((o) => o.workerId === ids.respostaRapida)?.status).toBe('QUICK_RESPONSE');
  });
});
