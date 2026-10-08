/**
 * patient-status-derivation-atomicity.e2e.test.ts @integration — cadeia-paciente-vacante-itinerario, Fase 15, P16
 *
 * Prova, no Postgres real, que a derivação do estado do paciente e o escritor do itinerário são UMA
 * transação só (DX-15.4/DX-15.12): os casos de uso REAIS (`ItineraryAllocationUseCase`,
 * `AssembleItineraryUseCase`, `PatientStatusDerivation` com os leitores e o `movePatientStatus`
 * reais) rodam sobre um `runInTransaction` real (BEGIN/COMMIT/ROLLBACK num client do pool do e2e).
 * A falha é injetada DEPOIS da escrita do status (um `moveStatus` que chama o real e então lança):
 * se a derivação estivesse fora da transação do escritor, a alocação/montado sobreviveria.
 *
 * A prova é o que NÃO persistiu (alocação, montado, status, trilha `system`), nunca só o `rejects`.
 * Semente por SQL como dono (molde `patient-itinerary-overlap.e2e.test.ts`); um paciente por `it`;
 * `now` = hoje em Buenos Aires lido do banco, ao meio-dia UTC (DATA-F15) — nunca a data do runner.
 *
 *   (a) alocar com falha injetada depois do status → alocação 0, status SEARCHING, trilha system 0.
 *   (b) controle positivo: alocar com a derivação real → alocação 1, REPLACEMENT, trilha 1.
 *   (c) encerrar com falha injetada → a alocação segue ACTIVE, status igual, trilha 0.
 *   (d) montar com falha injetada → montado 0, status igual, trilha 0.
 */
import { Pool, PoolClient } from 'pg';
import { ItineraryAllocationUseCase } from '../../src/modules/case/application/ItineraryAllocationUseCase';
import { AssembleItineraryUseCase } from '../../src/modules/case/application/AssembleItineraryUseCase';
import { PatientStatusDerivation } from '../../src/modules/case/application/PatientStatusDerivation';
import { movePatientStatus } from '../../src/modules/case/application/PatientStatusWriter';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `psda-e2e-${RUN}-`;
const FALHA = 'falha-injetada-15';
const SCHEDULE = JSON.stringify([
  { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
  { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
]);

interface Seeded {
  patientId: string;
  serviceId: string;
  mondaySlotId: string;
  wednesdaySlotId: string;
  workerId: string;
  applicationId: string;
}

describe('derivação do estado e escritor do itinerário numa transação só — banco real (Fase 15, P16) @integration', () => {
  let pool: Pool;
  let hoje = '';
  let now: Date;
  let seq = 0;

  /** O `runInTransaction` real sobre o pool do e2e: tudo no MESMO client, rollback em qualquer erro. */
  const runInTransaction = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  /** A derivação REAL com o mover real, que lança DEPOIS de escrever o status. */
  const derivacaoComFalha = () =>
    new PatientStatusDerivation({
      moveStatus: async (...args: Parameters<typeof movePatientStatus>) => {
        await movePatientStatus(...args);
        throw new Error(FALHA);
      },
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    const d = await pool.query<{ hoje: string }>(
      `SELECT to_char((now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date, 'YYYY-MM-DD') AS hoje`,
    );
    hoje = d.rows[0].hoje;
    now = new Date(`${hoje}T12:00:00Z`);
  });

  afterAll(async () => {
    // Ordem da regra 13: ausência → alocação → montado → WJA/vaga → worker → serviço → paciente.
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
      console.log('[15.7] limpeza final', left.rows[0]);
      expect(left.rows[0]).toEqual({ p: 0, w: 0, j: 0 });
    } finally {
      await pool.end();
    }
  });

  /** Paciente AR com endereço; serviço AT 8 h (segunda e quarta 08-12); vaga viva; worker em Selecionado (C). */
  async function seed(status: string, opts: { montado: boolean }): Promise<Seeded> {
    seq += 1;
    const tag = `${TASK_PREFIX}${seq}`;
    const patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, has_consent, insurance_informed)
         VALUES ($1, 'Derivacao', 'Atomica', 'AR', $2, true, 'OSDE') RETURNING id`,
        [tag, status],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country, lat, lng) VALUES ($1, 'AR', -34.6, -58.4) RETURNING id`,
        [patientId],
      )
    ).rows[0].id;
    const serviceId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, weekly_hours, schedule, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 8, $3::jsonb, 'AR', $4, $4) RETURNING id`,
        [patientId, addressId, SCHEDULE, TASK_PREFIX],
      )
    ).rows[0].id;
    const mkSlot = async (weekday: number) =>
      (
        await pool.query<{ id: string }>(
          `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by)
           VALUES ($1, $2, '08:00', '12:00', $3, $3) RETURNING id`,
          [serviceId, weekday, TASK_PREFIX],
        )
      ).rows[0].id;
    const mondaySlotId = await mkSlot(1);
    const wednesdaySlotId = await mkSlot(3);
    const jobId = (
      await pool.query<{ id: string }>(
        `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
        [`${tag}-vaga`, serviceId, patientId],
      )
    ).rows[0].id;
    const workerId = (
      await pool.query<{ id: string }>(
        `INSERT INTO workers (auth_uid, email, country, status, occupation) VALUES ($1, $2, 'AR', 'REGISTERED', 'AT') RETURNING id`,
        [`${tag}-w`, `${tag}-w@e2e.local`],
      )
    ).rows[0].id;
    const applicationId = (
      await pool.query<{ id: string }>(
        `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source)
         VALUES ($1, $2, 'QUICK_RESPONSE_TEAM', 'manual') RETURNING id`,
        [workerId, jobId],
      )
    ).rows[0].id;
    if (opts.montado) {
      await pool.query(
        `INSERT INTO patient_itinerary_assembly (patient_id, assembled_by, country) VALUES ($1, $2, 'AR')`,
        [patientId, TASK_PREFIX],
      );
    }
    return { patientId, serviceId, mondaySlotId, wednesdaySlotId, workerId, applicationId };
  }

  async function read(s: Seeded): Promise<{ status: string; alocacoes: number; ativas: number; trilha: number; montado: number }> {
    const r = await pool.query<{ status: string; alocacoes: number; ativas: number; trilha: number; montado: number }>(
      `SELECT (SELECT status FROM patients WHERE id = $1) AS status,
              (SELECT count(*)::int FROM patient_itinerary_assignment WHERE slot_id = $2) AS alocacoes,
              (SELECT count(*)::int FROM patient_itinerary_assignment WHERE slot_id = $2 AND status = 'ACTIVE') AS ativas,
              (SELECT count(*)::int FROM patient_status_history WHERE patient_id = $1 AND change_source = 'system') AS trilha,
              (SELECT count(*)::int FROM patient_itinerary_assembly WHERE patient_id = $1) AS montado`,
      [s.patientId, s.mondaySlotId],
    );
    return r.rows[0];
  }

  function allocateInput(s: Seeded) {
    return { patientId: s.patientId, serviceId: s.serviceId, slotId: s.mondaySlotId, workerId: s.workerId, actorUid: TASK_PREFIX, now };
  }

  it('(a) alocar com falha injetada DEPOIS da escrita do status → nem a alocação nem o status persistem', async () => {
    const s = await seed('SEARCHING', { montado: true });
    const useCase = new ItineraryAllocationUseCase(undefined, undefined, runInTransaction, derivacaoComFalha());
    await expect(useCase.allocate(allocateInput(s))).rejects.toThrow(FALHA);
    const depois = await read(s);
    console.log('[15.7] (a)', { patientId: s.patientId, ...depois });
    expect(depois.alocacoes).toBe(0);
    expect(depois.status).toBe('SEARCHING');
    expect(depois.trilha).toBe(0);
  });

  it('(b) controle positivo — a derivação real: alocação e status persistem juntos', async () => {
    const s = await seed('SEARCHING', { montado: true });
    const useCase = new ItineraryAllocationUseCase(undefined, undefined, runInTransaction, new PatientStatusDerivation());
    const r = await useCase.allocate(allocateInput(s));
    const depois = await read(s);
    console.log('[15.7] (b)', { patientId: s.patientId, validFrom: r.validFrom, hoje, ...depois });
    expect(r.validFrom).toBe(hoje);
    expect(depois.alocacoes).toBe(1);
    expect(depois.status).toBe('REPLACEMENT');
    expect(depois.trilha).toBe(1);
  });

  it('(c) encerrar com falha injetada → a alocação segue ACTIVE e o status igual', async () => {
    const s = await seed('REPLACEMENT', { montado: true });
    const allocationId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_itinerary_assignment (slot_id, worker_id, application_id, valid_from, status, created_by, updated_by)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5) RETURNING id`,
        [s.mondaySlotId, s.workerId, s.applicationId, hoje, TASK_PREFIX],
      )
    ).rows[0].id;
    const useCase = new ItineraryAllocationUseCase(undefined, undefined, runInTransaction, derivacaoComFalha());
    await expect(
      useCase.end({ patientId: s.patientId, serviceId: s.serviceId, allocationId, actorUid: TASK_PREFIX, now }),
    ).rejects.toThrow(FALHA);
    const depois = await read(s);
    const validTo = await pool.query<{ v: string | null }>(
      `SELECT to_char(valid_to, 'YYYY-MM-DD') AS v FROM patient_itinerary_assignment WHERE id = $1`,
      [allocationId],
    );
    console.log('[15.7] (c)', { patientId: s.patientId, ...depois, validTo: validTo.rows[0].v });
    expect(depois.ativas).toBe(1);
    expect(validTo.rows[0].v).toBeNull();
    expect(depois.status).toBe('REPLACEMENT');
    expect(depois.trilha).toBe(0);
  });

  it('(d) montar com falha injetada → o montado não persiste e o status fica igual', async () => {
    const s = await seed('ACTIVE', { montado: false });
    const useCase = new AssembleItineraryUseCase(undefined, runInTransaction, derivacaoComFalha());
    await expect(useCase.execute({ patientId: s.patientId, actorUid: TASK_PREFIX, now })).rejects.toThrow(FALHA);
    const depois = await read(s);
    console.log('[15.7] (d)', { patientId: s.patientId, ...depois });
    expect(depois.montado).toBe(0);
    expect(depois.status).toBe('ACTIVE');
    expect(depois.trilha).toBe(0);
  });
});
