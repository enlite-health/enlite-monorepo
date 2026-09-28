/**
 * patient-itinerary-overlap.e2e.test.ts @integration — cadeia-paciente-vacante-itinerario, Fase 11, P3
 *
 * Prova, contra Postgres real, a trava de sobreposição, a folga entre endereços diferentes e o
 * montado escritos na migration 482 (DX-11.2, DX-11.3, DX-11.4, DX-11.14 — parte fora da RLS; os
 * casos de RLS `6i/6j/6k` ficam em `country-rls-policies.test.ts`, P4).
 *
 * Semente (beforeAll, como dono): 2 pacientes AR, 3 endereços (A em patient1, B e C em patient2),
 * 4 serviços — S1(A) e S3(A) em patient1 (mesmo endereço, serviços diferentes — prova que a trava
 * lê o endereço pelo SERVIÇO, não copia), S2(B) e S4(C) em patient2. Cada regra usa um par
 * worker/candidatura PRÓPRIO (a UNIQUE `uq_pia_open_pair` ou a própria trava acusariam cedo demais
 * se o mesmo worker acumulasse alocações de regras diferentes — aprendizado da Fase 7); os slots de
 * referência (`slotA1`/`slotA2`/…) são compartilhados porque a trava e a UNIQUE são sempre
 * filtradas por `worker_id` — dois workers diferentes no mesmo slot nunca colidem entre si.
 */
import { Pool, type PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pio-e2e-${RUN}-`;

interface PgErrorLike {
  code?: string;
  constraint?: string;
  column?: string;
  detail?: string;
  message: string;
}

async function expectPgError(query: Promise<unknown>): Promise<PgErrorLike> {
  let caught: PgErrorLike | null = null;
  try {
    await query;
  } catch (e) {
    caught = e as PgErrorLike;
  }
  if (!caught) {
    throw new Error('esperava erro do Postgres, mas a operação foi aceita');
  }
  return caught;
}

describe('trava de sobreposição, folga entre endereços e montado — migration 482 @integration', () => {
  let pool: Pool;
  let seq = 0;
  const nextLabel = (kind: string): string => `${kind}${++seq}`;

  // semente compartilhada
  let patient1 = '';
  let patient2 = '';
  let addressA = '';
  let addressB = '';
  let addressC = '';
  let serviceS1 = '';
  let serviceS2 = '';
  let serviceS3 = '';
  let serviceS4 = '';
  let jobS1 = '';
  let jobS2 = '';
  let jobS3 = '';
  let jobS4 = '';

  // slots de referência, reusados entre regras (worker novo em cada regra)
  let slotA1 = ''; // S1, seg, 08:00-12:00 (endereço A)
  let slotA2 = ''; // S1, seg, 10:00-14:00 (endereço A — sobrepõe slotA1)
  let slotA3 = ''; // S1, ter, 08:00-12:00 (endereço A — outro dia da semana)
  let slotA_S3 = ''; // S3, seg, 12:00-16:00 (endereço A, serviço diferente)
  let slotB1 = ''; // S2, seg, 12:00-16:00 (endereço B — adjacente, sem folga)
  let slotB2 = ''; // S2, seg, 12:30-16:00 (endereço B — folga de 30min)
  let slotC1 = ''; // S4, seg, 13:00-16:00 (endereço C — folga de exatos 60min)
  let slotImmutable = ''; // S1, sex, 08:00-09:00 (dedicado — nunca alocado)

  const jobIds: string[] = [];

  async function mkWorkerWithWja(jobId: string, label: string): Promise<{ workerId: string; wjaId: string }> {
    const lbl = nextLabel(label);
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}${lbl}`, `${TASK_PREFIX}${lbl}@e2e.local`],
      )
    ).rows[0].id;
    const wjaId = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobId],
      )
    ).rows[0].id;
    return { workerId, wjaId };
  }

  function insertAssignment(
    slotId: string,
    workerId: string,
    wjaId: string,
    validFrom: string,
    opts: { validTo?: string | null; status?: string } = {},
  ) {
    return pool.query<{ id: string; country: string }>(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id, country`,
      [slotId, workerId, wjaId, validFrom, opts.validTo ?? null, opts.status ?? 'ACTIVE', TASK_PREFIX],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    patient1 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'Trava1', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p1`],
      )
    ).rows[0].id;
    patient2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'Trava2', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p2`],
      )
    ).rows[0].id;

    addressA = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patient1],
      )
    ).rows[0].id;
    addressB = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patient2],
      )
    ).rows[0].id;
    addressC = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patient2],
      )
    ).rows[0].id;

    const mkService = async (patientId: string, addressId: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
           VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
          [patientId, addressId, TASK_PREFIX],
        )
      ).rows[0].id;

    serviceS1 = await mkService(patient1, addressA);
    serviceS2 = await mkService(patient2, addressB);
    serviceS3 = await mkService(patient1, addressA);
    serviceS4 = await mkService(patient2, addressC);

    const mkJob = async (serviceId: string, patientId: string, label: string) => {
      const id = (
        await pool.query<{ id: string }>(
          `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
          [`${TASK_PREFIX}${label}`, serviceId, patientId],
        )
      ).rows[0].id;
      jobIds.push(id);
      return id;
    };

    jobS1 = await mkJob(serviceS1, patient1, 'vagaS1');
    jobS2 = await mkJob(serviceS2, patient2, 'vagaS2');
    jobS3 = await mkJob(serviceS3, patient1, 'vagaS3');
    jobS4 = await mkJob(serviceS4, patient2, 'vagaS4');

    const mkSlot = async (serviceId: string, weekday: number, start: string, end: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
          [serviceId, weekday, start, end, TASK_PREFIX],
        )
      ).rows[0].id;

    slotA1 = await mkSlot(serviceS1, 1, '08:00', '12:00');
    slotA2 = await mkSlot(serviceS1, 1, '10:00', '14:00');
    slotA3 = await mkSlot(serviceS1, 2, '08:00', '12:00');
    slotA_S3 = await mkSlot(serviceS3, 1, '12:00', '16:00');
    slotB1 = await mkSlot(serviceS2, 1, '12:00', '16:00');
    slotB2 = await mkSlot(serviceS2, 1, '12:30', '16:00');
    slotC1 = await mkSlot(serviceS4, 1, '13:00', '16:00');
    slotImmutable = await mkSlot(serviceS1, 5, '08:00', '09:00');
  });

  afterAll(async () => {
    // alocações → WJA (via job_postings) → vagas → serviços/montado (cascata do DELETE dos
    // pacientes) → workers → pacientes; contando 0 linhas do RUN no fim.
    // A alocação sai PRIMEIRO e explícita: `patient_itinerary_assignment.application_id` é
    // RESTRICT contra `worker_job_applications` — apagar `job_postings` (que cascateia a WJA)
    // antes de tirar a alocação do caminho falharia com FK violation.
    await pool.query(`DELETE FROM patient_itinerary_assignment WHERE created_by = $1`, [TASK_PREFIX]);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [jobIds]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${TASK_PREFIX}%`]);

    const leftoverPatients = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patients WHERE clickup_task_id LIKE $1`,
      [`${TASK_PREFIX}%`],
    );
    const leftoverWorkers = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM workers WHERE auth_uid LIKE $1`,
      [`${TASK_PREFIX}%`],
    );
    const leftoverAssembly = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_itinerary_assembly WHERE assembled_by = $1`,
      [TASK_PREFIX],
    );
    try {
      if (leftoverPatients.rows[0].n !== 0 || leftoverWorkers.rows[0].n !== 0 || leftoverAssembly.rows[0].n !== 0) {
        throw new Error(
          `limpeza incompleta do RUN ${RUN}: patients=${leftoverPatients.rows[0].n} workers=${leftoverWorkers.rows[0].n} assembly=${leftoverAssembly.rows[0].n}`,
        );
      }
    } finally {
      await pool.end();
    }
  });

  it('a função da folga devolve 60', async () => {
    const r = await pool.query<{ gap: number }>(`SELECT itinerary_min_gap_minutes() AS gap`);
    expect(r.rows[0].gap).toBe(60);
  });

  it('mesmo endereço, 08-12 e 10-14 sobrepostos → 23P01', async () => {
    const { workerId, wjaId } = await mkWorkerWithWja(jobS1, 'w-mesmo-endereco-sobrepoe');
    await insertAssignment(slotA1, workerId, wjaId, '2026-01-01');
    const err = await expectPgError(insertAssignment(slotA2, workerId, wjaId, '2026-01-01'));
    expect(err.code).toBe('23P01');
  });

  it('mesmo endereço, 08-12 e 12-16 em outro serviço (S3) → aceita', async () => {
    const { workerId, wjaId: wjaS1 } = await mkWorkerWithWja(jobS1, 'w-mesmo-endereco-toca');
    await insertAssignment(slotA1, workerId, wjaS1, '2026-01-01');
    const wjaS3 = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobS3],
      )
    ).rows[0].id;
    const r = await insertAssignment(slotA_S3, workerId, wjaS3, '2026-01-01');
    expect(r.rows[0].id).toBeTruthy();
  });

  it('endereços diferentes, 08-12 e 12-16 (adjacente, sem folga) → 23P01', async () => {
    const { workerId, wjaId: wjaS1 } = await mkWorkerWithWja(jobS1, 'w-dif-endereco-adjacente');
    await insertAssignment(slotA1, workerId, wjaS1, '2026-01-01');
    const wjaS2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobS2],
      )
    ).rows[0].id;
    const err = await expectPgError(insertAssignment(slotB1, workerId, wjaS2, '2026-01-01'));
    expect(err.code).toBe('23P01');
  });

  it('endereços diferentes, 08-12 e 12:30-16 (folga de 30min, menor que a mínima) → 23P01 com DETAIL.minGapMinutes=60', async () => {
    const { workerId, wjaId: wjaS1 } = await mkWorkerWithWja(jobS1, 'w-dif-endereco-folga-curta');
    await insertAssignment(slotA1, workerId, wjaS1, '2026-01-01');
    const wjaS2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobS2],
      )
    ).rows[0].id;
    const err = await expectPgError(insertAssignment(slotB2, workerId, wjaS2, '2026-01-01'));
    expect(err.code).toBe('23P01');
    expect(err.detail).toBeTruthy();
    const detail = JSON.parse(err.detail as string) as Record<string, unknown>;
    expect(detail.minGapMinutes).toBe(60);
    expect(detail.sameAddress).toBe(false);
  });

  it('endereços diferentes, 08-12 e 13-16 (folga de exatos 60min) → aceita', async () => {
    const { workerId, wjaId: wjaS1 } = await mkWorkerWithWja(jobS1, 'w-dif-endereco-folga-exata');
    await insertAssignment(slotA1, workerId, wjaS1, '2026-01-01');
    const wjaS4 = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobS4],
      )
    ).rows[0].id;
    const r = await insertAssignment(slotC1, workerId, wjaS4, '2026-01-01');
    expect(r.rows[0].id).toBeTruthy();
  });

  it('mesmo horário, dia da semana diferente → aceita', async () => {
    const { workerId, wjaId } = await mkWorkerWithWja(jobS1, 'w-outro-dia');
    await insertAssignment(slotA1, workerId, wjaId, '2026-01-01');
    const r = await insertAssignment(slotA3, workerId, wjaId, '2026-01-01');
    expect(r.rows[0].id).toBeTruthy();
  });

  it('a alocação existente ENCERRADA (ENDED) não bloqueia → aceita', async () => {
    const { workerId, wjaId } = await mkWorkerWithWja(jobS1, 'w-existente-ended');
    await insertAssignment(slotA1, workerId, wjaId, '2026-01-01', { validTo: '2026-01-15', status: 'ENDED' });
    const r = await insertAssignment(slotA2, workerId, wjaId, '2026-01-01');
    expect(r.rows[0].id).toBeTruthy();
  });

  it('datas disjuntas (a existente termina antes da nova começar) → aceita', async () => {
    const { workerId, wjaId } = await mkWorkerWithWja(jobS1, 'w-datas-disjuntas');
    await insertAssignment(slotA1, workerId, wjaId, '2026-01-01', { validTo: '2026-01-31' });
    const r = await insertAssignment(slotA2, workerId, wjaId, '2026-03-01');
    expect(r.rows[0].id).toBeTruthy();
  });

  it('UPDATE de CANCELLED para ACTIVE que sobrepõe uma alocação viva → 23P01', async () => {
    const { workerId, wjaId } = await mkWorkerWithWja(jobS1, 'w-update-cancelled');
    await insertAssignment(slotA1, workerId, wjaId, '2026-01-01');
    const cancelled = await insertAssignment(slotA2, workerId, wjaId, '2026-01-01', { status: 'CANCELLED' });
    const err = await expectPgError(
      pool.query(`UPDATE patient_itinerary_assignment SET status = 'ACTIVE' WHERE id = $1`, [cancelled.rows[0].id]),
    );
    expect(err.code).toBe('23P01');
  });

  it('2ª alocação aberta do mesmo worker no mesmo slot → 23505 uq_pia_open_pair (deferência)', async () => {
    const { workerId, wjaId } = await mkWorkerWithWja(jobS1, 'w-open-pair');
    await insertAssignment(slotA1, workerId, wjaId, '2026-01-01');
    const err = await expectPgError(insertAssignment(slotA1, workerId, wjaId, '2026-02-01'));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('uq_pia_open_pair');
  });

  it('valid_to < valid_from → 23514 pia_valid_range (deferência)', async () => {
    const { workerId, wjaId } = await mkWorkerWithWja(jobS1, 'w-valid-range');
    const err = await expectPgError(
      insertAssignment(slotA1, workerId, wjaId, '2026-01-10', { validTo: '2026-01-01' }),
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('pia_valid_range');
  });

  it('o DETAIL do erro não tem chave de dado pessoal/clínico', async () => {
    const { workerId, wjaId: wjaS1 } = await mkWorkerWithWja(jobS1, 'w-detail-sem-pii');
    await insertAssignment(slotA1, workerId, wjaS1, '2026-01-01');
    const wjaS2 = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobS2],
      )
    ).rows[0].id;
    const err = await expectPgError(insertAssignment(slotB2, workerId, wjaS2, '2026-01-01'));
    expect(err.code).toBe('23P01');
    const detail = JSON.parse(err.detail as string) as Record<string, unknown>;
    // a régua do critério (DX-11.3/DX-11.14) é sobre CONTEÚDO vazado, não sobre o nome de uma
    // flag booleana como `sameAddress` (que também casa a palavra "address" sem carregar dado
    // nenhum de endereço). Uma chave só é ofensora se casar o padrão E o valor for texto — o
    // formato que uma PII/endereço real assumiria; ids, horários (HH:MM) e booleanos não caem aqui.
    const offendingKeys = Object.keys(detail).filter(
      (k) => /name|phone|email|address|diagnos|clinic/i.test(k) && typeof detail[k] === 'string',
    );
    expect(offendingKeys).toEqual([]);
  });

  it('concorrência: a 2ª transação só decide depois do COMMIT da 1ª, e perde', async () => {
    const { workerId, wjaId } = await mkWorkerWithWja(jobS1, 'w-concorrencia');

    const c1: PoolClient = await pool.connect();
    const c2: PoolClient = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');

      await c1.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-01-01', 'ACTIVE', $4, $4)`,
        [slotA1, workerId, wjaId, TASK_PREFIX],
      );

      const p2 = c2.query(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
         VALUES ($1, $2, $3, '2026-01-01', 'ACTIVE', $4, $4)`,
        [slotA2, workerId, wjaId, TASK_PREFIX],
      );

      // dá tempo do 2º realmente entrar na fila do advisory lock antes do COMMIT do 1º.
      await c1.query('SELECT pg_sleep(0.3)');
      await c1.query('COMMIT');

      await expect(p2).rejects.toMatchObject({ code: '23P01' });
      await c2.query('ROLLBACK');
    } finally {
      c1.release();
      c2.release();
    }

    const active = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_itinerary_assignment WHERE worker_id = $1 AND status = 'ACTIVE'`,
      [workerId],
    );
    expect(active.rows[0].n).toBe(1);
  });

  it('UPDATE da chave do slot (start_time) → 23514 pis_chave_imutavel; UPDATE de active → aceita', async () => {
    const err = await expectPgError(
      pool.query(`UPDATE patient_itinerary_slot SET start_time = '07:00' WHERE id = $1`, [slotImmutable]),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('pis_chave_imutavel');

    const r = await pool.query(`UPDATE patient_itinerary_slot SET active = false WHERE id = $1 RETURNING active`, [
      slotImmutable,
    ]);
    expect(r.rows[0].active).toBe(false);
  });

  it('patient_itinerary_assembly: country herdado; grants só SELECT/INSERT; sem coluna de texto livre', async () => {
    const inserted = await pool.query<{ id: string; country: string }>(
      `INSERT INTO patient_itinerary_assembly (patient_id, assembled_by) VALUES ($1, $2) RETURNING id, country`,
      [patient1, TASK_PREFIX],
    );
    expect(inserted.rows[0].country).toBe('AR');

    const grants = await pool.query<{
      can_insert: boolean;
      can_select: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT
         has_table_privilege('app_runtime', 'patient_itinerary_assembly', 'INSERT') AS can_insert,
         has_table_privilege('app_runtime', 'patient_itinerary_assembly', 'SELECT') AS can_select,
         has_table_privilege('app_runtime', 'patient_itinerary_assembly', 'UPDATE') AS can_update,
         has_table_privilege('app_runtime', 'patient_itinerary_assembly', 'DELETE') AS can_delete`,
    );
    expect(grants.rows[0].can_insert).toBe(true);
    expect(grants.rows[0].can_select).toBe(true);
    expect(grants.rows[0].can_update).toBe(false);
    expect(grants.rows[0].can_delete).toBe(false);

    const textColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'patient_itinerary_assembly' AND data_type IN ('text', 'character varying')
       ORDER BY column_name`,
    );
    expect(textColumns.rows.map((r) => r.column_name)).toEqual(['assembled_by', 'country']);
  });

  it('purga do paciente: a alocação e a vaga saem primeiro (RESTRICT); o paciente leva serviço, slot e montado em cascata', async () => {
    const patientCascade = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Itinerario', 'Cascata', 'AR', 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}p-cascata`],
      )
    ).rows[0].id;
    const addressCascade = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patientCascade],
      )
    ).rows[0].id;
    const serviceCascade = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patientCascade, addressCascade, TASK_PREFIX],
      )
    ).rows[0].id;
    const jobCascade = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${TASK_PREFIX}vagaCascata`, serviceCascade, patientCascade],
      )
    ).rows[0].id;
    const slotCascade = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
         VALUES ($1, 4, '08:00', '09:00', $2, $2) RETURNING id`,
        [serviceCascade, TASK_PREFIX],
      )
    ).rows[0].id;
    const { workerId: workerCascade, wjaId: wjaCascade } = await mkWorkerWithWja(jobCascade, 'w-cascata');
    const assignmentCascade = (await insertAssignment(slotCascade, workerCascade, wjaCascade, '2026-01-01')).rows[0]
      .id;
    await pool.query(`INSERT INTO patient_itinerary_assembly (patient_id, assembled_by) VALUES ($1, $2)`, [
      patientCascade,
      TASK_PREFIX,
    ]);

    // Ordem real de purga (D248): `patient_itinerary_assignment.application_id` é RESTRICT contra
    // `worker_job_applications` — a alocação sai primeiro. `job_postings` referencia `patients` sem
    // cascata (NO ACTION) — sai depois (e leva a WJA, agora liberada). SÓ ENTÃO o paciente, que
    // leva serviço/slot/montado em cascata de verdade (nenhuma dessas três tabelas tem RESTRICT
    // pela frente).
    await pool.query(`DELETE FROM patient_itinerary_assignment WHERE id = $1`, [assignmentCascade]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobCascade]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientCascade]);

    const counts = await pool.query<{ assembly: number; slot: number; service: number }>(
      `SELECT
         (SELECT count(*)::int FROM patient_itinerary_assembly WHERE patient_id = $1) AS assembly,
         (SELECT count(*)::int FROM patient_itinerary_slot WHERE id = $2) AS slot,
         (SELECT count(*)::int FROM patient_contracted_services WHERE id = $3) AS service`,
      [patientCascade, slotCascade, serviceCascade],
    );
    expect(counts.rows[0].assembly).toBe(0);
    expect(counts.rows[0].slot).toBe(0);
    expect(counts.rows[0].service).toBe(0);

    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerCascade]);
  });
});
