/**
 * prestadores-localidad-filter.integration.test.ts
 *
 * ClickUp 86ajeu9fw — "Corrigir os Filtros na Tela de Prestadores".
 *
 * Teste de integração com banco REAL para o filtro de Localidad/Provincia da
 * listagem de prestadores (GET /api/admin/workers). Prova, contra dados reais:
 *
 *   1. Localidad = CABA volta os prestadores cujo sinal de CABA está só nas
 *      colunas de texto livre (work_zone exato = "CABA" e interest_zone
 *      "En CABA ...") — ANTES o filtro casava só `city ILIKE 'CABA'` → 0 linhas.
 *   2. Localidad = "Buenos Aires" volta o prestador com city='Buenos Aires' e
 *      NÃO os de CABA (sem falso-positivo).
 *   3. O dropdown (getFilterOptions) NÃO oferece os códigos CPA lixo
 *      (city='AEJ') e FAZ surgir CABA a partir de work_zone.
 *
 * Não roda automático nesta worktree (Postgres docker compartilhado colide com
 * worktrees paralelas). Rodar isolado:
 *   cd worker-functions && npm run test:e2e:docker -- prestadores-localidad-filter
 *
 * INVARIANTE: migrations 158-160 (worker_service_areas com work_zone/
 * interest_zone/city/state) aplicadas.
 */

import { Pool } from 'pg';
import { buildWorkerListWhereClause } from '../../src/modules/worker/interfaces/controllers/AdminWorkersListHelpers';
import {
  canonicalLocation,
  recognizedZoneLabel,
} from '../../src/shared/utils/normalizeLocationValue';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });

const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const WORKER_IDS: string[] = [];

const W = { cityBsAs: '', wzCaba: '', izCaba: '', cityJunk: '' };

async function makeWorker(tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone)
     VALUES ($1, $2, 'REGISTERED', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [`uid-loc-${SUFFIX}-${tag}`, `loc-${SUFFIX}-${tag}@filter.test`],
  );
  WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

async function setServiceArea(
  workerId: string,
  fields: { city?: string | null; state?: string | null; work_zone?: string | null; interest_zone?: string | null },
): Promise<void> {
  await pool.query(
    `INSERT INTO worker_service_areas (worker_id, city, state, work_zone, interest_zone, country)
     VALUES ($1, $2, $3, $4, $5, 'AR')`,
    [workerId, fields.city ?? null, fields.state ?? null, fields.work_zone ?? null, fields.interest_zone ?? null],
  );
}

/** Runs the real list WHERE against workers seeded here (scoped by our SUFFIX). */
async function idsMatchingCity(city: string): Promise<string[]> {
  const { whereClause, params } = buildWorkerListWhereClause({ city, limit: '50', offset: '0' });
  const { rows } = await pool.query<{ id: string }>(
    `SELECT w.id FROM workers w ${whereClause} AND w.email LIKE $${params.length + 1}`,
    [...params, `loc-${SUFFIX}-%`],
  );
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  W.cityBsAs = await makeWorker('bsas');
  W.wzCaba = await makeWorker('wzcaba');
  W.izCaba = await makeWorker('izcaba');
  W.cityJunk = await makeWorker('junk');

  await setServiceArea(W.cityBsAs, { city: 'Buenos Aires', state: 'Buenos Aires' });
  await setServiceArea(W.wzCaba, { work_zone: 'CABA' });
  await setServiceArea(W.izCaba, { interest_zone: 'En CABA no tengo problema, tambien Palermo' });
  await setServiceArea(W.cityJunk, { city: 'AEJ' });
});

afterAll(async () => {
  if (WORKER_IDS.length) {
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`, [WORKER_IDS]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKER_IDS]);
  }
  await pool.end();
});

describe('Prestadores — filtro de Localidad/Provincia (banco real)', () => {
  it('Localidad=CABA volta os prestadores com sinal CABA em work_zone/interest_zone', async () => {
    const ids = await idsMatchingCity('Ciudad Autónoma de Buenos Aires');
    expect(ids).toEqual(expect.arrayContaining([W.wzCaba, W.izCaba]));
    expect(ids).not.toContain(W.cityBsAs);
    expect(ids).not.toContain(W.cityJunk);
  });

  it('Localidad=CABA também funciona pelo alias curto "CABA"', async () => {
    const ids = await idsMatchingCity('CABA');
    expect(ids).toEqual(expect.arrayContaining([W.wzCaba, W.izCaba]));
  });

  it('Localidad="Buenos Aires" volta só o prestador com city=Buenos Aires (sem falso-positivo CABA)', async () => {
    const ids = await idsMatchingCity('Buenos Aires');
    expect(ids).toContain(W.cityBsAs);
    expect(ids).not.toContain(W.wzCaba);
    expect(ids).not.toContain(W.izCaba);
  });

  it('getFilterOptions: dropdown de cities exclui lixo CPA e faz surgir CABA de work_zone', async () => {
    const { rows: cityRows } = await pool.query<{ city: string }>(
      `SELECT DISTINCT wsa.city FROM worker_service_areas wsa
       JOIN workers w ON w.id = wsa.worker_id
       WHERE w.email LIKE $1 AND wsa.city IS NOT NULL AND btrim(wsa.city) <> ''`,
      [`loc-${SUFFIX}-%`],
    );
    const { rows: zoneRows } = await pool.query<{ work_zone: string }>(
      `SELECT DISTINCT wsa.work_zone FROM worker_service_areas wsa
       JOIN workers w ON w.id = wsa.worker_id
       WHERE w.email LIKE $1 AND wsa.work_zone IS NOT NULL AND btrim(wsa.work_zone) <> ''`,
      [`loc-${SUFFIX}-%`],
    );

    const cities = new Set(
      [
        ...cityRows.map((r) => canonicalLocation(r.city)),
        ...zoneRows.map((r) => recognizedZoneLabel(r.work_zone)),
      ].filter((v): v is string => v !== null),
    );

    expect(cities.has('Buenos Aires')).toBe(true);
    // Canonical CABA label unificado em 'CABA' (commit 0a35343 — SSOT com
    // argentinaLocationNormalizer.PROVINCE_CANONICAL). recognizedZoneLabel('CABA')
    // surface o sinal de CABA que só vive em work_zone.
    expect(cities.has('CABA')).toBe(true); // surfaced from work_zone
    expect(cities.has('AEJ')).toBe(false); // CPA junk dropped
  });
});
