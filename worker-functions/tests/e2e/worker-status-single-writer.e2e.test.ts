/**
 * worker-status-single-writer.e2e.test.ts @integration — spec 093 CA-1, CA-2, CA-3, C1 e o recálculo para REGISTERED.
 *
 * Postgres real, dados sintéticos sem PII, nenhum canal outbound (só domain_events enfileirados, nunca processados).
 */
import { Pool, PoolClient } from 'pg';
import { WORKER_STATUS_FLOWS } from '../../src/modules/worker/domain/WorkerStatusFlow';
import { disable, recalculate } from '../../src/modules/worker/infrastructure/WorkerStatusTransitions';
import { systemActor } from '../../src/shared/audit/actorSource';
import { completeWorkerProfile, cleanWorkerProfile } from './helpers/aptoWorkerFixture';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const PREFIX = 'sw093-';
const SEM_FLUXO = /workers\.status sem fluxo declarado — use WorkerStatusTransitions/;

describe('Spec 093 — workers.status tem um escritor só @integration', () => {
  let pool: Pool;
  const criados: string[] = [];

  const novoWorker = async (tag: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone, is_test)
       VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires', true) RETURNING id`,
      [`${PREFIX}${tag}`, `${PREFIX}${tag}@e2e.local`],
    );
    criados.push(rows[0].id);
    return rows[0].id;
  };

  const historico = async (id: string) =>
    (await pool.query<{ new_value: string; flow: string | null; changed_by: string | null }>(
      `SELECT new_value, flow, changed_by FROM worker_status_history
        WHERE worker_id = $1 AND field_name = 'status' ORDER BY created_at, id`, [id])).rows;

  const limpar = async (): Promise<void> => {
    const w = `SELECT id FROM workers WHERE auth_uid LIKE '${PREFIX}%'`;
    await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' IN (SELECT id::text FROM (${w}) x)`);
    await pool.query(`DELETE FROM worker_status_history WHERE worker_id IN (${w})`);
    await cleanWorkerProfile(pool, (await pool.query<{ id: string }>(w)).rows.map((r) => r.id));
    await pool.query(`DELETE FROM workers WHERE auth_uid LIKE '${PREFIX}%'`);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });
  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('CA-1: UPDATE cru de workers.status sem fluxo é recusado', async () => {
    const id = await novoWorker('ca1');
    await expect(pool.query(`UPDATE workers SET status = 'DISABLED' WHERE id = $1`, [id])).rejects.toThrow(SEM_FLUXO);
    expect((await pool.query(`SELECT status FROM workers WHERE id = $1`, [id])).rows[0].status).toBe('INCOMPLETE_REGISTER');
  });

  it('CA-2 + CA-3: disable() grava history com flow e ator; na MESMA conexão o UPDATE cru volta a falhar', async () => {
    const id = await novoWorker('ca2');
    const c: PoolClient = await pool.connect();
    try {
      await c.query('BEGIN');
      await disable(c, id, { flow: 'ACCOUNT_DEACTIVATION', actor: systemActor('t012-e2e') });
      await c.query('COMMIT');

      const h = await historico(id);
      expect(h).toHaveLength(1);
      expect(h[0].flow).toBe('ACCOUNT_DEACTIVATION');
      expect(h[0].new_value).toBe('DISABLED');
      expect(h[0].changed_by).toBe('system:t012-e2e');

      // CA-3: o fluxo era LOCAL à transação — a conexão (mesma) não guarda o carimbo.
      const gu = await c.query<{ v: string }>(`SELECT current_setting('app.status_flow', true) AS v`);
      expect(gu.rows[0].v).toBe('');
      await expect(c.query(`UPDATE workers SET status = 'INCOMPLETE_REGISTER' WHERE id = $1`, [id])).rejects.toThrow(SEM_FLUXO);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('C1: o CHECK de worker_status_history.flow tem os mesmos valores do enum TS (18)', async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'worker_status_history_flow_check'`);
    expect(rows).toHaveLength(1);
    const doBanco = [...rows[0].def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    expect(doBanco).toHaveLength(18);
    expect(WORKER_STATUS_FLOWS).toHaveLength(18);
    expect(new Set(doBanco)).toEqual(new Set(WORKER_STATUS_FLOWS));
    expect([...doBanco].sort()).toEqual([...WORKER_STATUS_FLOWS].sort());
  });

  it('negativo: INSERT em worker_status_history com flow fora da lista cai no CHECK', async () => {
    const id = await novoWorker('neg');
    await expect(pool.query(
      `INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, flow) VALUES ($1, 'status', 'A', 'B', 'FOO')`,
      [id])).rejects.toThrow(/worker_status_history_flow_check/);
  });

  it('recálculo: worker completo vira REGISTERED com flow no history e worker.registration_completed (RF-4)', async () => {
    const id = await novoWorker('recalc');
    await completeWorkerProfile(pool, id, 'validated');

    const novo = await recalculate(pool, id, { flow: 'PROFILE_FIELDS_EDIT', actor: systemActor('t012-e2e') });
    expect(novo).toBe('REGISTERED');

    const h = await historico(id);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ new_value: 'REGISTERED', flow: 'PROFILE_FIELDS_EDIT' });

    const ev = await pool.query(
      `SELECT payload FROM domain_events WHERE event = 'worker.registration_completed' AND payload->>'workerId' = $1`, [id]);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload.workerId).toBe(id);
  });
});
