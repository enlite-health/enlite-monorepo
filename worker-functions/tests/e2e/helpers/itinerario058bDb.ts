/**
 * itinerario058bDb — fixtures de BANCO REAL das suítes `058b-*.e2e.test.ts` (spec 058, Parte B). Sem mock: tudo é SQL.
 * Prefixo `T058B-` no `clickup_task_id` dos pacientes e `T058B_` no `auth_uid` dos workers; `limparB` apaga só o que é seu.
 * ATENÇÃO: o `setup.ts` do e2e roda TRUNCATE CASCADE (workers, job_postings…) uma vez por ARQUIVO de teste, antes do `beforeAll` dele.
 */
import { Pool, PoolClient } from 'pg';
import { emTransacao, emTransacaoRevertida, erroDe, novoPool } from './contrato058aDb';

export { emTransacao, emTransacaoRevertida, erroDe, novoPool };
export type { PgErr } from './contrato058aDb';
export type Db = Pool | PoolClient;

export const PREFIXO_058B = 'T058B';
let seq = 0;
const unico = (): string => (Date.now().toString(36) + (seq++).toString(36)).toUpperCase();

export interface Cenario { patientId: string; serviceId: string; jobId: string; faixas: string[] }
export interface Candidato { workerId: string; applicationId: string }

/** Paciente + serviço (com `providers_needed`; `null` = não informada) + 1 vaga viva + `faixas` faixas (seg, ter, …, 08:00, 240 min). */
export async function criarCenario(db: Db, opts: { country?: 'AR' | 'BR'; providersNeeded?: number | null; faixas?: number } = {}): Promise<Cenario> {
  const country = opts.country ?? 'AR';
  const limite = opts.providersNeeded === undefined ? 2 : opts.providersNeeded;
  const p = await db.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'QA058', 'Paciente QA', $2, 'ACTIVE') RETURNING id`,
    [PREFIXO_058B + '-' + unico(), country]);
  const patientId = p.rows[0].id;
  const s = await db.query<{ id: string }>(
    `INSERT INTO patient_contracted_services (patient_id, service_code, country, providers_needed, created_by, updated_by)
     VALUES ($1, 'CAREGIVER', $2, $3, 'qa058b', 'qa058b') RETURNING id`, [patientId, country, limite]);
  const serviceId = s.rows[0].id;
  const j = await db.query<{ id: string }>(
    `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, $4) RETURNING id`,
    [PREFIXO_058B + '-vaga-' + unico(), serviceId, patientId, country]);
  const faixas: string[] = [];
  for (let i = 0; i < (opts.faixas ?? 2); i++) {
    const f = await db.query<{ id: string }>(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
       VALUES ($1, $2, '08:00', 240, '[2026-01-01,)'::daterange, 'qa058b', 'qa058b') RETURNING id`, [serviceId, i + 1]);
    faixas.push(f.rows[0].id);
  }
  return { patientId, serviceId, jobId: j.rows[0].id, faixas };
}

/** Worker sintético + candidatura à vaga do cenário (a 480 exige que a candidatura seja daquele worker e daquele serviço). */
export async function criarCandidato(db: Db, c: Cenario): Promise<Candidato> {
  const lbl = unico();
  const w = await db.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`, [PREFIXO_058B + '_' + lbl, PREFIXO_058B + '_' + lbl + '@e2e.local']);
  const a = await db.query<{ id: string }>(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
    [w.rows[0].id, c.jobId]);
  return { workerId: w.rows[0].id, applicationId: a.rows[0].id };
}

export async function alocar(db: Db, slotId: string, cand: Candidato, validFrom: string, validTo: string | null = null, status = 'ACTIVE'): Promise<string> {
  const r = await db.query<{ id: string }>(
    `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, status, created_by, updated_by)
     VALUES ($1, $2, $3, $4::date, $5::date, $6, 'qa058b', 'qa058b') RETURNING id`, [slotId, cand.workerId, cand.applicationId, validFrom, validTo, status]);
  return r.rows[0].id;
}

/** "Hoje" do país, pelo banco (a função da 541) — datas dos testes são sempre relativas a ele. */
export async function hojeOp(db: Db, country: 'AR' | 'BR' = 'AR'): Promise<string> {
  return (await db.query<{ d: string }>(`SELECT fn_operation_date($1)::text AS d`, [country])).rows[0].d;
}
export async function mais(db: Db, base: string, dias: number): Promise<string> {
  return (await db.query<{ d: string }>(`SELECT ($1::date + $2::int)::text AS d`, [base, dias])).rows[0].d;
}

/** Liga/desliga a Trava A só quando ela existe (os testes de 542 rodam antes da 543). Use DENTRO de uma transação do teste. SQL sem interpolação (regra 10): dois literais. */
export async function travaA(db: Db, ligada: boolean): Promise<void> {
  const existe = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`, ['trg_058_b_assignment_capacity']);
  if (existe.rows[0].n === 0) return;
  if (ligada) await db.query(`ALTER TABLE patient_itinerary_assignment ENABLE TRIGGER trg_058_b_assignment_capacity`);
  else await db.query(`ALTER TABLE patient_itinerary_assignment DISABLE TRIGGER trg_058_b_assignment_capacity`);
}

/** Apaga só o que as suítes 058b criaram (superusuário do banco de teste: `session_replication_role = replica` desliga os triggers). Tudo parametrizado: $1 = prefixo de paciente, $2 = prefixo de worker. */
export async function limparB(pool: Pool): Promise<void> {
  const pac = PREFIXO_058B + '-%';
  const wrk = PREFIXO_058B + '\\_%';
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(`DELETE FROM patient_itinerary_absence WHERE assignment_id IN (SELECT a.id FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id JOIN patient_contracted_services p ON p.id = s.contracted_service_id JOIN patients t ON t.id = p.patient_id WHERE t.clickup_task_id LIKE $1)`, [pac]);
    await c.query(`DELETE FROM patient_itinerary_assignment WHERE slot_id IN (SELECT s.id FROM patient_itinerary_slot s JOIN patient_contracted_services p ON p.id = s.contracted_service_id JOIN patients t ON t.id = p.patient_id WHERE t.clickup_task_id LIKE $1)`, [pac]);
    await c.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT j.id FROM job_postings j JOIN patients t ON t.id = j.patient_id WHERE t.clickup_task_id LIKE $1)`, [pac]);
    await c.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [pac]);
    await c.query(`DELETE FROM patient_itinerary_slot WHERE contracted_service_id IN (SELECT p.id FROM patient_contracted_services p JOIN patients t ON t.id = p.patient_id WHERE t.clickup_task_id LIKE $1)`, [pac]);
    await c.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [pac]);
    await c.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [pac]);
    await c.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [wrk]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
