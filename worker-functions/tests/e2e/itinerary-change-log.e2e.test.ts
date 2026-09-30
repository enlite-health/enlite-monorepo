/**
 * itinerary-change-log.e2e.test.ts @integration — change itinerario-trocas-motivos-e-figma, Fase 2
 *
 * Prova, contra Postgres real, as regras escritas na migration 494 (`patient_itinerary_change_log`,
 * design D3): o registro de trocas é append-only, sem texto livre, com motivo só por `code` do
 * catálogo (FK para `service_exit_reasons`, 492) e país herdado do serviço.
 *
 *   (1) motivo inexistente no catálogo → 23503 (FK);
 *   (2) REPLACE sem destino → 23514 `picl_destination_by_kind` (destino só nasce nas Fases 4 e 6);
 *   (3) `app_runtime` não tem UPDATE nem DELETE (append-only); tem SELECT e INSERT;
 *   (4) `country` herdado do serviço pelo trigger;
 *   (5) RLS segue o serviço: quem opera em AR não lê a troca de um serviço BR.
 *
 * Semente por SQL no beforeAll, como dono: 2 pacientes (AR e BR), 1 serviço cada, 1 worker.
 * Nenhum texto clínico: nomes sintéticos de teste, sem PII.
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `picl-e2e-${RUN}-`;

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message: string;
}

async function expectPgError(query: Promise<unknown>): Promise<PgErrorLike> {
  let caught: PgErrorLike | null = null;
  try {
    await query;
  } catch (e) {
    caught = e as PgErrorLike;
  }
  if (!caught) throw new Error('esperava erro do Postgres, mas o INSERT foi aceito');
  return caught;
}

describe('patient_itinerary_change_log — regras do banco (migration 494) @integration', () => {
  let pool: Pool;
  let serviceAR = '';
  let serviceBR = '';
  let worker = '';
  let logAR = '';
  let logBR = '';

  async function seedService(country: 'AR' | 'BR', label: string): Promise<string> {
    const patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Troca', $2, $3, 'ACTIVE') RETURNING id`,
        [`${TASK_PREFIX}${label}`, label, country],
      )
    ).rows[0].id;
    const addressId = (
      await pool.query<{ id: string }>(`INSERT INTO patient_addresses (patient_id, country) VALUES ($1, $2) RETURNING id`, [patientId, country])
    ).rows[0].id;
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, $3, $4, $4) RETURNING id`,
        [patientId, addressId, country, TASK_PREFIX],
      )
    ).rows[0].id;
  }

  function insertLog(serviceId: string, opts: { kind?: string; reasonCode?: string; destination?: string | null } = {}) {
    return pool.query<{ id: string; country: string }>(
      `INSERT INTO patient_itinerary_change_log
         (contracted_service_id, kind, outgoing_worker_id, effective_date, reason_code, destination, created_by)
       VALUES ($1, $2, $3, '2026-10-05', $4, $5, $6) RETURNING id, country`,
      [serviceId, opts.kind ?? 'ABSENCE', worker, opts.reasonCode ?? 'OTHER', opts.destination ?? null, TASK_PREFIX],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    serviceAR = await seedService('AR', 'ar');
    serviceBR = await seedService('BR', 'br');
    worker = (
      await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid, email, country) VALUES ($1, $2, 'AR') RETURNING id`, [
        `${TASK_PREFIX}w1`,
        `${TASK_PREFIX}w1@e2e.local`,
      ])
    ).rows[0].id;
  });

  afterAll(async () => {
    // O registro é append-only para a app, mas o dono limpa: log → workers → pacientes (serviço sai em cascata).
    await pool.query(`DELETE FROM patient_itinerary_change_log WHERE created_by = $1`, [TASK_PREFIX]);
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE $1`, [`${TASK_PREFIX}%`]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${TASK_PREFIX}%`]);
    const leftover = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM patient_itinerary_change_log WHERE created_by = $1`, [TASK_PREFIX]);
    expect(leftover.rows[0].n).toBe(0);
    await pool.end();
  });

  it('(1) reason_code que não existe no catálogo → 23503 (FK para service_exit_reasons)', async () => {
    const err = await expectPgError(insertLog(serviceAR, { reasonCode: 'MOTIVO_INEXISTENTE' }));
    expect(err.code).toBe('23503');
    expect(err.constraint).toBe('patient_itinerary_change_log_reason_code_fkey');
  });

  it('(2) REPLACE sem destino → 23514 picl_destination_by_kind; ABSENCE com destino também; REPLACE com destino é aceito', async () => {
    const semDestino = await expectPgError(insertLog(serviceAR, { kind: 'REPLACE', destination: null }));
    expect(semDestino.code).toBe('23514');
    expect(semDestino.constraint).toBe('picl_destination_by_kind');

    const destinoSobrando = await expectPgError(insertLog(serviceAR, { kind: 'ABSENCE', destination: 'RESERVE' }));
    expect(destinoSobrando.code).toBe('23514');
    expect(destinoSobrando.constraint).toBe('picl_destination_by_kind');

    const ok = await insertLog(serviceAR, { kind: 'REPLACE', destination: 'LEAVE_SERVICE' });
    expect(ok.rows[0].id).toBeTruthy();
  });

  it('(3) app_runtime não tem UPDATE nem DELETE (append-only); tem SELECT e INSERT', async () => {
    const r = await pool.query<{ upd: boolean; del: boolean; sel: boolean; ins: boolean }>(
      `SELECT has_table_privilege('app_runtime','patient_itinerary_change_log','UPDATE') AS upd,
              has_table_privilege('app_runtime','patient_itinerary_change_log','DELETE') AS del,
              has_table_privilege('app_runtime','patient_itinerary_change_log','SELECT') AS sel,
              has_table_privilege('app_runtime','patient_itinerary_change_log','INSERT') AS ins`,
    );
    expect(r.rows[0]).toEqual({ upd: false, del: false, sel: true, ins: true });
  });

  it('(4) country herdado do serviço pelo trigger (AR e BR)', async () => {
    const ar = await insertLog(serviceAR);
    const br = await insertLog(serviceBR);
    logAR = ar.rows[0].id;
    logBR = br.rows[0].id;
    expect(ar.rows[0].country).toBe('AR');
    expect(br.rows[0].country).toBe('BR');
  });

  it('(5) RLS: quem opera em AR lê a troca do serviço AR e NÃO lê a do serviço BR', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      await client.query(`SELECT set_config('app.user_country', 'AR', true)`);
      const visible = await client.query<{ id: string }>(`SELECT id FROM patient_itinerary_change_log WHERE id = ANY($1::uuid[])`, [[logAR, logBR]]);
      expect(visible.rows.map((row) => row.id)).toEqual([logAR]);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
