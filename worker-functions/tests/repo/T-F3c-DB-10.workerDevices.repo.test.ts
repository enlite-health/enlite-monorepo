/**
 * T-F3c-DB-10 — migration 593 (worker_devices, D795) contra POSTGRES REAL. Sem API, sem Firebase, sem canal real.
 * Rodar como `enlite_app` (o executor das migrations em prd), não como superuser:
 *   DATABASE_URL=postgresql://enlite_app:...@127.0.0.1:<porta>/enlite_e2e npx jest --config jest.config.repo.js T-F3c-DB-10 --maxWorkers=2
 */
import { Pool } from 'pg';
import crypto from 'crypto';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_app:app@127.0.0.1:5611/enlite_e2e';

describe('migration 593 — worker_devices', () => {
  let pool: Pool;
  let workerId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const who = await pool.query<{ rolsuper: boolean }>(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`);
    // o teste só vale como o executor de prd: sem superuser (o CI roda como superuser; ver memória)
    expect(who.rows[0].rolsuper).toBe(false);
    const w = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email) VALUES ($1, $2) RETURNING id`,
      [`t-f3c-db-10-${crypto.randomUUID()}`, `t-f3c-db-10-${crypto.randomUUID()}@enlite.test`],
    );
    workerId = w.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]); // CASCADE leva os aparelhos
    await pool.end();
  });

  const insert = (status: 'ativo' | 'revogado') =>
    pool.query(
      status === 'ativo'
        ? `INSERT INTO worker_devices (worker_id, installation_id, public_key) VALUES ($1, $2, 'pk')`
        : `INSERT INTO worker_devices (worker_id, installation_id, public_key, status, revoked_at, revoked_reason)
           VALUES ($1, $2, 'pk', 'revogado', NOW(), 'substituido')`,
      [workerId, crypto.randomUUID()],
    );

  it('T-F3c-DB-10 o 1º aparelho ativo da cuidadora entra', async () => {
    await expect(insert('ativo')).resolves.toBeDefined();
  });

  it('T-F3c-DB-10 o 2º aparelho ativo da MESMA cuidadora falha no banco (violação de unicidade)', async () => {
    await expect(insert('ativo')).rejects.toMatchObject({ code: '23505', constraint: 'uq_worker_devices_ativo_por_worker' });
  });

  it('T-F3c-DB-10 revogado + ativo convivem (o índice só olha o ativo)', async () => {
    await pool.query(`DELETE FROM worker_devices WHERE worker_id = $1`, [workerId]);
    await insert('revogado');
    await insert('revogado');
    await expect(insert('ativo')).resolves.toBeDefined();
    const { rows } = await pool.query(`SELECT status FROM worker_devices WHERE worker_id = $1 ORDER BY status`, [workerId]);
    expect(rows.map((r) => r.status)).toEqual(['ativo', 'revogado', 'revogado']);
  });
});
