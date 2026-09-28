/**
 * patient-itinerary-absence.e2e.test.ts @integration — cadeia-paciente-vacante-itinerario, Fase 13, P4
 *
 * Prova, contra Postgres real, a tabela `patient_itinerary_absence`, a validação
 * (`fn_patient_itinerary_absence_validate`) e a trava por data (`itinerary_worker_conflict`,
 * `fn_patient_itinerary_assignment_no_overlap`, `fn_patient_itinerary_absence_no_overlap`) da
 * migration 484 (DX-13.1, DX-13.2 — parte fora da RLS; os casos de RLS `6l/6m/6n` ficam em
 * `country-rls-policies.test.ts`, P5).
 *
 * Semente (beforeAll, como dono): 3 pacientes AR (endereços X, Y, Z), 1 serviço por endereço
 * (serviceX/Y/Z), 1 vaga por serviço (jobX/Y/Z). Slot Z (segunda 08-09) é reusado como referência
 * para as regras de VALIDAÇÃO pura (não testam sobreposição). Os slots de X/Y são as referências da
 * trava por data (cada regra usa um par worker/candidatura PRÓPRIO — a UNIQUE `uq_piab_open` ou a
 * própria trava acusariam cedo demais se o mesmo worker acumulasse ausências de regras diferentes —
 * aprendizado da Fase 7).
 */
import { Pool, type PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `pia-e2e-${RUN}-`;

const SEGUNDA = 1;
const TERCA = 2;

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

describe('ausência, validação e trava por data — migration 484 @integration', () => {
  let pool: Pool;
  let seq = 0;
  const nextLabel = (kind: string): string => `${kind}${++seq}`;

  // semente compartilhada
  let patientX = '';
  let patientY = '';
  let patientZ = '';
  let serviceX = '';
  let serviceY = '';
  let serviceZ = '';
  let jobX = '';
  let jobY = '';
  let jobZ = '';

  // referências de VALIDAÇÃO (não testam sobreposição)
  let slotZBase = ''; // Z, seg, 08:00-09:00

  // referências da TRAVA POR DATA
  let slotBaseX = ''; // X, seg, 08:00-12:00 (o "semanal" do substituto)
  let slotX1216 = ''; // X, seg, 12:00-16:00 (mesmo endereço X, toca)
  let slotY1014 = ''; // Y, seg, 10:00-14:00
  let slotY12301600 = ''; // Y, seg, 12:30-16:00
  let slotY13001600 = ''; // Y, seg, 13:00-16:00
  let slotYter0812 = ''; // Y, terça, 08:00-12:00
  let slotCrossA = ''; // X, seg, 08:00-09:00
  let slotCrossB = ''; // Y, seg, 08:30-09:30

  // datas (DATA-F13 — sempre do banco, nunca do relógio do runner)
  let nextMonday = '';
  let nextTuesday = '';
  let pastMonday = '';

  const jobIds: string[] = [];

  async function nextWeekday(dow: number, direction: 'future' | 'past'): Promise<string> {
    const series =
      direction === 'future' ? `x.t + 1, x.t + 7, interval '1 day'` : `x.t - 7, x.t - 1, interval '1 day'`;
    const r = await pool.query<{ d: string }>(
      `SELECT to_char(g::date,'YYYY-MM-DD') AS d
         FROM (SELECT (now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date AS t) x,
              generate_series(${series}) g
        WHERE extract(dow FROM g) = $1`,
      [dow],
    );
    expect(r.rows).toHaveLength(1);
    return r.rows[0].d;
  }

  async function mkWorkerWithWja(jobId: string, label: string): Promise<{ workerId: string; wjaId: string }> {
    const lbl = nextLabel(label);
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`,
        [`${TASK_PREFIX}${lbl}`, `${TASK_PREFIX}${lbl}@e2e.local`],
      )
    ).rows[0].id;
    const wjaId = await addWja(workerId, jobId);
    return { workerId, wjaId };
  }

  async function addWja(workerId: string, jobId: string): Promise<string> {
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'INVITED', 'import') RETURNING id`,
        [workerId, jobId],
      )
    ).rows[0].id;
  }

  function insertAssignment(
    slotId: string,
    workerId: string,
    wjaId: string,
    validFrom: string,
    opts: { validTo?: string | null; status?: string } = {},
  ) {
    return pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, valid_to, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [slotId, workerId, wjaId, validFrom, opts.validTo ?? null, opts.status ?? 'ACTIVE', TASK_PREFIX],
    );
  }

  function insertAbsence(
    assignmentId: string,
    onDate: string,
    opts: {
      substituteWorkerId?: string | null;
      substituteApplicationId?: string | null;
      createdBy?: string;
    } = {},
  ) {
    const createdBy = opts.createdBy ?? TASK_PREFIX;
    return pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_absence
         (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
      [assignmentId, onDate, opts.substituteWorkerId ?? null, opts.substituteApplicationId ?? null, createdBy],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    nextMonday = await nextWeekday(SEGUNDA, 'future');
    nextTuesday = await nextWeekday(TERCA, 'future');
    pastMonday = await nextWeekday(SEGUNDA, 'past');

    const mkPatient = async (label: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
           VALUES ($1, 'Ausencia', $2, 'AR', 'ACTIVE') RETURNING id`,
          [`${TASK_PREFIX}${label}`, label],
        )
      ).rows[0].id;

    patientX = await mkPatient('px');
    patientY = await mkPatient('py');
    patientZ = await mkPatient('pz');

    const mkAddress = async (patientId: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
          [patientId],
        )
      ).rows[0].id;

    const addressX = await mkAddress(patientX);
    const addressY = await mkAddress(patientY);
    const addressZ = await mkAddress(patientZ);

    const mkService = async (patientId: string, addressId: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
           VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
          [patientId, addressId, TASK_PREFIX],
        )
      ).rows[0].id;

    serviceX = await mkService(patientX, addressX);
    serviceY = await mkService(patientY, addressY);
    serviceZ = await mkService(patientZ, addressZ);

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

    jobX = await mkJob(serviceX, patientX, 'vagaX');
    jobY = await mkJob(serviceY, patientY, 'vagaY');
    jobZ = await mkJob(serviceZ, patientZ, 'vagaZ');

    const mkSlot = async (serviceId: string, weekday: number, start: string, end: string) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
          [serviceId, weekday, start, end, TASK_PREFIX],
        )
      ).rows[0].id;

    slotZBase = await mkSlot(serviceZ, SEGUNDA, '08:00', '09:00');

    slotBaseX = await mkSlot(serviceX, SEGUNDA, '08:00', '12:00');
    slotX1216 = await mkSlot(serviceX, SEGUNDA, '12:00', '16:00');
    slotY1014 = await mkSlot(serviceY, SEGUNDA, '10:00', '14:00');
    slotY12301600 = await mkSlot(serviceY, SEGUNDA, '12:30', '16:00');
    slotY13001600 = await mkSlot(serviceY, SEGUNDA, '13:00', '16:00');
    slotYter0812 = await mkSlot(serviceY, TERCA, '08:00', '12:00');
    slotCrossA = await mkSlot(serviceX, SEGUNDA, '08:00', '09:00');
    slotCrossB = await mkSlot(serviceY, SEGUNDA, '08:30', '09:30');
  });

  afterAll(async () => {
    // ausências → alocações → WJA → vagas → serviços (cascata do slot) → workers → pacientes,
    // contando 0 linhas do RUN no fim. `patient_itinerary_assignment.application_id` é RESTRICT
    // contra `worker_job_applications` — a alocação sai ANTES da WJA (mesma razão da Fase 11).
    await pool.query(`DELETE FROM patient_itinerary_absence WHERE created_by LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.query(`DELETE FROM patient_itinerary_assignment WHERE created_by = $1`, [TASK_PREFIX]);
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1::uuid[])`, [jobIds]);
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
    const leftoverAbsences = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_itinerary_absence WHERE created_by LIKE $1`,
      [`${TASK_PREFIX}%`],
    );
    try {
      if (leftoverPatients.rows[0].n !== 0 || leftoverWorkers.rows[0].n !== 0 || leftoverAbsences.rows[0].n !== 0) {
        throw new Error(
          `limpeza incompleta do RUN ${RUN}: patients=${leftoverPatients.rows[0].n} workers=${leftoverWorkers.rows[0].n} absences=${leftoverAbsences.rows[0].n}`,
        );
      }
    } finally {
      await pool.end();
    }
  });

  // ── [13.1] schema: FKs, CHECKs, colunas de texto ────────────────────────────────────────
  it('[13.1] information_schema: FK para assignment e WJA, ≥2 CHECK, colunas de texto = as 4', async () => {
    console.log('[13.1]', 'schema patient_itinerary_absence');
    const fks = await pool.query<{ table_name: string }>(
      `SELECT ccu.table_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
        WHERE tc.table_name = 'patient_itinerary_absence' AND tc.constraint_type = 'FOREIGN KEY'
        ORDER BY 1`,
    );
    expect(fks.rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining(['patient_itinerary_assignment', 'worker_job_applications']),
    );

    const checks = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conrelid = 'patient_itinerary_absence'::regclass AND contype = 'c'`,
    );
    expect(checks.rows[0].n).toBeGreaterThanOrEqual(2);

    const textColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'patient_itinerary_absence' AND data_type IN ('text', 'character varying')
        ORDER BY column_name`,
    );
    expect(textColumns.rows.map((r) => r.column_name)).toEqual(['cancelled_by', 'country', 'created_by', 'updated_by']);
  });

  // ── invariante 5: substituto e candidatura nascem/morrem juntos ─────────────────────────
  it('[13.2] substituto sem candidatura → 23514 piab_substitute_pair', async () => {
    console.log('[13.2]', 'piab_substitute_pair');
    const { workerId, wjaId } = await mkWorkerWithWja(jobZ, 'w-2a-titular');
    const assignment = (await insertAssignment(slotZBase, workerId, wjaId, '2026-01-01')).rows[0].id;
    const substitute = await mkWorkerWithWja(jobZ, 'w-2a-sub');
    const err = await expectPgError(insertAbsence(assignment, nextMonday, { substituteWorkerId: substitute.workerId }));
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_substitute_pair');
  });

  it('[13.3] substituto e candidatura, os dois presentes → aceita', async () => {
    console.log('[13.3]', 'piab_substitute_pair aceita');
    const titular = await mkWorkerWithWja(jobZ, 'w-2b-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const substitute = await mkWorkerWithWja(jobZ, 'w-2b-sub');
    const r = await insertAbsence(assignment, nextMonday, {
      substituteWorkerId: substitute.workerId,
      substituteApplicationId: substitute.wjaId,
    });
    expect(r.rows[0].id).toBeTruthy();
  });

  // ── candidatura de outro worker / outra vaga ─────────────────────────────────────────────
  it('[13.4] candidatura de outro prestador → 23514 piab_candidatura_de_outro_prestador', async () => {
    console.log('[13.4]', 'piab_candidatura_de_outro_prestador');
    const titular = await mkWorkerWithWja(jobZ, 'w-3-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const substitute = await mkWorkerWithWja(jobZ, 'w-3-sub');
    const otherWorker = await mkWorkerWithWja(jobZ, 'w-3-outro');
    const err = await expectPgError(
      insertAbsence(assignment, nextMonday, {
        substituteWorkerId: substitute.workerId,
        substituteApplicationId: otherWorker.wjaId, // candidatura é do OUTRO worker
      }),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_candidatura_de_outro_prestador');
  });

  it('[13.5] candidatura de outra vaga → 23514 piab_candidatura_de_outra_vaga', async () => {
    console.log('[13.5]', 'piab_candidatura_de_outra_vaga');
    const titular = await mkWorkerWithWja(jobZ, 'w-4-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    // candidatura do MESMO worker, mas para a vaga X (outro serviço) — não a Z do slot.
    const substitute = await mkWorkerWithWja(jobX, 'w-4-sub');
    const err = await expectPgError(
      insertAbsence(assignment, nextMonday, {
        substituteWorkerId: substitute.workerId,
        substituteApplicationId: substitute.wjaId,
      }),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_candidatura_de_outra_vaga');
  });

  it('[13.6] substituto é o próprio titular → 23514 piab_substituto_e_o_titular', async () => {
    console.log('[13.6]', 'piab_substituto_e_o_titular');
    const titular = await mkWorkerWithWja(jobZ, 'w-5-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const err = await expectPgError(
      insertAbsence(assignment, nextMonday, {
        substituteWorkerId: titular.workerId,
        substituteApplicationId: titular.wjaId,
      }),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_substituto_e_o_titular');
  });

  // ── dia da semana / vigência ──────────────────────────────────────────────────────────────
  it('[13.7] dia da semana errado → 23514 piab_dia_da_semana', async () => {
    console.log('[13.7]', 'piab_dia_da_semana');
    const titular = await mkWorkerWithWja(jobZ, 'w-6-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    // slotZBase é SEGUNDA; nextTuesday é TERÇA.
    const err = await expectPgError(insertAbsence(assignment, nextTuesday));
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_dia_da_semana');
  });

  it('[13.8] data fora da vigência (antes de valid_from) → 23514 piab_fora_da_vigencia', async () => {
    console.log('[13.8]', 'piab_fora_da_vigencia — fora da vigência');
    const titular = await mkWorkerWithWja(jobZ, 'w-7-titular');
    const assignment = (
      await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2027-01-01' /* futuro */)
    ).rows[0].id;
    const err = await expectPgError(insertAbsence(assignment, nextMonday));
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_fora_da_vigencia');
  });

  it('[13.9] alocação ENDED → 23514 piab_fora_da_vigencia', async () => {
    console.log('[13.9]', 'piab_fora_da_vigencia — ENDED');
    const titular = await mkWorkerWithWja(jobZ, 'w-8-titular');
    const assignment = (
      await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01', {
        status: 'ENDED',
        validTo: '2026-12-31',
      })
    ).rows[0].id;
    const err = await expectPgError(insertAbsence(assignment, nextMonday));
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_fora_da_vigencia');
  });

  // ── uq_piab_open ──────────────────────────────────────────────────────────────────────────
  it('[13.10] 2ª ausência aberta na mesma (alocação, data) → 23505 uq_piab_open; a cancelada não conta', async () => {
    console.log('[13.10]', 'uq_piab_open');
    const titular = await mkWorkerWithWja(jobZ, 'w-9-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const first = (await insertAbsence(assignment, nextMonday)).rows[0].id;
    const err = await expectPgError(insertAbsence(assignment, nextMonday));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('uq_piab_open');

    await pool.query(
      `UPDATE patient_itinerary_absence SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1`,
      [first, TASK_PREFIX],
    );
    const r = await insertAbsence(assignment, nextMonday);
    expect(r.rows[0].id).toBeTruthy();
  });

  // ── imutabilidade / cancelamento ──────────────────────────────────────────────────────────
  it('[13.11] UPDATE da chave (assignment_id/on_date) → 23514 piab_chave_imutavel', async () => {
    console.log('[13.11]', 'piab_chave_imutavel');
    const titular = await mkWorkerWithWja(jobZ, 'w-10-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const absence = (await insertAbsence(assignment, nextMonday)).rows[0].id;
    const err = await expectPgError(
      pool.query(`UPDATE patient_itinerary_absence SET on_date = $2 WHERE id = $1`, [absence, nextTuesday]),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_chave_imutavel');
  });

  it('[13.12] cancelada não volta → 23514 piab_cancelada', async () => {
    console.log('[13.12]', 'piab_cancelada');
    const titular = await mkWorkerWithWja(jobZ, 'w-11-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const absence = (await insertAbsence(assignment, nextMonday)).rows[0].id;
    await pool.query(`UPDATE patient_itinerary_absence SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1`, [
      absence,
      TASK_PREFIX,
    ]);
    const err = await expectPgError(
      pool.query(`UPDATE patient_itinerary_absence SET cancelled_at = NULL, cancelled_by = NULL WHERE id = $1`, [
        absence,
      ]),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_cancelada');
  });

  // ── DELETE revogado / função sem EXECUTE ────────────────────────────────────────────────
  it('[13.13] DELETE como app_runtime → 42501', async () => {
    console.log('[13.13]', 'DELETE 42501');
    const titular = await mkWorkerWithWja(jobZ, 'w-12-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const absence = (await insertAbsence(assignment, nextMonday)).rows[0].id;

    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      const err = await expectPgError(
        client.query(`DELETE FROM patient_itinerary_absence WHERE id = $1`, [absence]),
      );
      expect(err.code).toBe('42501');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('[13.14] itinerary_worker_conflict chamada direta como app_runtime → 42501', async () => {
    console.log('[13.14]', 'itinerary_worker_conflict 42501');
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      const err = await expectPgError(
        client.query(
          `SELECT * FROM itinerary_worker_conflict($1::uuid, 1::smallint, 480, 720, $1::uuid, '2026-01-01'::date, NULL::date, NULL::uuid, NULL::uuid, NULL::uuid)`,
          ['00000000-0000-0000-0000-000000000000'],
        ),
      );
      expect(err.code).toBe('42501');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  it('[13.15] ausência sem substituto nunca trava (mesmo com outra ausência cruzando)', async () => {
    console.log('[13.15]', 'sem substituto nunca trava');
    const titular = await mkWorkerWithWja(jobZ, 'w-15-titular');
    const assignment = (await insertAssignment(slotZBase, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const r = await insertAbsence(assignment, nextMonday);
    expect(r.rows[0].id).toBeTruthy();
  });

  // ── trava por data (DX-13.2): o substituto tem compromisso próprio ──────────────────────
  it('[13.16] substituto com semanal segunda 08-12 em X, substituição segunda D 10-14 em Y → 23P01', async () => {
    console.log('[13.16]', 'trava por data — overlap direto');
    const w = await mkWorkerWithWja(jobX, 'w-16-sub');
    await insertAssignment(slotBaseX, w.workerId, w.wjaId, '2026-01-01');
    const subApp = await addWja(w.workerId, jobY);
    const titular = await mkWorkerWithWja(jobY, 'w-16-titular');
    const assignment = (await insertAssignment(slotY1014, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const err = await expectPgError(
      insertAbsence(assignment, nextMonday, { substituteWorkerId: w.workerId, substituteApplicationId: subApp }),
    );
    expect(err.code).toBe('23P01');
  });

  it('[13.17] 12:30-16 em Y (folga de 30min) → 23P01 com DETAIL.minGapMinutes=60, sem chave de PII', async () => {
    console.log('[13.17]', 'trava por data — folga curta + DETAIL sem PII');
    const w = await mkWorkerWithWja(jobX, 'w-17-sub');
    await insertAssignment(slotBaseX, w.workerId, w.wjaId, '2026-01-01');
    const subApp = await addWja(w.workerId, jobY);
    const titular = await mkWorkerWithWja(jobY, 'w-17-titular');
    const assignment = (
      await insertAssignment(slotY12301600, titular.workerId, titular.wjaId, '2026-01-01')
    ).rows[0].id;
    const err = await expectPgError(
      insertAbsence(assignment, nextMonday, { substituteWorkerId: w.workerId, substituteApplicationId: subApp }),
    );
    expect(err.code).toBe('23P01');
    expect(err.detail).toBeTruthy();
    const detail = JSON.parse(err.detail as string) as Record<string, unknown>;
    expect(detail.minGapMinutes).toBe(60);
    expect(detail.sameAddress).toBe(false);
    const offendingKeys = Object.keys(detail).filter(
      (k) => /name|phone|email|address|diagnos|clinic/i.test(k) && typeof detail[k] === 'string',
    );
    expect(offendingKeys).toEqual([]);
  });

  it('[13.18] 13-16 em Y (folga de exatos 60min) → aceita', async () => {
    console.log('[13.18]', 'trava por data — folga exata aceita');
    const w = await mkWorkerWithWja(jobX, 'w-18-sub');
    await insertAssignment(slotBaseX, w.workerId, w.wjaId, '2026-01-01');
    const subApp = await addWja(w.workerId, jobY);
    const titular = await mkWorkerWithWja(jobY, 'w-18-titular');
    const assignment = (
      await insertAssignment(slotY13001600, titular.workerId, titular.wjaId, '2026-01-01')
    ).rows[0].id;
    const r = await insertAbsence(assignment, nextMonday, {
      substituteWorkerId: w.workerId,
      substituteApplicationId: subApp,
    });
    expect(r.rows[0].id).toBeTruthy();
  });

  it('[13.19] 12-16 no MESMO endereço X (toca, não sobrepõe) → aceita', async () => {
    console.log('[13.19]', 'trava por data — mesmo endereço toca, aceita');
    const w = await mkWorkerWithWja(jobX, 'w-19-sub');
    await insertAssignment(slotBaseX, w.workerId, w.wjaId, '2026-01-01');
    // w já tem WJA para jobX (mkWorkerWithWja) — a candidatura da substituição em X é a MESMA.
    const subApp = w.wjaId;
    const titular = await mkWorkerWithWja(jobX, 'w-19-titular');
    const assignment = (await insertAssignment(slotX1216, titular.workerId, titular.wjaId, '2026-01-01')).rows[0].id;
    const r = await insertAbsence(assignment, nextMonday, {
      substituteWorkerId: w.workerId,
      substituteApplicationId: subApp,
    });
    expect(r.rows[0].id).toBeTruthy();
  });

  it('[13.20] terça 08-12 em Y (outro dia da semana) → aceita', async () => {
    console.log('[13.20]', 'trava por data — outro dia da semana, aceita');
    const w = await mkWorkerWithWja(jobX, 'w-20-sub');
    await insertAssignment(slotBaseX, w.workerId, w.wjaId, '2026-01-01');
    const subApp = await addWja(w.workerId, jobY);
    const titular = await mkWorkerWithWja(jobY, 'w-20-titular');
    const assignment = (
      await insertAssignment(slotYter0812, titular.workerId, titular.wjaId, '2026-01-01')
    ).rows[0].id;
    const r = await insertAbsence(assignment, nextTuesday, {
      substituteWorkerId: w.workerId,
      substituteApplicationId: subApp,
    });
    expect(r.rows[0].id).toBeTruthy();
  });

  // ── 2ª substituição em D que cruza a 1ª (mesmo substituto, dois titulares) ───────────────
  it('[13.21] 2ª substituição em D que cruza a 1ª (mesmo W) → 23P01', async () => {
    console.log('[13.21]', 'trava por data — 2ª substituição cruza a 1ª');
    const w = await mkWorkerWithWja(jobX, 'w-21-sub');
    const subAppA = w.wjaId;
    const subAppB = await addWja(w.workerId, jobY);

    const titularA = await mkWorkerWithWja(jobX, 'w-21-titularA');
    const assignmentA = (
      await insertAssignment(slotCrossA, titularA.workerId, titularA.wjaId, '2026-01-01')
    ).rows[0].id;
    const titularB = await mkWorkerWithWja(jobY, 'w-21-titularB');
    const assignmentB = (
      await insertAssignment(slotCrossB, titularB.workerId, titularB.wjaId, '2026-01-01')
    ).rows[0].id;

    const first = await insertAbsence(assignmentA, nextMonday, {
      substituteWorkerId: w.workerId,
      substituteApplicationId: subAppA,
    });
    expect(first.rows[0].id).toBeTruthy();

    const err = await expectPgError(
      insertAbsence(assignmentB, nextMonday, { substituteWorkerId: w.workerId, substituteApplicationId: subAppB }),
    );
    expect(err.code).toBe('23P01');
  });

  // ── D fora da vigência da semanal do substituto → aceita ─────────────────────────────────
  it('[13.22] D fora da vigência da semanal do substituto → aceita', async () => {
    console.log('[13.22]', 'trava por data — vigência do substituto não cobre D, aceita');
    const w = await mkWorkerWithWja(jobX, 'w-22-sub');
    // a alocação semanal do substituto TERMINA antes de nextMonday — fora de vigência naquela data.
    await insertAssignment(slotCrossA, w.workerId, w.wjaId, pastMonday, { validTo: pastMonday });
    const subApp = await addWja(w.workerId, jobY);
    const titular = await mkWorkerWithWja(jobY, 'w-22-titular');
    const assignment = (await insertAssignment(slotCrossB, titular.workerId, titular.wjaId, '2026-01-01')).rows[0]
      .id;
    const r = await insertAbsence(assignment, nextMonday, {
      substituteWorkerId: w.workerId,
      substituteApplicationId: subApp,
    });
    expect(r.rows[0].id).toBeTruthy();
  });

  // ── o outro sentido: alocação SEMANAL nova por cima de uma substituição datada vigente ────
  it('[13.23] alocação SEMANAL nova por cima de uma substituição datada vigente → 23P01', async () => {
    console.log('[13.23]', 'trava por data — outro sentido: semanal sobre substituição');
    const w = await mkWorkerWithWja(jobX, 'w-23-sub');
    const subApp = w.wjaId;
    const titular = await mkWorkerWithWja(jobX, 'w-23-titular');
    const assignmentTitular = (
      await insertAssignment(slotCrossA, titular.workerId, titular.wjaId, '2026-01-01')
    ).rows[0].id;
    const absence = await insertAbsence(assignmentTitular, nextMonday, {
      substituteWorkerId: w.workerId,
      substituteApplicationId: subApp,
    });
    expect(absence.rows[0].id).toBeTruthy();

    // agora tenta alocar o MESMO substituto numa alocação SEMANAL que cruza a substituição dele.
    const wjaWeekly = await addWja(w.workerId, jobY);
    const err = await expectPgError(insertAssignment(slotCrossB, w.workerId, wjaWeekly, '2026-01-01'));
    expect(err.code).toBe('23P01');
  });

  // ── Q-S2: o titular ausente continua bloqueando o horário dele ───────────────────────────
  it('[13.24] Q-S2: titular ausente em D, alocado (como substituto) noutro serviço em D no mesmo horário → 23P01', async () => {
    console.log('[13.24]', 'Q-S2 — titular ausente continua bloqueando');
    const titular = await mkWorkerWithWja(jobX, 'w-24-titular');
    const assignmentOwn = (
      await insertAssignment(slotCrossA, titular.workerId, titular.wjaId, '2026-01-01')
    ).rows[0].id;
    // o próprio titular marca ausência SEM substituto (Q-S1) — não libera nada, é só o alerta.
    const ownAbsence = await insertAbsence(assignmentOwn, nextMonday);
    expect(ownAbsence.rows[0].id).toBeTruthy();

    // agora o MESMO titular (ausente na própria vaga) é convidado a substituir OUTRO titular em D,
    // no mesmo horário — o ramo semanal não desconta a própria ausência.
    const subApp = await addWja(titular.workerId, jobY);
    const titular2 = await mkWorkerWithWja(jobY, 'w-24-titular2');
    const assignment2 = (
      await insertAssignment(slotCrossB, titular2.workerId, titular2.wjaId, '2026-01-01')
    ).rows[0].id;
    const err = await expectPgError(
      insertAbsence(assignment2, nextMonday, { substituteWorkerId: titular.workerId, substituteApplicationId: subApp }),
    );
    expect(err.code).toBe('23P01');
  });

  // ── concorrência: duas substituições do mesmo W em D, cruzando ───────────────────────────
  it('[13.25] concorrência: duas substituições do mesmo W em D cruzando → conjunto ordenado [23P01, ok], 1 linha aberta', async () => {
    console.log('[13.25]', 'trava por data — concorrência');
    const w = await mkWorkerWithWja(jobX, 'w-25-sub');
    const subAppA = w.wjaId;
    const subAppB = await addWja(w.workerId, jobY);

    const titularA = await mkWorkerWithWja(jobX, 'w-25-titularA');
    const assignmentA = (
      await insertAssignment(slotCrossA, titularA.workerId, titularA.wjaId, '2026-01-01')
    ).rows[0].id;
    const titularB = await mkWorkerWithWja(jobY, 'w-25-titularB');
    const assignmentB = (
      await insertAssignment(slotCrossB, titularB.workerId, titularB.wjaId, '2026-01-01')
    ).rows[0].id;

    const c1: PoolClient = await pool.connect();
    const c2: PoolClient = await pool.connect();
    try {
      await c1.query('BEGIN');
      await c2.query('BEGIN');

      await c1.query(
        `INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [assignmentA, nextMonday, w.workerId, subAppA, TASK_PREFIX],
      );

      const p2 = c2.query(
        `INSERT INTO patient_itinerary_absence (assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)`,
        [assignmentB, nextMonday, w.workerId, subAppB, TASK_PREFIX],
      );

      await c1.query('SELECT pg_sleep(0.3)');

      const settled = await Promise.allSettled([
        c1.query('COMMIT').then(() => 'ok'),
        p2.then(
          () => 'ok',
          (e: PgErrorLike) => {
            throw e;
          },
        ),
      ]);

      const codes = settled
        .map((s) => (s.status === 'fulfilled' ? 'ok' : ((s.reason as PgErrorLike).code ?? 'erro')))
        .sort();
      expect(codes).toEqual(['23P01', 'ok']);

      await c2.query('ROLLBACK').catch(() => {});
    } finally {
      c1.release();
      c2.release();
    }

    const open = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient_itinerary_absence
        WHERE substitute_worker_id = $1 AND on_date = $2 AND cancelled_at IS NULL`,
      [w.workerId, nextMonday],
    );
    expect(open.rows[0].n).toBe(1);
  });

  // ── gate parcial #1: ausência sobre alocação do titular ENCERRADA ─────────────────────────
  // Monta, por teste (sem estado compartilhado entre `it`), um substituto W numa ausência FUTURA
  // (nextMonday) do titular A e depois ENCERRA a alocação de A antes dessa data (valid_to =
  // pastMonday) — o mesmo efeito do `end` da Fase 11.
  async function absenceOnEndedAllocation(label: string) {
    const w = await mkWorkerWithWja(jobX, `${label}-sub`);
    const titularA = await mkWorkerWithWja(jobX, `${label}-titularA`);
    const assignmentA = (
      await insertAssignment(slotCrossA, titularA.workerId, titularA.wjaId, '2026-01-01')
    ).rows[0].id;
    const absence = (
      await insertAbsence(assignmentA, nextMonday, { substituteWorkerId: w.workerId, substituteApplicationId: w.wjaId })
    ).rows[0].id;
    await pool.query(
      `UPDATE patient_itinerary_assignment SET status = 'ENDED', valid_to = $2, updated_by = $3 WHERE id = $1`,
      [assignmentA, pastMonday, TASK_PREFIX],
    );
    return { w, absence };
  }

  it('[13.26] alocação do titular ENCERRADA com ausência futura → a substituição dela NÃO bloqueia o substituto noutra substituição na mesma data/horário', async () => {
    console.log('[13.26]', 'gate #1 — ausência sobre alocação encerrada não trava');
    const { w } = await absenceOnEndedAllocation('w-26');
    const subAppB = await addWja(w.workerId, jobY);
    const titularB = await mkWorkerWithWja(jobY, 'w-26-titularB');
    const assignmentB = (
      await insertAssignment(slotCrossB, titularB.workerId, titularB.wjaId, '2026-01-01')
    ).rows[0].id;
    const r = await insertAbsence(assignmentB, nextMonday, {
      substituteWorkerId: w.workerId,
      substituteApplicationId: subAppB,
    });
    expect(r.rows[0].id).toBeTruthy();
  });

  it('[13.27] cancelar a ausência sobre alocação ENCERRADA → aceito (cancelled_at gravado)', async () => {
    console.log('[13.27]', 'gate #1 — cancelar sempre permitido');
    const { absence } = await absenceOnEndedAllocation('w-27');
    const r = await pool.query(
      `UPDATE patient_itinerary_absence
          SET cancelled_at = now(), cancelled_by = $2, updated_by = $2, updated_at = now()
        WHERE id = $1 AND cancelled_at IS NULL`,
      [absence, TASK_PREFIX],
    );
    expect(r.rowCount).toBe(1);
    const after = await pool.query<{ cancelled: string }>(
      `SELECT (cancelled_at IS NOT NULL)::text AS cancelled FROM patient_itinerary_absence WHERE id = $1`,
      [absence],
    );
    expect(after.rows[0].cancelled).toBe('true');
  });

  it('[13.28] outro UPDATE na ausência sobre alocação ENCERRADA (tirar o substituto, com ou sem cancelar junto) → 23514 piab_fora_da_vigencia', async () => {
    console.log('[13.28]', 'gate #1 — só o cancelamento puro passa');
    const { absence } = await absenceOnEndedAllocation('w-28');
    const err = await expectPgError(
      pool.query(
        `UPDATE patient_itinerary_absence
            SET substitute_worker_id = NULL, substitute_application_id = NULL, updated_by = $2
          WHERE id = $1`,
        [absence, TASK_PREFIX],
      ),
    );
    expect(err.code).toBe('23514');
    expect(err.message).toContain('piab_fora_da_vigencia');

    const errCombined = await expectPgError(
      pool.query(
        `UPDATE patient_itinerary_absence
            SET substitute_worker_id = NULL, substitute_application_id = NULL,
                cancelled_at = now(), cancelled_by = $2, updated_by = $2
          WHERE id = $1`,
        [absence, TASK_PREFIX],
      ),
    );
    expect(errCombined.code).toBe('23514');
    expect(errCombined.message).toContain('piab_fora_da_vigencia');
  });
});
