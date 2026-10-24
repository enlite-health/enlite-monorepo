/**
 * horas-faixa-do-servico.e2e.test.ts @integration — spec 056, T1.1 (migration 527)
 *
 * Prova, contra Postgres real e sem API, que a faixa do itinerário é dona do horário do serviço:
 * duração (início + minutos), vigência `valid`, EXCLUDE `pis_sem_sobreposicao`, trigger de chave imutável
 * e a leitura `horario_do_servico`.
 */
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const PREFIX = `hfs-e2e-${RUN}-`;

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

describe('faixa com duração, vigência, EXCLUDE e horario_do_servico — migration 527 @integration', () => {
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

  function insertSlot(sid: string, weekday: number, start: string, duration: number, valid: string) {
    return pool.query<{ id: string }>(
      `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5::daterange, $6, $6) RETURNING id`,
      [sid, weekday, start, duration, valid, PREFIX],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = (
      await pool.query<{ id: string }>(
        `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
         VALUES ($1, 'Horas', 'Faixa', 'AR', 'ACTIVE') RETURNING id`,
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

  it('faixa sobreposta no mesmo serviço e vigência → 23P01', async () => {
    const sid = await mkService();
    await insertSlot(sid, 1, '08:00', 240, '[2026-01-01,)');
    const err = await expectPgError(insertSlot(sid, 1, '10:00', 240, '[2026-01-01,)'));
    expect(err.code).toBe('23P01');
    expect(err.constraint).toBe('pis_sem_sobreposicao');
  });

  it('mesma faixa em vigências que não se cruzam → aceita', async () => {
    const sid = await mkService();
    await insertSlot(sid, 2, '08:00', 240, '[2026-01-01,2026-02-01)');
    await insertSlot(sid, 2, '08:00', 240, '[2026-02-01,)');
    const r = await pool.query(`SELECT 1 FROM patient_itinerary_slot WHERE contracted_service_id = $1`, [sid]);
    expect(r.rowCount).toBe(2);
  });

  it('sábado 20:00 por 12 h colide com domingo 06:00 (virada da semana) → 23P01', async () => {
    const sid = await mkService();
    await insertSlot(sid, 6, '20:00', 720, '[2026-01-01,)');
    const err = await expectPgError(insertSlot(sid, 0, '06:00', 120, '[2026-01-01,)'));
    expect(err.code).toBe('23P01');
  });

  it('sábado 20:00 por 12 h não colide com domingo 08:00 (borda exata) → aceita', async () => {
    const sid = await mkService();
    await insertSlot(sid, 6, '20:00', 720, '[2026-01-01,)');
    const r = await insertSlot(sid, 0, '08:00', 60, '[2026-01-01,)');
    expect(r.rows[0].id).toBeTruthy();
  });

  it('24 h é uma linha só', async () => {
    const sid = await mkService();
    await insertSlot(sid, 3, '00:00', 1440, '[2026-01-01,)');
    const r = await pool.query<{ wm: string }>(
      `SELECT week_minutes::text AS wm FROM patient_itinerary_slot WHERE contracted_service_id = $1`,
      [sid],
    );
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].wm).toBe('{[4320,5760)}');
  });

  it('duração fora de 1..1440 → 23514', async () => {
    const sid = await mkService();
    const e0 = await expectPgError(insertSlot(sid, 4, '08:00', 0, '[2026-01-01,)'));
    const e1 = await expectPgError(insertSlot(sid, 4, '08:00', 1441, '[2026-01-01,)'));
    expect(e0.code).toBe('23514');
    expect(e1.code).toBe('23514');
  });

  it('chave imutável e vigência só fecha → 23514', async () => {
    const sid = await mkService();
    const id = (await insertSlot(sid, 5, '08:00', 240, '[2026-01-01,)')).rows[0].id;
    const eKey = await expectPgError(
      pool.query(`UPDATE patient_itinerary_slot SET duration_minutes = 300 WHERE id = $1`, [id]),
    );
    expect(eKey.code).toBe('23514');
    expect(eKey.message).toContain('pis_chave_imutavel');

    await pool.query(`UPDATE patient_itinerary_slot SET valid = daterange('2026-01-01','2026-03-01') WHERE id = $1`, [id]);

    const eReopen = await expectPgError(
      pool.query(`UPDATE patient_itinerary_slot SET valid = daterange('2026-01-01', NULL) WHERE id = $1`, [id]),
    );
    expect(eReopen.code).toBe('23514');
    expect(eReopen.message).toContain('pis_vigencia_ja_fechada');
  });

  it('horario_do_servico devolve o fim derivado e só a faixa vigente', async () => {
    const sid = await mkService();
    await insertSlot(sid, 6, '20:00', 720, '[2026-01-01,)');
    await insertSlot(sid, 1, '08:00', 240, '[2026-01-01,2026-01-10)');
    const r = await pool.query<{ h: unknown }>(`SELECT horario_do_servico($1, DATE '2026-03-01') AS h`, [sid]);
    expect(r.rows[0].h).toEqual([{ dayOfWeek: 6, startTime: '20:00', endTime: '08:00', durationMinutes: 720 }]);
  });
});
