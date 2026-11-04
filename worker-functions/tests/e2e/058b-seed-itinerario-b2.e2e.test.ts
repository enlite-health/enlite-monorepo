/**
 * 058b-seed-itinerario-b2.e2e.test.ts @integration — smoke do helper `seedItinerarioB2` (massa das e2e de API da B2).
 * Só banco (sem API HTTP): contagens lidas do Postgres do stack E2E.
 */
import { Pool } from 'pg';
import { seedB2, novoSelecionado, proximoDia, hojeAr, limparB2 } from './helpers/seedItinerarioB2';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `058b-seed-${RUN}-`;

describe('seedItinerarioB2 — helper de massa da B2 @integration', () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });

  afterAll(async () => {
    await limparB2(pool, TASK_PREFIX);
  });

  it('seedB2: 2 titulares na segunda + 1 selecionado → 2 alocações ACTIVE desde hoje e 1 candidatura sem alocação (contagens lidas do banco)', async () => {
    const s = await seedB2(pool, `${TASK_PREFIX}1`, { schedule: 'ONE', providersNeeded: 2, titularesSeg: 2, selecionados: 1 });
    const r = await pool.query<{ ativas: number; desde_hoje: number; cands: number; sem_alocacao: number }>(
      `SELECT (SELECT count(*)::int FROM patient_itinerary_assignment WHERE slot_id = $1 AND status = 'ACTIVE' AND valid_to IS NULL) AS ativas,
              (SELECT count(*)::int FROM patient_itinerary_assignment WHERE slot_id = $1 AND valid_from = $2::date) AS desde_hoje,
              (SELECT count(*)::int FROM worker_job_applications WHERE job_posting_id = $3 AND application_funnel_stage = 'QUICK_RESPONSE_TEAM') AS cands,
              (SELECT count(*)::int FROM worker_job_applications w WHERE w.job_posting_id = $3
                 AND NOT EXISTS (SELECT 1 FROM patient_itinerary_assignment a WHERE a.application_id = w.id)) AS sem_alocacao`,
      [s.slotSegId, s.hoje, s.vacancyId],
    );
    expect(r.rows[0]).toEqual({ ativas: 2, desde_hoje: 2, cands: 3, sem_alocacao: 1 });
    expect(s.selecionados).toHaveLength(1);
    const extra = await novoSelecionado(pool, s, `${TASK_PREFIX}1-extra`);
    expect(typeof extra).toBe('string');
  });

  it('proximoDia: devolve uma data estritamente posterior a hoje cujo dia da semana é o pedido', async () => {
    const hoje = await hojeAr(pool);
    for (const dow of [0, 1, 2, 3, 4, 5, 6]) {
      const d = await proximoDia(pool, hoje, dow);
      const r = await pool.query<{ dow: number; depois: boolean }>(
        `SELECT extract(dow FROM $1::date)::int AS dow, ($1::date > $2::date) AS depois`,
        [d, hoje],
      );
      expect(r.rows[0]).toEqual({ dow, depois: true });
    }
    expect((await pool.query<{ dow: number }>(`SELECT extract(dow FROM $1::date)::int AS dow`, [await proximoDia(pool, hoje, 3)])).rows[0].dow).toBe(3);
  });

  it('limparB2: depois da limpeza, 0 paciente, 0 prestador e 0 vaga com o prefixo', async () => {
    const prefix = `${TASK_PREFIX}limpa-`;
    await seedB2(pool, `${prefix}1`, { schedule: 'TWO', providersNeeded: 1, titularesSeg: 1, titularesQua: 1, selecionados: 1 });
    const antes = await pool.query<{ p: number }>(`SELECT count(*)::int AS p FROM patients WHERE clickup_task_id LIKE $1`, [`${prefix}%`]);
    expect(antes.rows[0].p).toBe(1);
    // `limparB2` encerra o pool: usa um pool próprio para este caso.
    const own = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await limparB2(own, prefix);
    const check = await pool.query<{ p: number; w: number; j: number }>(
      `SELECT (SELECT count(*)::int FROM patients WHERE clickup_task_id LIKE $1) AS p,
              (SELECT count(*)::int FROM workers WHERE auth_uid LIKE $1) AS w,
              (SELECT count(*)::int FROM job_postings WHERE title LIKE $1) AS j`,
      [`${prefix}%`],
    );
    expect(check.rows[0]).toEqual({ p: 0, w: 0, j: 0 });
  });
});
