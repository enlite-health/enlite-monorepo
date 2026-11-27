/**
 * seed-e2e-itinerario-local.ts — variante LOCAL do seed do itinerário (emenda 077 "presença sem furo", T-806-60, P2).
 *
 * `seed-e2e-itinerario-teste.ts` é travado em prd (`assertE2eApiUrl`/`assertE2eDsn`). Este faz o oposto: SÓ aceita banco em `127.0.0.1`/`localhost`
 * (`assertLocalDsn` recusa qualquer outro host ANTES de abrir conexão) e monta, num banco do WF recém-migrado, a massa da jornada ponta a ponta
 * (`e2e/presenca-sem-furo.sh`): 3 prestadoras e 3 pacientes SINTÉTICOS (e-mail `qa.*@enlite.test`), cada um com serviço, faixa, vaga, candidatura e
 * alocação ATIVA; o PTI da prestadora do report; e 1 staff no Acesso Master (o destinatário do alerta).
 *
 * `is_test = false` DE PROPÓSITO nas 3 prestadoras e nos 3 pacientes: o alerta à coordenação DESCARTA `is_test` (D664), então o caso do alerta tem de
 * ser sintético mas NÃO marcado. O que impede qualquer envio real é o canal, não a marca: `NODE_ENV=test` no WF (o `EmailService` recusa com
 * `EmailChannelUnavailableError('ambiente de teste')` → `SKIPPED_TEST`), `SENDGRID_API_KEY` vazia e `api.sendgrid.com` resolvendo para 127.0.0.1.
 *
 * Os 3 turnos (instantes calculados do `now`, nunca por mexer no relógio do sistema; a faixa vive no fuso de BA, UTC-3 fixo):
 *   REPORT   (prestadora 1): terminou há 3 h; serve ao check-in fora do raio (exceção), à saída declarada e ao report diário.
 *   REFUSED  (prestadora 2): a janela inclui "agora − 75 min": a entrada recusada (posição simulada) daquele instante vira o alerta de recusa.
 *   OPEN_4H  (prestadora 3): terminou há 4 h 30; com check-in aceito e sem saída vira o alerta de 4 h.
 *
 * Uso: `npx ts-node scripts/seed-e2e-itinerario-local.ts --dsn postgresql://enlite_admin:…@127.0.0.1:5661/enlite_e2e [--run <sufixo>]`
 * Saída: UM JSON na stdout, só ids/instantes (dado sintético). Idempotente por `--run` (mesmo sufixo = reusa; sufixo novo = massa nova).
 */
import { Pool, type PoolClient } from 'pg';
import { v5 as uuidv5 } from 'uuid';

/** Hosts aceitos: o próprio computador. Qualquer outro (inclusive IP de rede privada, Cloud SQL, proxy de prd) é recusado. */
export const LOCAL_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

export function assertLocalDsn(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('RECUSADO: DSN inválida (não é uma URL)');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error('RECUSADO: o DSN precisa ser postgresql://');
  if (!LOCAL_HOSTS.includes(url.hostname)) throw new Error(`RECUSADO: host "${url.hostname}" fora de ${LOCAL_HOSTS.join(' / ')} — este seed só monta banco LOCAL`);
  return raw;
}

const MIN = 60_000;
const OCCURRENCE_NS = '43876dea-477d-4c5b-8b30-127aa6db3f92'; // o mesmo de WorkerItineraryReader
const ABAC_TENANT = '00000000-0000-0000-0000-000000000001';
const MASTER_GROUP = 'a0000000-0000-0000-0000-000000000001';
/** Ponto sintético (Buenos Aires). O raio de aceite do check-in vem do attendance (200 m). */
export const PATIENT_POINT = { lat: -34.6037, lng: -58.3816 };

export type CaseName = 'REPORT' | 'REFUSED' | 'OPEN_4H';

export interface ShiftPlan {
  case: CaseName;
  startsAt: Date;
  durationMin: number;
}

const floorMin = (d: Date): Date => new Date(Math.floor(d.getTime() / MIN) * MIN);

/** Os 3 turnos a partir do `now`. Pura. */
export function planShifts(now: Date): ShiftPlan[] {
  const n = floorMin(now).getTime();
  return [
    { case: 'REPORT', startsAt: new Date(n - 180 * MIN - 120 * MIN), durationMin: 120 }, // fim = now − 3 h
    { case: 'REFUSED', startsAt: new Date(n - 75 * MIN - 30 * MIN), durationMin: 240 }, // inclui now − 75 min
    { case: 'OPEN_4H', startsAt: new Date(n - 270 * MIN - 60 * MIN), durationMin: 60 }, // fim = now − 4 h 30
  ];
}

const BA = (d: Date): Date => new Date(d.getTime() - 3 * 3600_000); // "relógio de parede" de BA em campos UTC
const p2 = (n: number): string => String(n).padStart(2, '0');
export const dateBA = (d: Date): string => `${BA(d).getUTCFullYear()}-${p2(BA(d).getUTCMonth() + 1)}-${p2(BA(d).getUTCDate())}`;
export const hhmmBA = (d: Date): string => `${p2(BA(d).getUTCHours())}:${p2(BA(d).getUTCMinutes())}`;
export const weekdayBA = (d: Date): number => BA(d).getUTCDay(); // 0 = domingo (a mesma convenção do itinerário)
export const occurrenceIdOf = (slotId: string, onDate: string, workerId: string): string => uuidv5(`${slotId}|${onDate}|${workerId}`, OCCURRENCE_NS);

export interface SeededShift {
  case: CaseName;
  uid: string;
  email: string;
  workerId: string;
  patientId: string;
  serviceId: string;
  slotId: string;
  onDate: string;
  occurrenceId: string;
  startsAt: string;
  endsAt: string;
  ptiVersionId: string | null;
}

export interface SeedResult {
  run: string;
  masterUid: string;
  masterEmail: string;
  shifts: SeededShift[];
  /** Objetivos/atividades do catálogo (o report precisa responder todos). */
  catalog: { objAut: string; objSn: string; objCnt: string; actSn: string };
}

async function one(c: PoolClient, sql: string, params: unknown[] = []): Promise<string> {
  return (await c.query<{ id: string }>(sql, params)).rows[0].id;
}

async function maybe(c: PoolClient, sql: string, params: unknown[] = []): Promise<string | null> {
  return (await c.query<{ id: string }>(sql, params)).rows[0]?.id ?? null;
}

async function seedShift(c: PoolClient, run: string, plan: ShiftPlan, catalog: SeedResult['catalog']): Promise<SeededShift> {
  const tag = `qa806-${run}-${plan.case.toLowerCase()}`;
  const uid = `pr806-${run}-${plan.case.toLowerCase()}`;
  const email = `qa.${plan.case.toLowerCase().replace('_', '')}.${run}@enlite.test`;
  const endsAt = new Date(plan.startsAt.getTime() + plan.durationMin * MIN);
  const onDate = dateBA(plan.startsAt);
  const wd = weekdayBA(plan.startsAt);
  const st = hhmmBA(plan.startsAt);
  const et = hhmmBA(endsAt);
  const sched = JSON.stringify([{ dayOfWeek: wd, startTime: st, endTime: et }]);

  const workerId =
    (await maybe(c, `SELECT id FROM workers WHERE auth_uid = $1`, [uid])) ??
    (await one(c, `INSERT INTO workers (auth_uid, email, country, status, occupation, is_test) VALUES ($1,$2,'AR','REGISTERED','AT',false) RETURNING id`, [uid, email]));
  const existing = await maybe(c, `SELECT id FROM patients WHERE clickup_task_id = $1`, [tag]);
  const patientId = existing ?? (await one(c, `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, has_consent, insurance_informed, is_test) VALUES ($1,'Paciente','Sintetico ${plan.case}','AR','ACTIVE',true,'OSDE',false) RETURNING id`, [tag]));

  let serviceId: string;
  let slotId: string;
  if (existing) {
    serviceId = await one(c, `SELECT id FROM patient_contracted_services WHERE patient_id = $1`, [patientId]);
    slotId = await one(c, `SELECT id FROM patient_itinerary_slot WHERE contracted_service_id = $1`, [serviceId]);
  } else {
    const addr = await one(c, `INSERT INTO patient_addresses (patient_id, country, lat, lng, geocode_quality, address_formatted) VALUES ($1,'AR',$2,$3,'ROOFTOP','Calle Sintetica 123, CABA, Argentina') RETURNING id`, [patientId, PATIENT_POINT.lat, PATIENT_POINT.lng]);
    serviceId = await one(c, `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, schedule, country, created_by, updated_by) VALUES ($1,'AT',$2,$3::jsonb,'AR',$4,$4) RETURNING id`, [patientId, addr, sched, tag]);
    await c.query(`UPDATE patient_contracted_services SET providers_needed = 1 WHERE id = $1`, [serviceId]);
    slotId = await one(c, `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by) VALUES ($1,$2,$3,$4,'[2026-01-01,)',$5,$5) RETURNING id`, [serviceId, wd, st, plan.durationMin, tag]);
    const jobId = await one(c, `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1,$2,$3,'AR') RETURNING id`, [`${tag}-vaga`, serviceId, patientId]);
    const appId = await one(c, `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1,$2,'QUICK_RESPONSE_TEAM','manual') RETURNING id`, [workerId, jobId]);
    await c.query(`INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by) VALUES ($1,$2,$3,'2026-01-01','ACTIVE',$4,$4)`, [slotId, workerId, appId, tag]);
    await c.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1,$2,'AR')`, [patientId, tag]);
  }

  let ptiVersionId: string | null = null;
  if (plan.case === 'REPORT') {
    ptiVersionId = await maybe(c, `SELECT id FROM patient_therapeutic_projects WHERE patient_id = $1`, [patientId]);
    if (!ptiVersionId) {
      const snap = (xs: string[]): string => JSON.stringify(xs.map((id) => ({ id, label: 'item sintético' })));
      ptiVersionId = await one(
        c,
        `INSERT INTO patient_therapeutic_projects (patient_id, major, minor, contracted_service_id, diagnoses, clinical_context, general_objective, specific_objectives, activities, pathology_types, start_date, end_date, created_by)
         VALUES ($1,1,0,$2,$3,'contexto sintético','objetivo sintético',$4,$5,$6,'2026-01-01','2027-12-31','qa806') RETURNING id`,
        [patientId, serviceId, JSON.stringify([{ uri: 'http://id.who.int/icd/entity/1', code: '6A02', title: 'Sintético' }]), snap([catalog.objAut, catalog.objSn, catalog.objCnt]), snap([catalog.actSn]), JSON.stringify([{ id: 'x', label: 'sintético' }])],
      );
    }
  }
  return {
    case: plan.case, uid, email, workerId, patientId, serviceId, slotId, onDate,
    occurrenceId: occurrenceIdOf(slotId, onDate, workerId),
    startsAt: plan.startsAt.toISOString(), endsAt: endsAt.toISOString(), ptiVersionId,
  };
}

/** Staff sintético no Acesso Master: o destinatário garantido do alerta (`iam.is_master_member`). E-mail `.test`: nunca entregável. */
async function seedMaster(c: PoolClient, run: string): Promise<{ uid: string; email: string }> {
  const uid = 'pr806-master'; // fixo: rerodar não acumula destinatários
  const email = 'qa.master.pr806@enlite.test';
  await c.query(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id) VALUES ($1,$2,$3,'recruiter',true,'ACTIVE',$4) ON CONFLICT (firebase_uid) DO NOTHING`,
    [uid, email, `QA master ${run}`, ABAC_TENANT],
  );
  await c.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) SELECT $1::varchar,$2::uuid,$3::uuid WHERE NOT EXISTS (SELECT 1 FROM iam.user_groups WHERE user_id=$1::varchar AND group_id=$2::uuid AND removed_at IS NULL)`, [uid, MASTER_GROUP, ABAC_TENANT]);
  // O Acesso Master de um banco recém-migrado não tem escopo de país (em prd tem): sem ele `actorEffectiveCountries` = [] e o alerta não acha destinatário.
  await c.query(
    `INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) SELECT $1::uuid,'AR',$2::varchar,'e2e local presenca806' WHERE NOT EXISTS (SELECT 1 FROM iam.group_country_scopes WHERE group_id=$1::uuid AND country='AR' AND revoked_at IS NULL)`,
    [MASTER_GROUP, uid],
  );
  return { uid, email };
}

export async function seedLocal(dsn: string, opts: { now?: Date; run?: string } = {}): Promise<SeedResult> {
  assertLocalDsn(dsn);
  const run = opts.run ?? Date.now().toString(36);
  const pool = new Pool({ connectionString: dsn, max: 1 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const catalog = {
      objAut: await one(c, `SELECT id FROM therapeutic_specific_objectives WHERE daily_scale_code='AUT' ORDER BY id LIMIT 1`),
      objSn: await one(c, `SELECT id FROM therapeutic_specific_objectives WHERE daily_scale_code='SN' ORDER BY id LIMIT 1`),
      objCnt: await one(c, `SELECT id FROM therapeutic_specific_objectives WHERE daily_scale_code='CNT' ORDER BY id LIMIT 1`),
      actSn: await one(c, `SELECT id FROM therapeutic_activities WHERE daily_scale_code='SN' ORDER BY id LIMIT 1`),
    };
    const shifts: SeededShift[] = [];
    for (const plan of planShifts(opts.now ?? new Date())) shifts.push(await seedShift(c, run, plan, catalog));
    const master = await seedMaster(c, run);
    await c.query('COMMIT');
    return { run, masterUid: master.uid, masterEmail: master.email, shifts, catalog };
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
    await pool.end();
  }
}

export async function main(argv: string[]): Promise<void> {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dsn = flag('--dsn') ?? process.env.SEED_LOCAL_DSN ?? '';
  assertLocalDsn(dsn); // ANTES de qualquer conexão
  const out = await seedLocal(dsn, { run: flag('--run') });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

/* istanbul ignore next — entrada de CLI */
if (require.main === module) {
  main(process.argv.slice(2)).catch((err: Error) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}
