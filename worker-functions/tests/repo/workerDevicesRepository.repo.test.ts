/**
 * PgWorkerDeviceRepository contra POSTGRES REAL como `enlite_app` (migration 593): o SQL dos 4 movimentos do aparelho.
 *   DATABASE_URL=postgresql://enlite_app:...@127.0.0.1:<porta>/enlite_e2e npx jest --config jest.config.repo.js workerDevicesRepository --maxWorkers=2
 */
import { Pool } from 'pg';
import crypto from 'crypto';
import { PgWorkerDeviceRepository } from '../../src/modules/identity/infrastructure/PgWorkerDeviceRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_app:app@127.0.0.1:5611/enlite_e2e';

describe('PgWorkerDeviceRepository (Postgres real)', () => {
  let pool: Pool;
  let repo: PgWorkerDeviceRepository;
  let workerId: string;
  let authUid: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new PgWorkerDeviceRepository(pool);
    authUid = `repo-dev-${crypto.randomUUID()}`;
    const w = await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid, email) VALUES ($1, $2) RETURNING id`, [authUid, `${authUid}@enlite.test`]);
    workerId = w.rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
    await pool.end();
  });

  const reg = (installationId = crypto.randomUUID()) =>
    repo.registerReplacingActive({ workerId, installationId, publicKey: 'pk', fcmTokenEnc: 'enc' });

  it('registrar o 2º aparelho revoga o 1º por substituição e deixa UM ativo', async () => {
    const a = await reg();
    const b = await reg();
    expect(b.replacedDeviceId).toBe(a.deviceId);
    const { rows } = await pool.query(`SELECT status, revoked_reason, revoked_by FROM worker_devices WHERE worker_id = $1 ORDER BY registered_at`, [workerId]);
    expect(rows).toEqual([
      { status: 'revogado', revoked_reason: 'substituido', revoked_by: null },
      { status: 'ativo', revoked_reason: null, revoked_by: null },
    ]);
    expect((await repo.findActive(workerId))?.deviceId).toBe(b.deviceId);
  });

  it('revogar registra quem pediu, não mexe em `workers` e a 2ª revogação não acha aparelho', async () => {
    const before = await pool.query(`SELECT status, updated_at FROM workers WHERE id = $1`, [workerId]);
    const r = await repo.revokeActive(workerId, 'op-uid');
    expect(r?.fcmTokenEnc).toBe('enc');
    expect(await repo.revokeActive(workerId, 'op-uid')).toBeNull();
    const row = (await pool.query(`SELECT revoked_by, revoked_reason, revoked_at FROM worker_devices WHERE id = $1`, [r!.deviceId])).rows[0];
    expect(row).toMatchObject({ revoked_by: 'op-uid', revoked_reason: 'operador' });
    expect(row.revoked_at).not.toBeNull();
    const after = await pool.query(`SELECT status, updated_at FROM workers WHERE id = $1`, [workerId]);
    expect(after.rows).toEqual(before.rows);
    expect(await repo.findAuthUid(workerId)).toBe(authUid);
  });

  it('confirmar o apagamento grava wiped_at uma só vez', async () => {
    const inst = crypto.randomUUID();
    await reg(inst);
    expect(await repo.confirmWipe(workerId, inst)).toBe(true);
    const first = (await pool.query(`SELECT wiped_at FROM worker_devices WHERE installation_id = $1`, [inst])).rows[0].wiped_at;
    expect(await repo.confirmWipe(workerId, inst)).toBe(false);
    const second = (await pool.query(`SELECT wiped_at FROM worker_devices WHERE installation_id = $1`, [inst])).rows[0].wiped_at;
    expect(second).toEqual(first);
    expect(await repo.confirmWipe(workerId, crypto.randomUUID())).toBe(false);
  });
});
