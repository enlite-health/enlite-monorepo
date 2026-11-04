/**
 * worker-count-reader-085.e2e.test.ts — change 085 (T107), banco REAL, sem mock.
 *
 * Prova que o `WorkerCountReader` conta IGUAL ao dono de cada campo:
 *  (a) apto=true == COUNT(*) FILTER (WHERE fn_worker_is_apto) no mesmo recorte;
 *  (b) has_phone=false == SQL direto com o critério do dono (`phone IS NOT NULL AND phone <> ''`);
 *  (c) worker com 2 áreas na MESMA zona conta 1 (DISTINCT worker);
 *  (d) worker is_test=true não conta;
 *  (e) DISABLED só conta quando o filtro `registration` o nomeia.
 * Massa SINTÉTICA (nomes fake, telefones +5490000000xx). Esperado exato por DELTA sobre o baseline medido antes
 * de semear, porque o banco do e2e pode ter workers de outros arquivos.
 */
import { Pool } from 'pg';
import { WorkerCountReader, type WorkerCountRequest } from '../../src/modules/agentes/infrastructure/WorkerCountReader';
import { resolveZoneKey } from '../../src/shared/utils/zoneKey';
import { completeWorkerProfile, cleanWorkerProfile } from './helpers/aptoWorkerFixture';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const ID = {
  apto: 'a1070000-0000-4000-a000-000000000001', // REGISTERED, apto, 2 áreas em Córdoba + 1 em Salta
  semFone: 'a1070000-0000-4000-a000-000000000002', // INCOMPLETE_REGISTER, phone '' , sem área
  naoApto: 'a1070000-0000-4000-a000-000000000003', // REGISTERED, docs não validados, 1 área Córdoba
  teste: 'a1070000-0000-4000-a000-000000000004', // is_test=true, apto, Córdoba
  baixa: 'a1070000-0000-4000-a000-000000000005', // DISABLED, Córdoba
};
const ALL = Object.values(ID);
const COUNTRIES = ['AR'] as never[];
const CORDOBA = resolveZoneKey('Córdoba', null).label;
const SALTA = resolveZoneKey('Salta', null).label;

describe('WorkerCountReader × donos (banco real)', () => {
  let pool: Pool;
  let reader: WorkerCountReader;

  const req = (filters: WorkerCountRequest['filters'] = [], group_by: string | null = null): WorkerCountRequest => ({
    filters,
    group_by,
  });
  const total = async (r: WorkerCountRequest) => (await reader.count(r, COUNTRIES)).total;
  const sqlCount = async (extra: string): Promise<number> =>
    (
      await pool.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM workers w
          WHERE w.merged_into_id IS NULL AND w.is_test = false AND w.country = ANY($1::bpchar[])
            AND COALESCE(w.status,'') <> 'DISABLED' ${extra}`,
        [COUNTRIES],
      )
    ).rows[0].n;

  const base = {} as Record<string, number>;
  const measure = async (): Promise<Record<string, number>> => ({
    total: await total(req()),
    apto: await total(req([{ field: 'apto', values: ['true'] }])),
    semFone: await total(req([{ field: 'has_phone', values: ['false'] }])),
    cordoba: await total(req([{ field: 'zone', values: [CORDOBA] }])),
    disabled: await total(req([{ field: 'registration', values: ['DISABLED'] }])),
  });

  async function seed(id: string, o: { status: string; phone: string | null; isTest?: boolean }): Promise<void> {
    await pool.query(
      `INSERT INTO workers (id, auth_uid, email, phone, status, country, timezone, is_test)
       VALUES ($1, $2, $3, $4, $5, 'AR', 'America/Argentina/Buenos_Aires', $6)`,
      [id, `uid-107-${id.slice(-2)}`, `wcr-107-${id.slice(-2)}@e2e.test`, o.phone, o.status, o.isTest ?? false],
    );
  }
  const area = (workerId: string, state: string, city: string) =>
    pool.query(
      `INSERT INTO worker_service_areas (worker_id, address_line, radius_km, state, city) VALUES ($1, 'Av. Fake 1', 5, $2, $3)`,
      [workerId, state, city],
    );

  async function cleanup(): Promise<void> {
    await cleanWorkerProfile(pool, ALL);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ALL]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    reader = new WorkerCountReader(pool);
    await cleanup();
    Object.assign(base, await measure());

    await seed(ID.apto, { status: 'REGISTERED', phone: '+5490000000001' });
    await completeWorkerProfile(pool, ID.apto, 'validated');
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [ID.apto]);
    await area(ID.apto, 'Córdoba', 'Córdoba');
    await area(ID.apto, 'Córdoba', 'Villa Carlos Paz');
    await area(ID.apto, 'Salta', 'Salta');

    await seed(ID.semFone, { status: 'INCOMPLETE_REGISTER', phone: '' });

    await seed(ID.naoApto, { status: 'REGISTERED', phone: '+5490000000003' });
    await completeWorkerProfile(pool, ID.naoApto, 'unvalidated');
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [ID.naoApto]);
    await area(ID.naoApto, 'Córdoba', 'Córdoba');

    await seed(ID.teste, { status: 'REGISTERED', phone: '+5490000000004', isTest: true });
    await completeWorkerProfile(pool, ID.teste, 'validated');
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = $1`, [ID.teste]);
    await area(ID.teste, 'Córdoba', 'Córdoba');

    await seed(ID.baixa, { status: 'DISABLED', phone: '+5490000000005' });
    await area(ID.baixa, 'Córdoba', 'Córdoba');
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('sanidade da massa: o dono diz que o apto é apto, o naoApto e o is_test conforme esperado', async () => {
    const r = await pool.query<{ id: string; apto: boolean }>(
      `SELECT id, fn_worker_is_apto(id) AS apto FROM workers WHERE id = ANY($1::uuid[])`,
      [ALL],
    );
    const apto = Object.fromEntries(r.rows.map((x) => [x.id, x.apto]));
    expect(apto[ID.apto]).toBe(true);
    expect(apto[ID.naoApto]).toBe(false);
    expect(apto[ID.teste]).toBe(true); // apto de verdade, mas is_test: tem de ficar de fora
  });

  it('(a) apto=true == COUNT(*) FILTER (fn_worker_is_apto) no mesmo recorte', async () => {
    const dono = await sqlCount('AND fn_worker_is_apto(w.id)');
    const lido = await total(req([{ field: 'apto', values: ['true'] }]));
    expect(lido).toBe(dono);
    expect(lido).toBe(base.apto + 1); // só ID.apto (teste e baixa ficam fora)
    const falso = await total(req([{ field: 'apto', values: ['false'] }]));
    expect(falso).toBe(await sqlCount('AND NOT fn_worker_is_apto(w.id)'));
  });

  it('(b) has_phone=false == SQL direto com o critério do dono', async () => {
    const dono = await sqlCount(`AND NOT (w.phone IS NOT NULL AND w.phone <> '')`);
    const lido = await total(req([{ field: 'has_phone', values: ['false'] }]));
    expect(lido).toBe(dono);
    expect(lido).toBe(base.semFone + 1); // só ID.semFone
  });

  it('(c) worker com 2 áreas na mesma zona conta 1 (filtro e group_by)', async () => {
    expect(await total(req([{ field: 'zone', values: [CORDOBA] }]))).toBe(base.cordoba + 2); // apto + naoApto
    const g = await reader.count(req([], 'zone'), COUNTRIES);
    const val = (k: string) => g.groups!.find((x) => x.key === k)?.value ?? 0;
    expect(val(CORDOBA)).toBeGreaterThanOrEqual(2);
    expect(val(SALTA)).toBeGreaterThanOrEqual(1);
    // sem área (semFone) cai no bucket "Não informado"
    expect(g.groups!.some((x) => x.key === resolveZoneKey(null, null).label)).toBe(true);
    // total = workers distintos do recorte, não a soma dos grupos (apto está em Córdoba e Salta)
    expect(g.total).toBe(base.total + 3); // apto, semFone, naoApto
  });

  it('(d) is_test=true não conta, nem por zona nem por apto', async () => {
    expect(await total(req())).toBe(base.total + 3);
    const porZona = await reader.count(req([{ field: 'zone', values: [CORDOBA] }], 'apto'), COUNTRIES);
    const apto = porZona.groups!.find((x) => x.key === 'true')?.value ?? 0;
    expect(apto).toBe(base.apto + 1);
  });

  it('(e) DISABLED só conta se nomeado', async () => {
    expect(await total(req())).toBe(base.total + 3); // baixa fora
    expect(await total(req([{ field: 'registration', values: ['REGISTERED'] }]))).toBe(
      await sqlCount(`AND w.status = 'REGISTERED'`),
    );
    expect(await total(req([{ field: 'registration', values: ['DISABLED'] }]))).toBe(base.disabled + 1);
    const g = await reader.count(req([], 'registration'), COUNTRIES);
    expect(g.groups!.map((x) => x.key)).not.toContain('DISABLED');
    const gd = await reader.count(req([{ field: 'registration', values: ['DISABLED', 'REGISTERED'] }], 'registration'), COUNTRIES);
    expect(gd.groups!.map((x) => x.key)).toContain('DISABLED');
  });
});
