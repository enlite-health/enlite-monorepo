/**
 * funnel-stage-skip-reasons.e2e.test.ts @integration
 *
 * Trava um acoplamento que não tem quem avise: a união `STAGE_SKIP_REASONS`
 * (TypeScript) e o `CHECK (skip_reason IN (…))` de `funnel_stage_message_log`
 * (migration 292/296) são a MESMA lista escrita em dois lugares.
 *
 * Sem este teste, acrescentar uma razão de pulo no código e esquecer a migration
 * dá certo em todo teste unitário (mock) e quebra no primeiro pulo em produção —
 * dentro de um handler de evento, onde o erro vira evento não processado.
 *
 * Ele NÃO testa comportamento: testa que as duas listas continuam sendo uma só.
 */
import { Pool } from 'pg';
import { STAGE_SKIP_REASONS } from '../../src/shared/events/handlers/StageMessageHandler';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('skip_reason: a união do código e o CHECK do banco são a mesma lista @integration', () => {
  let pool: Pool;
  let workerId = '';
  let jobId = '';

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    workerId = (await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country) VALUES ($1, $2, '+5491199990099', 'REGISTERED', 'AR') RETURNING id`,
      [`skip-reasons-${Date.now()}`, `skip-reasons-${Date.now()}@e2e.local`],
    )).rows[0].id;
    jobId = (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, title, status, country) VALUES (99899, 'CASO skip reasons', 'SEARCHING', 'AR') RETURNING id`,
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM funnel_stage_message_log WHERE worker_id = $1`, [workerId]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobId]);
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
    await pool.end();
  });

  it('o banco aceita TODAS as razões que o código sabe emitir', async () => {
    for (const reason of STAGE_SKIP_REASONS) {
      await expect(
        pool.query(
          `INSERT INTO funnel_stage_message_log
             (worker_id, job_posting_id, stage, template_slug, actor_uid, source, outbox_id, status, skip_reason, country)
           VALUES ($1, $2, 'COMPLETED', NULL, NULL, 'kanban', NULL, 'skipped', $3, 'AR')`,
          [workerId, jobId, reason],
        ),
      ).resolves.toBeDefined();
    }
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(DISTINCT skip_reason) AS n FROM funnel_stage_message_log WHERE worker_id = $1`, [workerId],
    );
    expect(Number(rows[0].n)).toBe(STAGE_SKIP_REASONS.length);
  });

  it('e recusa razão que o código NÃO conhece — o CHECK está vivo, não é decorativo', async () => {
    await expect(
      pool.query(
        `INSERT INTO funnel_stage_message_log
           (worker_id, job_posting_id, stage, template_slug, actor_uid, source, outbox_id, status, skip_reason, country)
         VALUES ($1, $2, 'COMPLETED', NULL, NULL, 'kanban', NULL, 'skipped', 'RAZAO_INVENTADA', 'AR')`,
        [workerId, jobId],
      ),
    ).rejects.toThrow();
  });
});
