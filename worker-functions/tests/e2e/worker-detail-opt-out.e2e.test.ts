/**
 * N7 (spec 078 M4.5) — `opted_out` / `opted_out_at` na ficha do worker (e em `by-phone`, que usa
 * o MESMO SELECT e o MESMO builder). Banco real: o SELECT roda como o controller o roda
 * (`WORKER_DETAIL_COLS`), o opt-out é gravado pelo MESMO caminho de `register_opt_out`
 * (`RegisterOptOutUseCase`). Sem mock de banco.
 */
import { Pool } from 'pg';
import { WORKER_DETAIL_COLS } from '../../src/modules/worker/interfaces/controllers/AdminWorkersControllerHelpers';
import { buildWorkerDetailResponse } from '../../src/modules/worker/interfaces/controllers/AdminWorkersDetailBuilder';
import { RegisterOptOutUseCase } from '../../src/modules/notification/application/RegisterOptOutUseCase';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const enc = { decrypt: async (v: string | null) => v } as never;
const gcs = { generateViewSignedUrl: async (p: string) => p } as never;

describe('N7 — opted_out na ficha do worker (banco real)', () => {
  let pool: Pool;
  const ids: string[] = [];

  async function novoWorker(phone: string): Promise<string> {
    const r = await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, country, status)
       VALUES ($1, $2, $3, 'AR', 'REGISTERED') RETURNING id`,
      [`n7-${phone}-${Date.now()}`, `n7-${phone}@e2e.local`, phone],
    );
    ids.push(r.rows[0].id);
    return r.rows[0].id;
  }

  async function ficha(id: string): Promise<Record<string, any>> {
    const row = await pool.query(`SELECT ${WORKER_DETAIL_COLS} FROM workers w WHERE w.id = $1`, [id]);
    return buildWorkerDetailResponse(pool, enc, gcs, row.rows[0], null);
  }

  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(async () => {
    if (ids.length) {
      await pool.query('DELETE FROM messaging_opt_out WHERE worker_id = ANY($1)', [ids]);
      await pool.query('DELETE FROM workers WHERE id = ANY($1)', [ids]);
    }
    await pool.end();
  });

  it('worker sem opt-out → opted_out false', async () => {
    const id = await novoWorker('+5491155550001');
    const d = await ficha(id);
    expect(d.opted_out).toBe(false);
    expect(d.opted_out_at).toBeNull();
  });

  it('worker com opt-out gravado por register_opt_out → opted_out true + data', async () => {
    const id = await novoWorker('+5491155550002');
    await new RegisterOptOutUseCase(pool as never).execute({ workerId: id, reason: 'user_request', source: 'whatsapp_inbound' } as never);
    const d = await ficha(id);
    expect(d.opted_out).toBe(true);
    expect(d.opted_out_at).toBeInstanceOf(Date);
  });

  it('re-opt-in (opted_in_at preenchido) → volta a false', async () => {
    const id = await novoWorker('+5491155550003');
    await new RegisterOptOutUseCase(pool as never).execute({ workerId: id, reason: 'user_request', source: 'whatsapp_inbound' } as never);
    await pool.query('UPDATE messaging_opt_out SET opted_in_at = NOW() WHERE worker_id = $1', [id]);
    const d = await ficha(id);
    expect(d.opted_out).toBe(false);
    expect(d.opted_out_at).toBeNull();
  });
});
