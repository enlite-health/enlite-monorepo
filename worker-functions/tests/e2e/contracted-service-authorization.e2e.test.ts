/**
 * contracted-service-authorization.e2e.test.ts @integration — spec 056, T2.1 (migration 529)
 *
 * Prova, contra Postgres real e sem API, que a autorização de horas tem vigência fechada, uma corrente por período,
 * substituição bitemporal e fato gravado imutável.
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `csa-e2e-${RUN}-`;

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

describe('contracted_service_authorization — vigência fechada, sem sobreposição, imutável — migration 529 @integration', () => {
  let pool: Pool;
  let patientId = '';
  let addressId = '';

  async function mkService(): Promise<string> {
    return (
      await pool.query<{ id: string }>(
        `INSERT INTO patient_contracted_services (patient_id, service_code, address_id, country, created_by, updated_by)
         VALUES ($1, 'AT', $2, 'AR', $3, $3) RETURNING id`,
        [patientId, addressId, PREFIX],
      )
    ).rows[0].id;
  }

  function insertAuth(sid: string, hours: number, valid: string) {
    return pool.query<{ id: string; country: string }>(
      `INSERT INTO contracted_service_authorization (contracted_service_id, hours, valid, recorded_by)
       VALUES ($1, $2, $3::daterange, $4) RETURNING id, country`,
      [sid, hours, valid, PREFIX],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Horas', 'Autorizacao', 'AR', 'ACTIVE') RETURNING id`,
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
      await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [`${PREFIX}%`]);
      const left = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM patients WHERE clickup_task_id LIKE $1`,
        [`${PREFIX}%`],
      );
      if (left.rows[0].n !== 0) throw new Error(`limpeza incompleta do RUN ${RUN}: patients=${left.rows[0].n}`);
    } finally {
      await pool.end();
    }
  });

  it('duas autorizações correntes sobrepostas → 23P01', async () => {
    const sid = await mkService();
    await insertAuth(sid, 120, '[2026-01-01,2027-01-01)');
    const err = await expectPgError(insertAuth(sid, 60, '[2026-06-01,2026-09-01)'));
    expect(err.code).toBe('23P01');
    expect(err.constraint).toBe('csa_sem_sobreposicao');
  });

  it('sem fim → 23514', async () => {
    const sid = await mkService();
    const err = await expectPgError(insertAuth(sid, 120, '[2026-01-01,)'));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('csa_valid_fechada');
  });

  it('hours 0 → 23514', async () => {
    const sid = await mkService();
    const err = await expectPgError(insertAuth(sid, 0, '[2026-01-01,2027-01-01)'));
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('csa_hours_positive');
  });

  it('substituída libera o período', async () => {
    const sid = await mkService();
    const first = (await insertAuth(sid, 120, '[2026-01-01,2027-01-01)')).rows[0].id;
    await pool.query(`UPDATE contracted_service_authorization SET superseded_at = now() WHERE id = $1`, [first]);
    const second = await insertAuth(sid, 130, '[2026-01-01,2027-01-01)');
    expect(second.rows[0].country).toBe('AR');
  });

  it('fato gravado não se reescreve', async () => {
    const sid = await mkService();
    const id = (await insertAuth(sid, 120, '[2026-01-01,2027-01-01)')).rows[0].id;
    const e1 = await expectPgError(
      pool.query(`UPDATE contracted_service_authorization SET hours = 999 WHERE id = $1`, [id]),
    );
    expect(e1.code).toBe('23514');
    expect(e1.message).toContain('csa_imutavel');
    await pool.query(`UPDATE contracted_service_authorization SET superseded_at = now() WHERE id = $1`, [id]);
    const e2 = await expectPgError(
      pool.query(`UPDATE contracted_service_authorization SET superseded_at = now() WHERE id = $1`, [id]),
    );
    expect(e2.code).toBe('23514');
    expect(e2.message).toContain('csa_ja_substituida');
  });
});
