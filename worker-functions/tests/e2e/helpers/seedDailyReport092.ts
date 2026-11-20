/**
 * Massa das e2e do informe da guarda (spec 092, F2). Reaproveita `seedB2` (paciente + serviço + faixa de segunda 08:00-12:00 BA
 * + prestador alocado) e acrescenta: PTI por serviço e itens reais do catálogo da 589. Tudo sintético; nada de texto clínico real.
 */
import type { Pool } from 'pg';
import { seedB2, hojeAr, somaDias, type SeedB2 } from './seedItinerarioB2';

export interface CatalogoItens {
  objAut: string; // AUT (asks_reason "no_lo_hizo")
  objSn: string; // SN
  objCnt: string; // CNT (valor)
  objOm: string; // OM (fora da V1)
  objSemPergunta: string; // legado: sem pergunta/escala
  actSn: string;
  actSemEscala: string; // legado: vira Sí/No
}

async function um(pool: Pool, sql: string): Promise<string> {
  const r = await pool.query<{ id: string }>(sql);
  if (!r.rows[0]) throw new Error(`catálogo sem linha para: ${sql}`);
  return r.rows[0].id;
}

export async function catalogoItens(pool: Pool): Promise<CatalogoItens> {
  const obj = (w: string) => um(pool, `SELECT id FROM therapeutic_specific_objectives WHERE ${w} ORDER BY id LIMIT 1`);
  const act = (w: string) => um(pool, `SELECT id FROM therapeutic_activities WHERE ${w} ORDER BY id LIMIT 1`);
  return {
    objAut: await obj(`daily_scale_code = 'AUT'`),
    objSn: await obj(`daily_scale_code = 'SN'`),
    objCnt: await obj(`daily_scale_code = 'CNT'`),
    objOm: await obj(`daily_scale_code = 'OM'`),
    objSemPergunta: await obj(`daily_scale_code IS NULL`),
    actSn: await act(`daily_scale_code = 'SN'`),
    actSemEscala: await act(`daily_scale_code IS NULL`),
  };
}

export interface PtiOpts {
  patientId: string;
  serviceId: string;
  start: string;
  end: string;
  objectiveIds: string[];
  activityIds: string[];
  major?: number;
  minor?: number;
  createdAt?: string;
  annulled?: boolean;
}

/** Insere uma versão do PTI (formato plano; `specific_objectives`/`activities` = os ids do catálogo). Devolve o id. */
export async function inserirPti(pool: Pool, o: PtiOpts): Promise<string> {
  const snap = (ids: string[]) => JSON.stringify(ids.map((id) => ({ id, label: 'item sintético' })));
  const r = await pool.query<{ id: string }>(
    `INSERT INTO patient_therapeutic_projects
       (patient_id, major, minor, contracted_service_id, diagnoses, clinical_context, general_objective, specific_objectives, activities,
        pathology_types, start_date, end_date, created_by, created_at, annulled_at, annulled_by)
     VALUES ($1, $2, $3, $4, $5, 'contexto sintético', 'objetivo sintético', $6, $7, $8, $9, $10, 'e2e-092', COALESCE($11::timestamptz, now()),
             CASE WHEN $12 THEN now() END, CASE WHEN $12 THEN 'e2e-092' END)
     RETURNING id`,
    [
      o.patientId, o.major ?? 1, o.minor ?? 0, o.serviceId,
      JSON.stringify([{ uri: 'http://id.who.int/icd/entity/1', code: '6A02', title: 'Sintético' }]),
      snap(o.objectiveIds), snap(o.activityIds), JSON.stringify([{ id: 'x', label: 'sintético' }]),
      o.start, o.end, o.createdAt ?? null, o.annulled ?? false,
    ],
  );
  return r.rows[0].id;
}

export interface Guarda extends SeedB2 {
  workerId: string;
  /** Segunda-feira mais recente ESTRITAMENTE antes de hoje (data civil de Buenos Aires). */
  onDate: string;
  authUid: string;
}

/** Segunda-feira mais recente < hoje, deslocada `semanasAtras` semanas para trás. */
export async function segundaAnterior(pool: Pool, hoje: string, semanasAtras = 0): Promise<string> {
  const r = await pool.query<{ d: string }>(
    `SELECT to_char($1::date - (CASE WHEN extract(dow FROM $1::date)::int = 1 THEN 7 ELSE ((extract(dow FROM $1::date)::int + 6) % 7) END) - ($2::int * 7), 'YYYY-MM-DD') AS d`,
    [hoje, semanasAtras],
  );
  return r.rows[0].d;
}

export async function semearGuarda(pool: Pool, tag: string): Promise<Guarda> {
  const s = await seedB2(pool, tag, { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1, desdeDias: -120 });
  const workerId = s.segWorkers[0];
  const hoje = await hojeAr(pool);
  const onDate = await segundaAnterior(pool, hoje);
  return { ...s, workerId, onDate, authUid: `${tag}-seg0` };
}

/** Limpeza pelo pai: apagar o paciente leva serviço, faixa, alocação, PTI e os informes por CASCADE (o purge real). */
export async function limparGuarda(pool: Pool, tag: string): Promise<void> {
  const like = [`${tag}%`];
  const slots = `SELECT s.id FROM patient_itinerary_slot s JOIN patient_contracted_services c ON c.id = s.contracted_service_id
                  JOIN patients p ON p.id = c.patient_id WHERE p.clickup_task_id LIKE $1`;
  await pool.query(`DELETE FROM patient_itinerary_assignment WHERE slot_id IN (${slots})`, like);
  await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id IN (SELECT id FROM job_postings WHERE title LIKE $1)`, like);
  await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, like);
  await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, like);
  await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, like);
}

export { hojeAr, somaDias };
