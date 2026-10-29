/**
 * patient-status-derivation-horario.e2e.test.ts @integration — spec 056 (Horas com dono único), T3.3
 *
 * Prova, contra a API REAL e o Postgres real, que a régua do estado (Búsqueda/Reemplazo/Activo) lê o
 * TOTAL DAS FAIXAS VIGENTES e não `weekly_hours`, e que editar o horário recalcula o estado na MESMA
 * transação (⚑13):
 *   - serviço com 4 faixas de 10 h (40 h); `weekly_hours = 10` por SQL (a coluna morta; quem a lesse
 *     veria 20 cobertas >= 10 e daria ACTIVE);
 *   - 1ª faixa alocada por SQL (não deriva); a 2ª alocada PELA API → derivação → `REPLACEMENT`
 *     (20 de 40);
 *   - PATCH do serviço deixando só as 2 faixas cobertas (20 h) → a derivação roda no fim da mesma
 *     transação → o GET do paciente seguinte já diz `ACTIVE`.
 * As faixas do mesmo serviço não se sobrepõem (constraint `pis_sem_sobreposicao`): seg-qui 08:00 + 600 min.
 * Semente por SQL como dono (molde `patient-status-derivation-atomicity`); limpeza por prefixo contando 0.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `psdh-e2e-${RUN}-`;

const faixa = (dayOfWeek: number) => ({ dayOfWeek, startTime: '08:00', durationMinutes: 600 });

describe('editar o horário recalcula o estado do paciente pelo total das faixas (spec 056, T3.3) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let semanaAtras = '';

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`psdh-admin-${RUN}`, 'admin');
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const d = await pool.query<{ hoje: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 7, 'YYYY-MM-DD') AS hoje`,
    );
    semanaAtras = d.rows[0].hoje; // início da alocação: semana passada (vigente hoje, nunca no futuro)
  });

  afterAll(async () => {
    try {
      const pats = `SELECT id FROM patients WHERE clickup_task_id LIKE $1`;
      await pool.query(
        `DELETE FROM patient_itinerary_assignment WHERE slot_id IN (
           SELECT s.id FROM patient_itinerary_slot s
             JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
            WHERE pcs.patient_id IN (${pats}))`,
        [`${TASK_PREFIX}%`],
      );
      await pool.query(`DELETE FROM patient_itinerary_assembly WHERE patient_id IN (${pats})`, [`${TASK_PREFIX}%`]);
      await pool.query(
        `DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`,
        [`${TASK_PREFIX}%`],
      );
      await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, [`${TASK_PREFIX}%`]);
      await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${TASK_PREFIX}%`]);
      await pool.query(
        `DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (
           SELECT id FROM patient_contracted_services WHERE patient_id IN (${pats}))`,
        [`${TASK_PREFIX}%`],
      );
      await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (${pats})`, [`${TASK_PREFIX}%`]);
      await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (${pats})`, [`${TASK_PREFIX}%`]);
      await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
      const left = await pool.query<{ p: number; w: number; j: number }>(
        `SELECT (SELECT count(*)::int FROM patients WHERE clickup_task_id LIKE $1) AS p,
                (SELECT count(*)::int FROM workers WHERE auth_uid LIKE $1) AS w,
                (SELECT count(*)::int FROM job_postings WHERE title LIKE $1) AS j`,
        [`${TASK_PREFIX}%`],
      );
      console.log('[056 T3.3] limpeza final', left.rows[0]);
      expect(left.rows[0]).toEqual({ p: 0, w: 0, j: 0 });
    } finally {
      await pool.end();
    }
  });

  async function mkWorker(tag: string, jobId: string): Promise<string> {
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country, status, occupation) VALUES ($1, $2, 'AR', 'REGISTERED', 'AT') RETURNING id`,
        [`${tag}`, `${tag}@e2e.local`],
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'manual')`,
      [workerId, jobId],
    );
    return workerId;
  }

  it('régua = total das faixas: REPLACEMENT mesmo com weekly_hours 10; PATCH do horário → ACTIVE na resposta seguinte', async () => {
    const tag = `${TASK_PREFIX}1`;
    const patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, has_consent, insurance_informed)
         VALUES ($1, 'Derivacao', 'Horario', 'AR', 'SEARCHING', true, 'OSDE') RETURNING id`,
        [tag],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country, lat, lng) VALUES ($1, 'AR', -34.6, -58.4) RETURNING id`,
        [patientId],
      )
    ).rows[0].id;

    // O serviço nasce PELA API, com 4 faixas de 10 h (40 h/semana).
    const created = await api.post(
      `/api/admin/patients/${patientId}/contracted-services`,
      { serviceCode: 'AT', addressId, schedule: [faixa(1), faixa(2), faixa(3), faixa(4)] },
      asAdmin,
    );
    expect(created.status).toBe(201);
    const serviceId = created.data.data.id as string;
    const slots = await pool.query<{ id: string; weekday: number }>(
      `SELECT id, weekday FROM patient_itinerary_slot WHERE contracted_service_id = $1 ORDER BY weekday`,
      [serviceId],
    );
    expect(slots.rows.map((s) => s.weekday)).toEqual([1, 2, 3, 4]);
    const total = await pool.query<{ h: number }>(
      `SELECT sum(duration_minutes)::int / 60 AS h FROM patient_itinerary_slot WHERE contracted_service_id = $1`,
      [serviceId],
    );
    expect(total.rows[0].h).toBe(40);

    // A coluna morta diz 10 h: quem lesse `weekly_hours` veria 20 cobertas >= 10 e daria ACTIVE.
    await pool.query(`UPDATE patient_contracted_services SET weekly_hours = 10 WHERE id = $1`, [serviceId]);

    const jobId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${tag}-vaga`, serviceId, patientId],
      )
    ).rows[0].id;
    const workerA = await mkWorker(`${tag}-wa`, jobId);
    const workerB = await mkWorker(`${tag}-wb`, jobId);
    const appA = (await pool.query<{ id: string }>(`SELECT id FROM worker_job_applications WHERE worker_id = $1`, [workerA])).rows[0].id;
    await pool.query(
      `INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, $2, 'AR')`,
      [patientId, TASK_PREFIX],
    );

    // 1ª faixa (segunda) alocada por SQL: não dispara derivação (o status segue SEARCHING).
    await pool.query(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)`,
      [slots.rows[0].id, workerA, appA, semanaAtras, TASK_PREFIX],
    );

    // 2ª faixa (terça) alocada PELA API → derivação: 20 h de 40 h → REPLACEMENT.
    const alloc = await api.post(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}/itinerary/slots/${slots.rows[1].id}/allocations`,
      { workerId: workerB },
      asAdmin,
    );
    expect(alloc.status).toBe(201);
    const depoisDeAlocar = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    console.log('[056 T3.3] após alocar', { patientId, status: depoisDeAlocar.data?.data?.status });
    expect(depoisDeAlocar.status).toBe(200);
    expect(depoisDeAlocar.data.data.status).toBe('REPLACEMENT');

    // PATCH do horário deixando só as 2 faixas cobertas (20 h): o denominador cai para 20 → ACTIVE.
    const patched = await api.patch(
      `/api/admin/patients/${patientId}/contracted-services/${serviceId}`,
      { schedule: [faixa(1), faixa(2)] },
      asAdmin,
    );
    expect(patched.status).toBe(200);
    const depoisDoPatch = await api.get(`/api/admin/patients/${patientId}`, asAdmin);
    console.log('[056 T3.3] após PATCH', { patientId, status: depoisDoPatch.data?.data?.status });
    expect(depoisDoPatch.data.data.status).toBe('ACTIVE');
  });
});
