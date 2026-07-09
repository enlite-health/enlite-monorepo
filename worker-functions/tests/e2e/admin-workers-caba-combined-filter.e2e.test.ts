/**
 * admin-workers-caba-combined-filter.e2e.test.ts
 *
 * ClickUp 86ajeu9fw — prova de GARANTIA para o filtro de Localidad da listagem
 * de prestadores, batendo no ENDPOINT REAL (GET /api/admin/workers), com banco
 * real e sexo real (blind index) — não mock.
 *
 * Cobre o que faltava na suite de filtros existente:
 *   1. Localidad=CABA no endpoint real (CABA vive só em work_zone/interest_zone,
 *      NÃO em city) — o bug do card.
 *   2. sex=male FILTRA de fato (a suite antiga só checava HTTP 200) — female é
 *      excluída.
 *   3. A combinação EXATA do card: docs_complete=complete + sex=male + city=CABA,
 *      com 4 decoys (sexo errado / status errado / fora de CABA) que DEVEM sair.
 *   4. filter-options no endpoint: dropdown exclui lixo CPA ('AEJ') e faz surgir
 *      CABA a partir de work_zone.
 *
 * sex_bidx é semeado com o MESMO BlindIndexService/TEST_KEY que a API usa em
 * testMode (USE_KMS_ENCRYPTION=false / NODE_ENV=test), então o HMAC casa 1:1
 * com o que appendSexFilter computa no request.
 *
 * Rodar isolado (Postgres docker compartilhado entre worktrees):
 *   cd worker-functions && DATABASE_URL=...:5433/enlite_e2e API_URL=http://localhost:8080 \
 *     npx jest --config jest.config.e2e.js admin-workers-caba-combined-filter
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { BlindIndexService } from '@shared/security/BlindIndexService';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const PREFIX = 'caba-e2e';

// Deterministic UUIDs for this suite (8-4-4-4-12 hex).
const IDS = {
  target: 'caba0001-0000-0000-0001-000000000001', // REGISTERED + male + work_zone=CABA
  female: 'caba0001-0000-0000-0001-000000000002', // REGISTERED + female + work_zone=CABA
  incompl: 'caba0001-0000-0000-0001-000000000003', // INCOMPLETE + male + work_zone=CABA
  notcaba: 'caba0001-0000-0000-0001-000000000004', // REGISTERED + male + city=Buenos Aires
  interest: 'caba0001-0000-0000-0001-000000000005', // REGISTERED + male + interest_zone "En CABA…"
  junk: 'caba0001-0000-0000-0001-000000000006', // REGISTERED + male + city='AEJ' (lixo CPA)
  sa1: 'caba0001-0000-0000-0002-000000000001',
  sa2: 'caba0001-0000-0000-0002-000000000002',
  sa3: 'caba0001-0000-0000-0002-000000000003',
  sa4: 'caba0001-0000-0000-0002-000000000004',
  sa5: 'caba0001-0000-0000-0002-000000000005',
  sa6: 'caba0001-0000-0000-0002-000000000006',
};

const WORKER_IDS = [
  IDS.target,
  IDS.female,
  IDS.incompl,
  IDS.notcaba,
  IDS.interest,
  IDS.junk,
];

const api = createApiClient();
let pool: Pool;
let adminToken: string;

async function insertWorker(
  p: Pool,
  id: string,
  status: 'REGISTERED' | 'INCOMPLETE_REGISTER',
  sexBidx: Buffer,
): Promise<void> {
  await p.query(
    `INSERT INTO workers (id, auth_uid, email, phone, status, profession, sex_bidx)
     VALUES ($1, $2, $3, $4, $5, 'AT', $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      `${PREFIX}-auth-${id.slice(-8)}`,
      `${PREFIX}-${id.slice(-8)}@caba.e2e.local`,
      `+5491120${id.slice(-6)}`,
      status,
      sexBidx,
    ],
  );
}

async function insertServiceArea(
  p: Pool,
  id: string,
  workerId: string,
  opts: { city?: string; state?: string; workZone?: string; interestZone?: string },
): Promise<void> {
  await p.query(
    `INSERT INTO worker_service_areas
       (id, worker_id, latitude, longitude, radius_km, state, city, work_zone, interest_zone)
     VALUES ($1, $2, -34.6, -58.38, 10, $3, $4, $5, $6)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      workerId,
      opts.state ?? null,
      opts.city ?? null,
      opts.workZone ?? null,
      opts.interestZone ?? null,
    ],
  );
}

async function cleanup(p: Pool): Promise<void> {
  await p.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKER_IDS]);
}

function authHeaders(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

interface WorkerRow {
  id: string;
}

function seededIds(data: WorkerRow[]): Set<string> {
  const seeded = new Set<string>(WORKER_IDS);
  return new Set(data.map((w) => w.id).filter((id) => seeded.has(id)));
}

beforeAll(async () => {
  await waitForBackend(api);

  adminToken = await getMockToken(api, {
    uid: 'caba-admin-e2e',
    email: 'caba-admin@caba.e2e.local',
    role: 'admin',
  });

  // Same BlindIndexService the API uses in testMode → identical HMAC.
  const bidx = new BlindIndexService();
  const maleBidx = await bidx.generateValueBidx('male');
  const femaleBidx = await bidx.generateValueBidx('female');
  if (maleBidx === null || femaleBidx === null) {
    throw new Error('generateValueBidx returned null — cannot seed sex_bidx');
  }

  pool = new Pool({ connectionString: DATABASE_URL });
  await cleanup(pool);

  await insertWorker(pool, IDS.target, 'REGISTERED', maleBidx);
  await insertWorker(pool, IDS.female, 'REGISTERED', femaleBidx);
  await insertWorker(pool, IDS.incompl, 'INCOMPLETE_REGISTER', maleBidx);
  await insertWorker(pool, IDS.notcaba, 'REGISTERED', maleBidx);
  await insertWorker(pool, IDS.interest, 'REGISTERED', maleBidx);
  await insertWorker(pool, IDS.junk, 'REGISTERED', maleBidx);

  await insertServiceArea(pool, IDS.sa1, IDS.target, { workZone: 'CABA' });
  await insertServiceArea(pool, IDS.sa2, IDS.female, { workZone: 'CABA' });
  await insertServiceArea(pool, IDS.sa3, IDS.incompl, { workZone: 'CABA' });
  await insertServiceArea(pool, IDS.sa4, IDS.notcaba, { city: 'Buenos Aires', state: 'Buenos Aires' });
  await insertServiceArea(pool, IDS.sa5, IDS.interest, { interestZone: 'En CABA, zona centro' });
  await insertServiceArea(pool, IDS.sa6, IDS.junk, { city: 'AEJ' });
});

afterAll(async () => {
  if (pool) {
    await cleanup(pool);
    await pool.end();
  }
});

describe('GET /api/admin/workers — Localidad=CABA (endpoint real)', () => {
  it('city=CABA volta os prestadores com sinal CABA em work_zone/interest_zone (não em city)', async () => {
    const res = await api.get(
      '/api/admin/workers?city=CABA&limit=1000',
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    const got = seededIds(res.data.data);
    // work_zone='CABA' e interest_zone "En CABA…"
    expect(got.has(IDS.target)).toBe(true);
    expect(got.has(IDS.female)).toBe(true);
    expect(got.has(IDS.incompl)).toBe(true);
    expect(got.has(IDS.interest)).toBe(true);
    // fora de CABA
    expect(got.has(IDS.notcaba)).toBe(false);
    expect(got.has(IDS.junk)).toBe(false);
  });

  it('sex=male FILTRA de fato — exclui a prestadora feminina (não só HTTP 200)', async () => {
    const res = await api.get(
      '/api/admin/workers?sex=male&limit=1000',
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    const got = seededIds(res.data.data);
    expect(got.has(IDS.target)).toBe(true);
    expect(got.has(IDS.incompl)).toBe(true);
    expect(got.has(IDS.notcaba)).toBe(true);
    expect(got.has(IDS.interest)).toBe(true);
    expect(got.has(IDS.junk)).toBe(true);
    expect(got.has(IDS.female)).toBe(false);
  });

  it('COMBINAÇÃO do card: docs_complete=complete + sex=male + city=CABA → só os certos', async () => {
    const res = await api.get(
      '/api/admin/workers?docs_complete=complete&sex=male&city=CABA&limit=1000',
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    const got = seededIds(res.data.data);
    // completo + masculino + CABA
    expect(got.has(IDS.target)).toBe(true);
    expect(got.has(IDS.interest)).toBe(true);
    // decoys que DEVEM sair:
    expect(got.has(IDS.female)).toBe(false); // sexo errado
    expect(got.has(IDS.incompl)).toBe(false); // status incompleto
    expect(got.has(IDS.notcaba)).toBe(false); // fora de CABA
    expect(got.has(IDS.junk)).toBe(false); // fora de CABA
  });

  it('cada filtro sozinho compõe por AND — city=CABA + docs_complete=incomplete isola o incompleto', async () => {
    const res = await api.get(
      '/api/admin/workers?city=CABA&docs_complete=incomplete&limit=1000',
      authHeaders(adminToken),
    );
    expect(res.status).toBe(200);
    const got = seededIds(res.data.data);
    expect(got.has(IDS.incompl)).toBe(true);
    expect(got.has(IDS.target)).toBe(false); // REGISTERED
    expect(got.has(IDS.female)).toBe(false); // REGISTERED
  });
});

describe('GET /api/admin/workers/filter-options — dropdown limpo (endpoint real)', () => {
  it('cities exclui lixo CPA (AEJ) e faz surgir CABA a partir de work_zone', async () => {
    const res = await api.get('/api/admin/workers/filter-options', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const cities: string[] = res.data.cities ?? res.data.data?.cities ?? [];
    // lixo de CPA não aparece
    expect(cities).not.toContain('AEJ');
    // CABA emerge da zona (label canônico)
    expect(cities.some((c) => /caba|ciudad autónoma/i.test(c))).toBe(true);
  });
});
