/**
 * 077-itinerario-segue-merge.e2e.test.ts @integration — spec 077 F3c (C-47, FR-91): o `GetWorkerItineraryUseCase` roda em
 * processo contra Postgres REAL (SQL de `resolveCanonicalWorkerId` e do `workers`, não dublê). O uid de uma conta ABSORVIDA
 * numa união devolve o envelope do SOBREVIVENTE; uid sem merge, o próprio; sobrevivente DISABLED → AccountInactiveError.
 * Dono do banco (bypassa RLS): prova o SQL do caminho, não a RLS. Sem PII: e-mails `@enlite.test`, fones sintéticos.
 */
import { Pool } from 'pg';
import { GetWorkerItineraryUseCase, AccountInactiveError } from '../../src/modules/case/application/GetWorkerItineraryUseCase';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TODAY = '2026-11-20';

describe('itinerário segue o merge (077 C-47/FR-91) @integration', () => {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  const ids: string[] = [];
  let seq = 0;

  async function worker(opts: { status?: string; mergedInto?: string | null } = {}): Promise<{ id: string; uid: string }> {
    seq += 1;
    const uid = `077-merge-uid-${RUN}-${seq}`;
    const r = await pool.query<{ id: string }>(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, merged_into_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'AR', $5, NOW(), NOW()) RETURNING id`,
      [uid, `${uid}@enlite.test`, `+5491177${String(RUN).slice(-5)}${seq}`, opts.status ?? 'REGISTERED', opts.mergedInto ?? null],
    );
    ids.push(r.rows[0].id);
    return { id: r.rows[0].id, uid };
  }

  afterAll(async () => {
    // absorvidos primeiro (FK merged_into_id), depois sobreviventes
    await pool.query('DELETE FROM workers WHERE id = ANY($1::uuid[]) AND merged_into_id IS NOT NULL', [ids]);
    await pool.query('DELETE FROM workers WHERE id = ANY($1::uuid[])', [ids]);
    await pool.end();
  });

  const run = (uid: string) => new GetWorkerItineraryUseCase(pool).execute({ uid, today: TODAY });

  it('uid absorvido → envelope do sobrevivente', async () => {
    const survivor = await worker();
    const absorbed = await worker({ mergedInto: survivor.id });
    expect((await run(absorbed.uid)).worker_id).toBe(survivor.id);
  });

  it('corrente de 2 saltos (A → B → C) → envelope do vivo final', async () => {
    const c = await worker();
    const b = await worker({ mergedInto: c.id });
    const a = await worker({ mergedInto: b.id });
    expect((await run(a.uid)).worker_id).toBe(c.id);
  });

  it('uid sem merge → o próprio worker', async () => {
    const w = await worker();
    expect((await run(w.uid)).worker_id).toBe(w.id);
  });

  it('absorvido cujo sobrevivente está DISABLED → AccountInactiveError (vale o status do sobrevivente)', async () => {
    const survivor = await worker({ status: 'DISABLED' });
    const absorbed = await worker({ mergedInto: survivor.id });
    await expect(run(absorbed.uid)).rejects.toBeInstanceOf(AccountInactiveError);
  });
});
