/**
 * patient-count-reader-085.e2e.test.ts — change 085 (T109), banco REAL, sem mock.
 *
 * Prova que o `PatientCountReader` conta IGUAL aos donos:
 *  (a) incomplete_registration=true == o "needsAttention" que `PatientQueryRepository.stats` devolve (mesmo recorte);
 *  (b) has_provider=true == pacientes com `countVigenteForService` > 0 em algum serviço; `valid_to` ontem NÃO conta, hoje conta;
 *  (c) ALTA/DISCHARGED nomeado literalmente abre a baja; o atalho (literalValues vazio) não;
 *  (d) incomplete_registration restringe a ADMISSION/PENDING_ADMISSION (+ `restricted_to_admission`), paciente ACTIVE não conta;
 *  (e) RLS: ator de outro país (role app_runtime, sem BYPASSRLS) NÃO vê os pacientes AR; ator AR vê.
 * Massa SINTÉTICA. Esperado por DELTA sobre o baseline (o banco do e2e pode ter pacientes de outros arquivos).
 */
import { Pool } from 'pg';
import { loggingAls } from '@shared/logging';
import { releaseDbSession, type DbSession } from '@shared/database/requestDbSession';
import { withActorContext } from '@shared/database/actorContext';
import { PatientCountReader, type PatientCountRequest } from '../../src/modules/agentes/infrastructure/PatientCountReader';
import { PatientQueryRepository } from '../../src/modules/case/infrastructure/PatientQueryRepository';
import { countVigenteForService } from '../../src/modules/case/infrastructure/VacancyAllocationProbe';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PFX = `pcr-085-${RUN}-`;
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUNTIME_USER = 'pcr085_runtime';
const PASSWORD = 'pcr085_pw';
const STAFF_AR = 'pcr085-staff-ar';
const STAFF_BR = 'pcr085-staff-br';
const COUNTRIES = ['AR'] as never[];

type Seed = { status: string | null; provider?: 'ontem' | 'hoje' | 'aberta' | 'cancelada' | null; country?: string };

describe('PatientCountReader × donos (banco real)', () => {
  let pool: Pool;
  let runtimePool: Pool;
  let reader: PatientCountReader;
  const ids: Record<string, string> = {};
  const workerIds: string[] = [];
  const jobIds: string[] = [];
  const base: Record<string, number> = {};

  const req = (filters: PatientCountRequest['filters'] = [], group_by: string | null = null): PatientCountRequest => ({ filters, group_by });
  const total = async (r: PatientCountRequest) => (await reader.count(r, COUNTRIES)).total;
  const f = (field: string, values: string[], literalValues: string[] = values) => ({ field, values, literalValues });

  const measure = async (): Promise<Record<string, number>> => ({
    incomplete: await total(req([f('incomplete_registration', ['true'])])),
    provider: await total(req([f('has_provider', ['true'])])),
    discharged: await total(req([f('stage', ['DISCHARGED'])])),
    alta: await total(req([f('stage', ['ALTA'])])),
    all: await total(req()),
  });
  const stats = async () => {
    const repo = Object.create(PatientQueryRepository.prototype) as { pool: Pool; stats: PatientQueryRepository['stats'] };
    repo.pool = pool;
    return repo.stats(COUNTRIES, true);
  };

  async function seedPatient(key: string, o: Seed): Promise<void> {
    const pid = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status) VALUES ($1, 'Sintetico', $2, $3, $4) RETURNING id`,
        [`${PFX}${key}`, `Pcr${key}`, o.country ?? 'AR', o.status],
      )
    ).rows[0].id;
    ids[key] = pid;
    if (!o.provider) return;
    const country = o.country ?? 'AR';
    const addr = (await pool.query<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, $2) RETURNING id`, [pid, country])).rows[0].id;
    const svc = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by) VALUES ($1, 'AT', $2, $3, $4, $4) RETURNING id`,
        [pid, addr, country, PFX],
      )
    ).rows[0].id;
    const job = (await pool.query<{ id: string }>(`INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, $4) RETURNING id`, [`${PFX}${key}`, svc, pid, country])).rows[0].id;
    jobIds.push(job);
    const slot = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
         VALUES ($1, 1, '08:00', 240, '[2026-01-01,)'::daterange, $2, $2) RETURNING id`,
        [svc, PFX],
      )
    ).rows[0].id;
    const w = (await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, $3) RETURNING id`, [`${PFX}w-${key}`, `${PFX}w-${key}@e2e.local`, country])).rows[0].id;
    workerIds.push(w);
    const wja = (await pool.query<{ id: string }>(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ($1, $2, 'INVITED', 'import') RETURNING id`, [w, job])).rows[0].id;
    const op = (await pool.query<{ d: string }>(`SELECT fn_operation_date($1)::text AS d`, [country])).rows[0].d;
    const validTo = { ontem: `'${op}'::date - 1`, hoje: `'${op}'::date`, aberta: 'NULL', cancelada: 'NULL' }[o.provider];
    const status = o.provider === 'cancelada' ? 'CANCELLED' : 'ACTIVE';
    await pool.query(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, status, created_by, updated_by)
       VALUES ($1, $2, $3, '2026-01-02', ${validTo}, $4, $5, $5)`,
      [slot, w, wja, status, PFX],
    );
  }

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM patient_itinerary_assignment WHERE created_by = $1`, [PFX]);
    if (jobIds.length) await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [jobIds]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PFX}%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${PFX}%`]);
    await pool.query(`DELETE FROM user_groups WHERE user_id = ANY($1)`, [[STAFF_AR, STAFF_BR]]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1)`, [[STAFF_AR, STAFF_BR]]);
  }

  async function asRequest<T>(context: DbSession['context'], fn: () => Promise<T>): Promise<T> {
    const session: DbSession = { context, released: false };
    try {
      return await loggingAls.run({ traceId: 'pcr085', dbSession: session }, fn);
    } finally {
      await releaseDbSession(session);
    }
  }

  beforeAll(async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    pool = new Pool({ connectionString: DATABASE_URL });
    reader = new PatientCountReader(pool);
    await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${RUNTIME_USER}') THEN CREATE ROLE ${RUNTIME_USER} LOGIN PASSWORD '${PASSWORD}'; END IF; END $$;`);
    await pool.query(`GRANT app_runtime TO ${RUNTIME_USER}`);
    const url = new URL(DATABASE_URL);
    url.username = RUNTIME_USER;
    url.password = PASSWORD;
    runtimePool = new Pool({ connectionString: url.toString(), max: 4 });
    await cleanup();
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, is_active, tenant_id) VALUES ($1, 'pcr085-ar@e2e.test', 'recruiter', true, $3), ($2, 'pcr085-br@e2e.test', 'recruiter', true, $3)`,
      [STAFF_AR, STAFF_BR, TENANT],
    );
    Object.assign(base, await measure());
    base.statsNeeds = (await stats()).needsAttention;


    await seedPatient('admIncompleto', { status: 'ADMISSION' }); // sem dados: incompleto
    await seedPatient('pendIncompleto', { status: 'PENDING_ADMISSION' }); // o funil tem DOIS estágios: `status = 'ADMISSION'` isolado erraria
    await seedPatient('ativo', { status: 'ACTIVE' }); // não é admissão: nunca "incompleto"
    await seedPatient('baja', { status: 'DISCHARGED' });
    await seedPatient('alta', { status: 'ALTA' });
    await seedPatient('semEtapa', { status: null });
    await seedPatient('provOntem', { status: 'ACTIVE', provider: 'ontem' });
    await seedPatient('provHoje', { status: 'ACTIVE', provider: 'hoje' });
    await seedPatient('provAberta', { status: 'ACTIVE', provider: 'aberta' });
    await seedPatient('provCancelada', { status: 'ACTIVE', provider: 'cancelada' });
  });

  afterAll(async () => {
    await cleanup();
    await pool.query(`REVOKE app_runtime FROM ${RUNTIME_USER}`).catch(() => undefined);
    await runtimePool?.end();
    await pool.query(`DROP ROLE IF EXISTS ${RUNTIME_USER}`).catch(() => undefined);
    await pool.end();
    delete process.env.COUNTRY_RLS_ENABLED;
  });

  it('(a) incomplete_registration=true == o needsAttention de PatientQueryRepository.stats no mesmo recorte', async () => {
    const lido = await total(req([f('incomplete_registration', ['true'])]));
    const st = await stats();
    expect(lido - base.incomplete).toBe(2); // admIncompleto + pendIncompleto
    expect(st.needsAttention - base.statsNeeds).toBe(lido - base.incomplete);
  });

  it('(b) has_provider=true == pacientes com countVigenteForService > 0; valid_to ontem não conta, hoje conta', async () => {
    const op = (await pool.query<{ d: string }>(`SELECT fn_operation_date('AR')::text AS d`)).rows[0].d;
    const seeded = ['provOntem', 'provHoje', 'provAberta', 'provCancelada'];
    const vigente: Record<string, boolean> = {};
    for (const k of seeded) {
      const svcs = await pool.query<{ id: string }>(`SELECT id FROM patient_contracted_services WHERE patient_id = $1`, [ids[k]]);
      let n = 0;
      for (const s of svcs.rows) n += await countVigenteForService(pool, s.id, op);
      vigente[k] = n > 0;
    }
    expect(vigente).toEqual({ provOntem: false, provHoje: true, provAberta: true, provCancelada: false });
    expect((await total(req([f('has_provider', ['true'])]))) - base.provider).toBe(2);
    const g = await reader.count(req([f('has_provider', ['true'])]), COUNTRIES);
    expect(g.total).toBe(base.provider + 2);
    // falso complementa: total = true + false
    const falso = await total(req([f('has_provider', ['false'])]));
    expect((await total(req([f('has_provider', ['true'])]))) + falso).toBe(await total(req()));
  });

  it('(b2) a vigência é "hoje do país", não a data do servidor: mesmo resultado com a sessão em fusos que dão CURRENT_DATE = hoje AR e = hoje AR + 1 ou +2', async () => {
    for (const tz of ['America/Argentina/Buenos_Aires', 'Pacific/Kiritimati']) {
      const client = await pool.connect();
      try {
        await client.query(`SET TIME ZONE '${tz}'`);
        const r = await new PatientCountReader(client).count(req([f('has_provider', ['true'])]), COUNTRIES);
        expect(`${tz}:${r.total - base.provider}`).toBe(`${tz}:2`); // provHoje + provAberta; provOntem fora
      } finally {
        client.release();
      }
    }
  });

  it('(c) ALTA/DISCHARGED literal abre a baja; o atalho (sem literal) não', async () => {
    expect((await total(req([f('stage', ['DISCHARGED'])]))) - base.discharged).toBe(1);
    expect((await total(req([f('stage', ['ALTA'])]))) - base.alta).toBe(1);
    // padrão: baja fora do total
    expect((await total(req())) - base.all).toBe(9); // 10 semeados - 1 baja
    // atalho "en atención" expande para todos os clínicos (inclui DISCHARGED) mas literalValues=[] -> baja segue fora
    const clinicos = ['ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'ALTA', 'DISCHARGED'];
    const viaAtalho = await total(req([f('stage', clinicos, [])]));
    const viaLiteral = await total(req([f('stage', clinicos, ['ALTA'])]));
    expect(viaLiteral - viaAtalho).toBe(1);
    // (sin etapa) -> status nulo
    const g = await reader.count(req([], 'stage'), COUNTRIES);
    expect(g.groups!.find((x) => x.key === '(sin etapa)')!.value).toBeGreaterThanOrEqual(1);
    expect(g.total).toBe(g.groups!.reduce((s, x) => s + x.value, 0));
  });

  it('(d) incomplete_registration restringe a admissão e sinaliza; ACTIVE não conta', async () => {
    const r = await reader.count(req([f('incomplete_registration', ['true'])]), COUNTRIES);
    expect(r.restricted_to_admission).toBe(true);
    // paciente ACTIVE nunca é "incompleto", mesmo sem dados
    const comAtivo = await reader.count(req([f('incomplete_registration', ['true']), f('stage', ['ACTIVE'])]), COUNTRIES);
    expect(comAtivo.total).toBe(0);
    // group_by também restringe e a sinalização acompanha
    const g = await reader.count(req([], 'incomplete_registration'), COUNTRIES);
    expect(g.restricted_to_admission).toBe(true);
    expect(g.total).toBe(g.groups!.reduce((s, x) => s + x.value, 0));
    // sem o campo: sem restrição e sem flag
    expect((await reader.count(req(), COUNTRIES)).restricted_to_admission).toBeUndefined();
  });

  it('(e) RLS: ator BR (app_runtime, sem BYPASSRLS) não vê os pacientes AR; ator AR vê', async () => {
    const cnt = (uid: string, country: 'AR' | 'BR') =>
      asRequest({ kind: 'staff', uid, country }, () =>
        withActorContext(runtimePool, (client) => new PatientCountReader(client).count(req([f('stage', ['ACTIVE'])]), COUNTRIES)),
      );
    const br = await cnt(STAFF_BR, 'BR');
    expect(br.total).toBe(0);
    const ar = await cnt(STAFF_AR, 'AR');
    expect(ar.total).toBeGreaterThanOrEqual(5); // ativo + 4 com prestador
  });
});
