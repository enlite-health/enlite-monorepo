/**
 * admin-vacancies-list-sort.test.ts
 *
 * Spec 046 F3 — GET /api/admin/vacancies aceita `sort`/`order` (banco real, sem tela).
 *   feliz: A10 (ordena a lista INTEIRA, entre páginas) · alt1: A11 (400) · alt2: A13 (empate, cada vaga 1x)
 * Nada de WhatsApp, Google ou Ana Care: só linhas em job_postings/workers/worker_job_applications.
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const TAG = 'F3SORT046';
// vaga i tem COMPLETED_PER_VACANCY[i] candidaturas em COMPLETED: 3 vagas EMPATADAS em 2 (A13).
const COMPLETED_PER_VACANCY = [0, 2, 1, 2, 2];
const PAGE = 2;

/** Monotônica na direção pedida e nulos só no fim (NULLS LAST nas duas direções). */
function ordenadoComNulosPorUltimo(values: (string | null)[], order: 'asc' | 'desc'): boolean {
  const firstNull = values.indexOf(null);
  const comValor = firstNull === -1 ? values : values.slice(0, firstNull);
  if (values.slice(comValor.length).some((v) => v !== null)) return false;
  const t = comValor.map((v) => new Date(v as string).getTime());
  return t.every((x, i) => i === 0 || (order === 'asc' ? t[i - 1] <= x : t[i - 1] >= x));
}

type Row = { id: string; stageCounts: Record<string, number>; lastActionAt: string | null };

describe('GET /api/admin/vacancies — sort/order (spec 046 F3)', () => {
  const api = createApiClient();
  let headers: { Authorization: string };
  let pool: Pool;
  const patientIds: string[] = [];
  const vacancyIds: string[] = [];

  const get = (qs: string) =>
    api.get(`/api/admin/vacancies?search=${TAG}&${qs}`, { headers, validateStatus: () => true });

  async function allPages(qs: string): Promise<Row[]> {
    const out: Row[] = [];
    for (let offset = 0; offset < 100; offset += PAGE) {
      const res = await get(`${qs}&limit=${PAGE}&offset=${offset}`);
      expect(res.status).toBe(200);
      out.push(...(res.data.data as Row[]));
      if (res.data.data.length < PAGE) break;
    }
    return out;
  }

  beforeAll(async () => {
    await waitForBackend(api);
    const token = await getMockToken(api, { uid: 'list-sort-admin', email: 'list-sort-admin@e2e.local', role: 'admin' });
    headers = { Authorization: `Bearer ${token}` };
    pool = new Pool({ connectionString: DATABASE_URL });

    for (let i = 0; i < COMPLETED_PER_VACANCY.length; i++) {
      const patientId = await createPatientFixture(pool, `list-sort-${i}`);
      patientIds.push(patientId);
      const v = await pool.query(
        `INSERT INTO job_postings (title, description, country, status, patient_id, case_number, providers_needed, talentum_published_at)
         VALUES ($1, 'desc', 'AR', 'SEARCHING', $2, $3, '4', $4) RETURNING id`,
        [`${TAG} vaga ${i}`, patientId, 99950 + i, null],
      );
      const vacancyId = v.rows[0].id as string;
      vacancyIds.push(vacancyId);
      for (let k = 0; k < COMPLETED_PER_VACANCY[i]; k++) {
        const suffix = `${i}-${k}-${Date.now()}`;
        const w = await pool.query(
          `INSERT INTO workers (auth_uid, email, country, timezone, status)
           VALUES ($1, $2, 'AR', 'America/Argentina/Buenos_Aires', 'REGISTERED') RETURNING id`,
          [`uid-f3sort-${suffix}`, `worker-${suffix}@f3sort.test`],
        );
        await pool.query(
          `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage)
           VALUES ($1, $2, 'COMPLETED')`,
          [w.rows[0].id, vacancyId],
        );
      }
    }
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1::uuid[])`, [vacancyIds]);
    await pool.query(`DELETE FROM workers WHERE email LIKE '%@f3sort.test'`);
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [vacancyIds]);
    await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [patientIds]);
    await pool.end();
  });

  // ── feliz: A10 ──────────────────────────────────────────────────────────────
  it('A10 feliz: sort=completed&order=desc ordena a lista INTEIRA (fim da pág. 1 >= início da pág. 2)', async () => {
    const p1 = await get(`sort=completed&order=desc&limit=${PAGE}&offset=0`);
    const p2 = await get(`sort=completed&order=desc&limit=${PAGE}&offset=${PAGE}`);
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    expect(p1.data.total).toBe(5);
    const lastOfP1 = p1.data.data[p1.data.data.length - 1].stageCounts.COMPLETED;
    const firstOfP2 = p2.data.data[0].stageCounts.COMPLETED;
    expect(lastOfP1).toBeGreaterThanOrEqual(firstOfP2);

    const all = await allPages('sort=completed&order=desc');
    expect(all.map((r) => r.stageCounts.COMPLETED)).toEqual([2, 2, 2, 1, 0]);
  });

  it('A10 feliz: sort=lastActionAt ordena a lista inteira, nulos por último nas duas direções', async () => {
    // lastActionAt = GREATEST(nota, histórico de funil, talentum_published_at): as candidaturas
    // semeadas geram histórico com a hora da inserção, então o valor NÃO é o PUBLISHED_AT.
    // Derivamos o esperado do que o próprio payload devolve e afirmamos a ORDEM.
    const desc = (await allPages('sort=lastActionAt&order=desc')).map((r) => r.lastActionAt);
    const asc = (await allPages('sort=lastActionAt&order=asc')).map((r) => r.lastActionAt);
    expect(desc).toHaveLength(vacancyIds.length);
    expect(asc).toHaveLength(vacancyIds.length);
    // a vaga 0 (sem candidatura, sem publicação) é a única sem última ação
    expect(desc.filter((d) => d === null)).toHaveLength(1);
    expect(asc.filter((d) => d === null)).toHaveLength(1);
    expect(ordenadoComNulosPorUltimo(desc, 'desc')).toBe(true);
    expect(ordenadoComNulosPorUltimo(asc, 'asc')).toBe(true);
  });

  it('sabotagem: o comparador REPROVA lista invertida, nulo fora do fim e direção errada', () => {
    const d = ['2026-10-04T00:00:00.000Z', '2026-10-03T00:00:00.000Z', '2026-10-01T00:00:00.000Z', null];
    expect(ordenadoComNulosPorUltimo(d, 'desc')).toBe(true);
    expect(ordenadoComNulosPorUltimo([...d].reverse(), 'desc')).toBe(false); // invertida
    expect(ordenadoComNulosPorUltimo(d, 'asc')).toBe(false); // direção errada
    expect(ordenadoComNulosPorUltimo([null, ...d.slice(0, 3)], 'desc')).toBe(false); // nulo primeiro
  });

  // ── alt1: A11 ───────────────────────────────────────────────────────────────
  it.each([
    ['sort=case'],
    ['sort=status'],
    ['sort=name'],
    ['sort=created_at'],
    ['sort=created_at;drop%20table%20job_postings'],
    ['sort=completed&order=sideways'],
    ['sort=completed&order=asc%20nulls%20first'],
  ])('A11 alt1: %s -> 400', async (qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect(res.data.success).toBe(false);
  });

  // ── alt2: A13 ───────────────────────────────────────────────────────────────
  it('A13 alt2: com empate na chave, percorrer todas as páginas devolve cada vaga EXATAMENTE uma vez', async () => {
    for (const order of ['asc', 'desc']) {
      const all = await allPages(`sort=completed&order=${order}`);
      const ids = all.map((r) => r.id);
      expect(ids).toHaveLength(vacancyIds.length);
      expect([...ids].sort()).toEqual([...vacancyIds].sort());
      // A19: o valor que ordenou é o que o payload devolve na coluna
      const valores = all.map((r) => r.stageCounts.COMPLETED);
      const esperado = [...valores].sort((a, b) => (order === 'asc' ? a - b : b - a));
      expect(valores).toEqual(esperado);
    }
  });

  it('A12: sem sort, a ordem é created_at DESC e a lista continua paginada no SQL', async () => {
    const res = await get(`limit=${vacancyIds.length}&offset=0`);
    expect(res.status).toBe(200);
    const ids = (res.data.data as Row[]).map((r) => r.id);
    expect(ids).toEqual([...vacancyIds].reverse());
  });
});
