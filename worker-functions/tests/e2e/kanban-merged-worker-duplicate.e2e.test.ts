/**
 * kanban-merged-worker-duplicate.e2e.test.ts
 *
 * Regressão do caso Norma Araujo (13/08, CASO 762-469): a MESMA prestadora
 * aparecia duas vezes no Kanban da mesma vaga — um card em "Confirmados" e
 * outro em "Completado". O time moveu um e o outro não acompanhou, porque são
 * duas linhas independentes de `worker_job_applications`.
 *
 * A trava contra postulação dupla (`UNIQUE (worker_id, job_posting_id)`) existe,
 * mas é por ID de worker: a pessoa tinha dois cadastros, um já fundido no outro
 * desde 23/06, e o webhook do Talentum resolveu pelo e-mail antigo e escreveu no
 * registro morto. Dois IDs da mesma pessoa passam pelos dois lados da constraint.
 *
 * Sem mocks. Banco real. É o único jeito de provar isto: um teste mockado não vê
 * a constraint nem a resolução SQL da cadeia de merge.
 *
 * Cobre:
 *   1. `resolveCanonicalWorkerId` — vivo, 1 salto, 2 saltos, inexistente, ciclo
 *   2. o card do registro fundido não aparece no Kanban da vaga (o bug relatado)
 *   3. o card do registro vivo continua aparecendo (não escondemos demais)
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';
import {
  resolveCanonicalWorkerId,
  MAX_MERGE_CHAIN_DEPTH,
} from '../../src/shared/database/canonicalWorker';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const STAMP = `merged_dup_${Date.now()}`;

describe('Kanban da vaga — registro fundido não vira card duplicado', () => {
  const api = createApiClient();
  let adminToken: string;
  let pool: Pool;
  let patientId: string;
  let vacancyId: string;

  /** Sobrevivente do merge — a pessoa de verdade. */
  let survivorId: string;
  /** Absorvido — mesma pessoa, cadastro antigo (`merged_into_id` → survivor). */
  let mergedId: string;
  /** Absorvido pelo absorvido — cadeia de 2 saltos. */
  let mergedTwiceId: string;

  async function insertWorker(suffix: string): Promise<string> {
    const res = await pool.query(
      `INSERT INTO workers (auth_uid, email, country, timezone)
       VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires')
       RETURNING id`,
      [`uid-${STAMP}-${suffix}`, `${STAMP}-${suffix}@merged.test`],
    );
    return res.rows[0].id as string;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    adminToken = await getMockToken(api, {
      uid: `merged-dup-admin-${STAMP}`,
      email: `merged-dup-admin-${STAMP}@e2e.local`,
      role: 'admin',
    });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'merged-dup');

    const vacancy = await pool.query(
      `INSERT INTO job_postings (title, country, status, patient_id, case_number)
       VALUES ('Caso E2E merged dup', 'AR', 'SEARCHING', $1, 99982)
       RETURNING id`,
      [patientId],
    );
    vacancyId = vacancy.rows[0].id as string;

    survivorId = await insertWorker('survivor');
    mergedId = await insertWorker('merged');
    mergedTwiceId = await insertWorker('merged-twice');

    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [survivorId, mergedId]);
    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [
      mergedId,
      mergedTwiceId,
    ]);

    // O caso real: duas postulações na MESMA vaga, uma em cada cadastro da mesma
    // pessoa. A UNIQUE não impede — os worker_id são diferentes.
    // source='talentum' passa pelo guard de INCOMPLETE_REGISTER (mesmo motivo do
    // admin-kanban-interview-source).
    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, source)
       VALUES ($1, $2, 'CONFIRMED', 'talentum')`,
      [survivorId, vacancyId],
    );
    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage, match_score, source)
       VALUES ($1, $2, 'QUALIFIED', 6.60, 'talentum')`,
      [mergedId, vacancyId],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    const ids = [survivorId, mergedId, mergedTwiceId].filter(Boolean);
    await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [ids]);
    // A cadeia precisa ser desfeita antes do DELETE: merged_into_id é auto-FK.
    await pool.query(`UPDATE workers SET merged_into_id = NULL WHERE id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ids]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [vacancyId]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [patientId]);
    await pool.end();
  });

  // ── 1. O helper, contra a cadeia real ───────────────────────────────────────

  it('worker vivo resolve para ele mesmo', async () => {
    expect(await resolveCanonicalWorkerId(pool, survivorId)).toBe(survivorId);
  });

  it('worker fundido resolve para o sobrevivente (o bug)', async () => {
    expect(await resolveCanonicalWorkerId(pool, mergedId)).toBe(survivorId);
  });

  it('cadeia de 2 saltos resolve até o fim', async () => {
    expect(await resolveCanonicalWorkerId(pool, mergedTwiceId)).toBe(survivorId);
  });

  it('ID inexistente resolve para null (não inventa pessoa)', async () => {
    expect(
      await resolveCanonicalWorkerId(pool, '00000000-0000-0000-0000-000000000000'),
    ).toBeNull();
  });

  it(`ciclo devolve null em vez de rodar para sempre (trava de ${MAX_MERGE_CHAIN_DEPTH} saltos)`, async () => {
    // Fecha o ciclo: survivor → merged → survivor. Nada no schema impede.
    await pool.query(`UPDATE workers SET merged_into_id = $1 WHERE id = $2`, [mergedId, survivorId]);
    try {
      expect(await resolveCanonicalWorkerId(pool, mergedId)).toBeNull();
    } finally {
      await pool.query(`UPDATE workers SET merged_into_id = NULL WHERE id = $1`, [survivorId]);
    }
  });

  // ── 2. A tela: um card por pessoa ───────────────────────────────────────────

  it('o Kanban da vaga mostra UM card da pessoa — o do registro vivo, não o do fundido', async () => {
    const res = await api.get(`/api/admin/vacancies/${vacancyId}/funnel`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);

    const stages = res.data.data.stages as Record<string, Array<Record<string, unknown>>>;
    const allCards = Object.values(stages).flat();

    const survivorCards = allCards.filter((c) => c.workerId === survivorId);
    const mergedCards = allCards.filter((c) => c.workerId === mergedId);

    // O card fantasma — o que o time viu em "Completado" com o score do Talentum.
    expect(mergedCards).toHaveLength(0);
    // E o card real continua lá: o filtro não pode esconder a pessoa da vaga.
    expect(survivorCards).toHaveLength(1);
    expect(stages.CONFIRMED.some((c) => c.workerId === survivorId)).toBe(true);
  });
});
