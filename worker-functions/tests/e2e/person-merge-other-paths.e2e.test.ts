/**
 * person-merge-other-paths.e2e.test.ts — os outros caminhos de merge também unem as pessoas
 * (spec acesso-do-cliente, F1, item 15 (i); D648).
 *
 * (i)  lote por CLI: `WorkerPhoneMergeService.execute()` com grupo *ghost* de uid REAL (e-mail @enlite.import) →
 *      `iam.person.merged_into_id` preenchido para a pessoa do ghost, com o auditId do merge.
 * O caminho do dedup por LLM (`WorkerDeduplicationService.mergeWorkers`) NÃO tem e2e aqui: `POST /analytics/dedup/run`
 * não fecha contra o schema migrado (defeito pré-existente, na LISTA da T130). A ordem do gancho nele é provada por
 * unit: src/infrastructure/services/__tests__/worker-deduplication-merge-person.test.ts.
 *
 * Fixtures sintéticas (`@enlite.test`/`@enlite.import`, sufixo único); iam.* é append-only e não é apagado.
 */
import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';
import { WorkerPhoneMergeService } from '../../src/infrastructure/services/WorkerPhoneMergeService';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const RUN = randomBytes(4).toString('hex');
let pool: Pool;

async function seedWorker(label: string, email: string, phone: string): Promise<{ id: string; uid: string }> {
  const id = randomUUID();
  const uid = `e2e-op-${RUN}-${label}`;
  await pool.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW())`,
    [id, uid, email, phone],
  );
  return { id, uid };
}

const personOf = async (uid: string): Promise<string> =>
  (await pool.query(`SELECT iam.ensure_person('firebase', $1) AS p`, [uid])).rows[0].p;

async function personRow(personId: string): Promise<{ merged_into_id: string | null; audit: string | null }> {
  const r = await pool.query(
    `SELECT merged_into_id, merged_by_worker_merge_audit_id AS audit FROM iam.person WHERE id = $1`,
    [personId],
  );
  return r.rows[0];
}

beforeAll(async () => {
  pool = new Pool({ connectionString: DATABASE_URL });
  (DatabaseConnection.getInstance() as unknown as { pool: Pool }).pool = pool;
});

afterAll(async () => {
  await pool.end();
});

describe('(i) merge em lote pela CLI (ghost de uid real)', () => {
  it('execute() une a pessoa do ghost à pessoa do real, com o auditId do merge', async () => {
    // mesmo phone_normalized com raw diferente (10 dígitos × 13 dígitos): ghost = e-mail @enlite.import, uid REAL
    const base = `1133${(parseInt(RUN, 16) % 1000000).toString().padStart(6, '0')}`;
    const real = await seedWorker('real-i', `real-i-${RUN}@enlite.test`, `549${base}`);
    const ghost = await seedWorker('ghost-i', `ghost-i-${RUN}@enlite.import`, base);
    const pReal = await personOf(real.uid);
    const pGhost = await personOf(ghost.uid);
    expect(pReal).not.toBe(pGhost);

    const result = await new WorkerPhoneMergeService().execute();
    expect(result.errors ?? []).toEqual([]);

    const row = await personRow(pGhost);
    expect(row.merged_into_id).toBe(pReal);
    const audit = await pool.query(
      `SELECT id FROM worker_merge_audit WHERE survivor_id = $1::uuid AND absorbed_id = $2::uuid`,
      [real.id, ghost.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(String(row.audit)).toBe(String(audit.rows[0].id));
  });
});
