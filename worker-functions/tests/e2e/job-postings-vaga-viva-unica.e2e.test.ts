/**
 * job-postings-vaga-viva-unica.e2e.test.ts @integration — spec 056, T6.1 (migration 530)
 *
 * Prova, contra Postgres real e sem API, que um serviço contratado tem no máximo uma vaga não apagada.
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `jpvu-e2e-${RUN}-`;

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
  if (!caught) throw new Error('esperava erro do Postgres, mas a operação foi aceita');
  return caught;
}

describe('job_postings — uma vaga viva por serviço — migration 530 @integration', () => {
  let pool: Pool;
  let patientId = '';
  let addressId = '';
  let seq = 0;

  async function mkService(): Promise<string> {
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patientId, addressId, PREFIX],
      )
    ).rows[0].id;
  }

  function insertJob(serviceId: string | null) {
    seq += 1;
    return pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, contracted_service_id, patient_id, country) VALUES ($1, $2, $3, 'AR') RETURNING id`,
      [`${PREFIX}vaga${seq}`, serviceId, patientId],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Vaga', 'Unica', 'AR', 'ACTIVE') RETURNING id`,
        [`${PREFIX}p1`],
      )
    ).rows[0].id;
    addressId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_addresses (patient_id, country) VALUES ($1, 'AR') RETURNING id`,
        [patientId],
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    try {
      await pool.query(`DELETE FROM job_postings WHERE title LIKE $1`, [`${PREFIX}%`]);
      await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
      const left = await pool.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM job_postings WHERE title LIKE $1)::int
              + (SELECT count(*) FROM patients WHERE clickup_task_id LIKE $1)::int AS n`,
        [`${PREFIX}%`],
      );
      if (left.rows[0].n !== 0) throw new Error(`limpeza incompleta do RUN ${RUN}: restam ${left.rows[0].n}`);
    } finally {
      await pool.end();
    }
  });

  it('2ª vaga viva do mesmo serviço → 23505', async () => {
    const sid = await mkService();
    await insertJob(sid);
    const err = await expectPgError(insertJob(sid));
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('uq_job_postings_vaga_viva_por_servico');
  });

  it('vaga apagada libera', async () => {
    const sid = await mkService();
    const first = (await insertJob(sid)).rows[0].id;
    await pool.query(`UPDATE job_postings SET deleted_at = now() WHERE id = $1`, [first]);
    const second = await insertJob(sid);
    expect(second.rows).toHaveLength(1);
  });

  it('vaga manual (sem serviço) fora da trava', async () => {
    await insertJob(null);
    const second = await insertJob(null);
    expect(second.rows).toHaveLength(1);
  });
});
