/**
 * Massa das e2e de API da 058b/B2 (cópia parametrizada do `seed` de itinerary-remove-with-reason.e2e.test.ts:94-164).
 * SQL sempre com parâmetro ($1…); a limpeza casa por prefixo (`LIKE prefix%`).
 */
import type { Pool } from 'pg';

export const SCHEDULE_ONE = JSON.stringify([{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }]);
export const SCHEDULE_TWO = JSON.stringify([
  { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
  { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
]);

export interface SeedB2Opts {
  schedule: 'ONE' | 'TWO';
  providersNeeded: number | null;
  titularesSeg: number;
  titularesQua?: number;
  selecionados?: number;
  desdeDias?: number;
}
export interface SeedB2 {
  patientId: string; serviceId: string; vacancyId: string; slotSegId: string; slotQuaId: string | null; hoje: string;
  segWorkers: string[]; segAllocations: string[]; quaWorkers: string[]; quaAllocations: string[]; selecionados: string[];
}

export async function hojeAr(pool: Pool): Promise<string> {
  const d = await pool.query<{ hoje: string }>(
    `SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS hoje`,
  );
  return d.rows[0].hoje;
}

export async function somaDias(pool: Pool, data: string, n: number): Promise<string> {
  const r = await pool.query<{ d: string }>(`SELECT to_char($1::date + $2::int, 'YYYY-MM-DD') AS d`, [data, n]);
  return r.rows[0].d;
}

/** 1º dia da semana `dow` ESTRITAMENTE depois de `hoje`. */
export async function proximoDia(pool: Pool, hoje: string, dow: number): Promise<string> {
  const r = await pool.query<{ d: string }>(
    `SELECT to_char($1::date + (CASE WHEN (($2::int - extract(dow FROM $1::date)::int + 7) % 7) = 0 THEN 7
                                     ELSE (($2::int - extract(dow FROM $1::date)::int + 7) % 7) END), 'YYYY-MM-DD') AS d`,
    [hoje, dow],
  );
  return r.rows[0].d;
}

async function one(pool: Pool, sql: string, params: unknown[]): Promise<string> {
  return (await pool.query<{ id: string }>(sql, params)).rows[0].id;
}

async function novoPrestador(pool: Pool, uid: string, jobId: string): Promise<{ workerId: string; applicationId: string }> {
  const workerId = await one(pool, `INSERT INTO workers (auth_uid, email, country, status, occupation) VALUES ($1, $2, 'AR', 'REGISTERED', 'AT') RETURNING id`, [uid, `${uid}@e2e.local`]);
  const applicationId = await one(pool, `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'manual') RETURNING id`, [workerId, jobId]);
  return { workerId, applicationId };
}

export async function seedB2(pool: Pool, tag: string, opts: SeedB2Opts): Promise<SeedB2> {
  const hoje = await hojeAr(pool);
  const desde = await somaDias(pool, hoje, opts.desdeDias ?? 0);
  const patientId = await one(pool, `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, has_consent, insurance_informed) VALUES ($1, 'Itinerario', 'B2', 'AR', 'ACTIVE', true, 'OSDE') RETURNING id`, [tag]);
  const addressId = await one(pool, `INSERT INTO patient_addresses (patient_id, country, lat, lng) VALUES ($1, 'AR', -34.6, -58.4) RETURNING id`, [patientId]);
  const serviceId = await one(pool, `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, schedule, country, created_by, updated_by) VALUES ($1, 'AT', $2, $3::jsonb, 'AR', $4, $4) RETURNING id`, [patientId, addressId, opts.schedule === 'ONE' ? SCHEDULE_ONE : SCHEDULE_TWO, tag]);
  // providers_needed ANTES das alocações: a Trava A julga o INSERT.
  await pool.query(`UPDATE patient_contracted_services SET providers_needed = $1 WHERE id = $2`, [opts.providersNeeded, serviceId]);
  const mkSlot = (weekday: number) => one(pool, `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by) VALUES ($1, $2, '08:00', 240, '[2026-01-01,)', $3, $3) RETURNING id`, [serviceId, weekday, tag]);
  const slotSegId = await mkSlot(1);
  const slotQuaId = opts.schedule === 'TWO' ? await mkSlot(3) : null;
  const vacancyId = await one(pool, `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`, [`${tag}-vaga`, serviceId, patientId]);
  const out: SeedB2 = { patientId, serviceId, vacancyId, slotSegId, slotQuaId, hoje, segWorkers: [], segAllocations: [], quaWorkers: [], quaAllocations: [], selecionados: [] };
  const titulares = async (slotId: string | null, n: number, p: string, ws: string[], as: string[]): Promise<void> => {
    for (let i = 0; i < n && slotId !== null; i += 1) {
      const w = await novoPrestador(pool, `${tag}-${p}${i}`, vacancyId);
      as.push(await one(pool, `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5) RETURNING id`, [slotId, w.workerId, w.applicationId, desde, tag]));
      ws.push(w.workerId);
    }
  };
  await titulares(slotSegId, opts.titularesSeg, 'seg', out.segWorkers, out.segAllocations);
  await titulares(slotQuaId, opts.titularesQua ?? 0, 'qua', out.quaWorkers, out.quaAllocations);
  for (let i = 0; i < (opts.selecionados ?? 0); i += 1) out.selecionados.push(await novoSelecionado(pool, out, `${tag}-sel${i}`));
  await pool.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, $2, 'AR')`, [patientId, tag]);
  return out;
}

/** 1 prestador + candidatura QUICK_RESPONSE_TEAM (Selecionado), sem alocação; `tag` vira o prefixo do `auth_uid`. */
export async function novoSelecionado(pool: Pool, s: SeedB2, tag: string): Promise<string> {
  return (await novoPrestador(pool, tag, s.vacancyId)).workerId;
}

export async function limparB2(pool: Pool, prefix: string): Promise<void> {
  try {
    const like = [`${prefix}%`];
    const pats = `SELECT id FROM patients WHERE clickup_task_id LIKE $1`;
    const svcs = `SELECT id FROM patient_contracted_services WHERE patient_id IN (${pats})`;
    const slots = `SELECT s.id FROM patient_itinerary_slot s WHERE s.contracted_service_id IN (${svcs})`;
    // O registro de trocas (494) é append-only para a app e sem cascata: o dono do banco o apaga ANTES.
    await pool.query(`DELETE FROM patient_itinerary_change_log WHERE contracted_service_id IN (${svcs})`, like);
    await pool.query(`DELETE FROM contracted_service_rejections WHERE service_id IN (${svcs})`, like);
    await pool.query(`DELETE FROM patient_itinerary_absence WHERE assignment_id IN (SELECT id FROM patient_itinerary_assignment WHERE slot_id IN (${slots}))`, like);
    await pool.query(`DELETE FROM patient_itinerary_assignment WHERE slot_id IN (${slots})`, like);
    await pool.query(`DELETE FROM patient_itinerary_assembly WHERE patient_id IN (${pats})`, like);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`, like);
    await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, like);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, like);
    await pool.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (${svcs})`, like);
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (${pats})`, like);
    await pool.query(`DELETE FROM patient_status_history WHERE patient_id IN (${pats})`, like);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, like);
    const left = await pool.query<{ p: number; w: number; j: number }>(
      `SELECT (SELECT count(*)::int FROM patients WHERE clickup_task_id LIKE $1) AS p,
              (SELECT count(*)::int FROM workers WHERE auth_uid LIKE $1) AS w,
              (SELECT count(*)::int FROM job_postings WHERE title LIKE $1) AS j`,
      like,
    );
    expect(left.rows[0]).toEqual({ p: 0, w: 0, j: 0 });
  } finally {
    await pool.end();
  }
}
