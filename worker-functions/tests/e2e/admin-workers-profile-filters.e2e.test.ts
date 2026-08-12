/**
 * admin-workers-profile-filters.e2e.test.ts
 *
 * E2E tests (real DB, no mocks) for the 9 new profile filters added to
 * GET /api/admin/workers and the new endpoint
 * GET /api/admin/workers/filter-options.
 *
 * Scenarios:
 *   1.  profession=AT  → only returns AT workers
 *   2.  profession=AT,CAREGIVER → returns workers with AT OR CAREGIVER
 *   3.  profession=INVALID → ignored, returns all workers (no filter)
 *   4.  preferred_age_range=children → only workers with children in array
 *   5.  experience_type=TEA → only workers with TEA in experience_types
 *   6.  preferred_type=home → only workers with home in preferred_types
 *   7.  state=Buenos Aires → workers with that state in service area
 *   8.  city=Palermo → workers with that city in service area
 *   9.  days=1,2 → workers available on Mon or Tue
 *   10. sex=male → blind-index filter (returns 200 without error)
 *   11. language=es → blind-index filter (returns 200 without error)
 *   12. GET /api/admin/workers/filter-options → shape validation
 *   13. filter-options requires auth → 401 without token
 *   14. Combining profession + state → composed WHERE
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const PREFIX = 'wpf-e2e';

// Deterministic UUIDs for this suite
const IDS = {
  workerAT:       `df110001-0000-0000-0001-000000000001`,
  workerCare:     `df110001-0000-0000-0001-000000000002`,
  workerNoFilter: `df110001-0000-0000-0001-000000000003`,
  workerSexMale:  `df110001-0000-0000-0001-000000000004`,
  // service areas
  saAT:           `df110001-0000-0000-0002-000000000001`,
  saCare:         `df110001-0000-0000-0002-000000000002`,
};

const api = createApiClient();
let pool: Pool;
let adminToken: string;

// ── seed helpers ──────────────────────────────────────────────────────────────

async function insertWorker(
  p: Pool,
  id: string,
  opts: {
    profession?: string | null;
    preferredAgeRange?: string[];
    experienceTypes?: string[];
    preferredTypes?: string[];
  } = {},
): Promise<void> {
  const fakeMail = `${PREFIX}-${id.slice(-8)}@wpf.e2e.local`;
  await p.query(
    `INSERT INTO workers (
      id, auth_uid, email, phone, status,
      profession, preferred_age_range, experience_types, preferred_types
    ) VALUES ($1, $2, $3, $4, 'INCOMPLETE_REGISTER', $5, $6, $7, $8)
    ON CONFLICT (id) DO NOTHING`,
    [
      id,
      `${PREFIX}-auth-${id.slice(-8)}`,
      fakeMail,
      `+549111${id.slice(-7)}`,
      opts.profession ?? null,
      opts.preferredAgeRange ?? [],
      opts.experienceTypes ?? [],
      opts.preferredTypes ?? [],
    ],
  );
}

async function insertServiceArea(
  p: Pool,
  id: string,
  workerId: string,
  state: string,
  city: string,
): Promise<void> {
  await p.query(
    `INSERT INTO worker_service_areas (id, worker_id, latitude, longitude, radius_km, state, city)
     VALUES ($1, $2, -34.6, -58.38, 10, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, workerId, state, city],
  );
}

async function insertAvailability(
  p: Pool,
  workerId: string,
  dayOfWeek: number,
): Promise<void> {
  await p.query(
    `INSERT INTO worker_availability (worker_id, day_of_week, start_time, end_time, timezone)
     VALUES ($1, $2, '08:00', '12:00', 'America/Argentina/Buenos_Aires')
     ON CONFLICT ON CONSTRAINT unique_worker_day_time DO NOTHING`,
    [workerId, dayOfWeek],
  );
}

async function cleanup(p: Pool): Promise<void> {
  await p.query(
    `DELETE FROM workers WHERE id = ANY($1::uuid[])`,
    [[IDS.workerAT, IDS.workerCare, IDS.workerNoFilter, IDS.workerSexMale]],
  );
}

// ── Suite setup ───────────────────────────────────────────────────────────────

beforeAll(async () => {
  await waitForBackend(api);

  adminToken = await getMockToken(api, {
    uid: 'wpf-admin-e2e',
    email: 'wpf-admin@wpf.e2e.local',
    role: 'admin',
  });

  pool = new Pool({ connectionString: DATABASE_URL });

  await cleanup(pool);

  // Seed workers
  await insertWorker(pool, IDS.workerAT, {
    profession: 'AT',
    preferredAgeRange: ['children', 'adults'],
    experienceTypes: ['TEA', 'DOWN'],
    preferredTypes: ['home', 'school'],
  });
  await insertWorker(pool, IDS.workerCare, {
    profession: 'CAREGIVER',
    preferredAgeRange: ['elderly'],
    experienceTypes: ['ALZHEIMER'],
    preferredTypes: ['institutional'],
  });
  await insertWorker(pool, IDS.workerNoFilter, {
    profession: 'NURSE',
    preferredAgeRange: [],
    experienceTypes: [],
    preferredTypes: [],
  });
  await insertWorker(pool, IDS.workerSexMale, { profession: 'AT' });

  // Service areas
  await insertServiceArea(pool, IDS.saAT, IDS.workerAT, 'Buenos Aires', 'Palermo');
  await insertServiceArea(pool, IDS.saCare, IDS.workerCare, 'Córdoba', 'Centro');

  // Availability: workerAT on Mon (1) and Tue (2)
  await insertAvailability(pool, IDS.workerAT, 1);
  await insertAvailability(pool, IDS.workerAT, 2);
  // workerCare on Wed (3) only
  await insertAvailability(pool, IDS.workerCare, 3);
});

afterAll(async () => {
  await cleanup(pool);
  await pool.end();
});

function authHeaders(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// Helper: extract seeded worker IDs from response
function extractSeededIds(data: Array<{ id: string }>): string[] {
  const seeded = new Set(Object.values(IDS));
  return data.map((w) => w.id).filter((id) => seeded.has(id));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/admin/workers — filtros de perfil', () => {

  // 1. profession=AT
  it('profession=AT retorna apenas workers AT (entre os seeded)', async () => {
    const res = await api.get('/api/admin/workers?profession=AT&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).toContain(IDS.workerSexMale);
    expect(seeded).not.toContain(IDS.workerCare);
    expect(seeded).not.toContain(IDS.workerNoFilter);
  });

  // 2. profession=AT,CAREGIVER
  it('profession=AT,CAREGIVER retorna AT e CAREGIVER', async () => {
    const res = await api.get('/api/admin/workers?profession=AT,CAREGIVER&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).toContain(IDS.workerCare);
    expect(seeded).not.toContain(IDS.workerNoFilter);
  });

  // 3. profession=INVALID → ignored
  it('profession inválido é ignorado e retorna 200', async () => {
    const res = await api.get('/api/admin/workers?profession=INVALID&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    // No filter applied — all seeded workers should appear
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).toContain(IDS.workerCare);
  });

  // 4. preferred_age_range=children
  it('preferred_age_range=children retorna somente workers com children no array', async () => {
    const res = await api.get('/api/admin/workers?preferred_age_range=children&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).not.toContain(IDS.workerCare); // elderly only
    expect(seeded).not.toContain(IDS.workerNoFilter); // empty array
  });

  // 5. experience_type=TEA
  it('experience_type=TEA retorna somente workers com TEA em experience_types', async () => {
    const res = await api.get('/api/admin/workers?experience_type=TEA&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).not.toContain(IDS.workerCare);
    expect(seeded).not.toContain(IDS.workerNoFilter);
  });

  // 6. preferred_type=home
  it('preferred_type=home retorna somente workers com home em preferred_types', async () => {
    const res = await api.get('/api/admin/workers?preferred_type=home&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).not.toContain(IDS.workerCare);
  });

  // 7. state
  it('state=Buenos Aires retorna workers com service_area nesse estado', async () => {
    const res = await api.get('/api/admin/workers?state=Buenos+Aires&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).not.toContain(IDS.workerCare); // Córdoba
  });

  // 8. city
  it('city=Palermo retorna workers com service_area nessa cidade', async () => {
    const res = await api.get('/api/admin/workers?city=Palermo&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).not.toContain(IDS.workerCare); // Centro
  });

  // 9. days
  it('days=1,2 retorna workers disponíveis na segunda ou terça', async () => {
    const res = await api.get('/api/admin/workers?days=1,2&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT); // Mon + Tue
    expect(seeded).not.toContain(IDS.workerCare); // Wed only
  });

  it('days=3 retorna worker disponível na quarta mas não o que tem segunda/terça', async () => {
    const res = await api.get('/api/admin/workers?days=3&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerCare); // Wed
    expect(seeded).not.toContain(IDS.workerAT); // only Mon+Tue, not Wed
  });

  // 10. sex=male — blind index filter: just verify no 500 and 200 response
  it('sex=male retorna 200 (blind index filter)', async () => {
    const res = await api.get('/api/admin/workers?sex=male&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  it('sex=female retorna 200 (blind index filter)', async () => {
    const res = await api.get('/api/admin/workers?sex=female&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  // 11. language=es — blind index filter
  it('language=es retorna 200 (blind index filter)', async () => {
    const res = await api.get('/api/admin/workers?language=es&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });

  // 14. Combined profession + state
  it('profession=AT combined with state=Buenos+Aires filtra ambos', async () => {
    const res = await api.get('/api/admin/workers?profession=AT&state=Buenos+Aires&limit=1000', authHeaders(adminToken));
    expect(res.status).toBe(200);
    const seeded = extractSeededIds(res.data.data);
    expect(seeded).toContain(IDS.workerAT);
    expect(seeded).not.toContain(IDS.workerCare);
    expect(seeded).not.toContain(IDS.workerNoFilter);
  });

  it('retorna 200 sem filtros (baseline sanity)', async () => {
    const res = await api.get('/api/admin/workers?limit=5', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
  });
});

// ── filter-options ─────────────────────────────────────────────────────────────

describe('GET /api/admin/workers/filter-options', () => {

  // 12. Shape validation
  it('retorna 200 com shape correto: states, cities, experienceTypes, preferredTypes', async () => {
    const res = await api.get('/api/admin/workers/filter-options', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.data).toHaveProperty('states');
    expect(res.data.data).toHaveProperty('cities');
    expect(res.data.data).toHaveProperty('experienceTypes');
    expect(res.data.data).toHaveProperty('preferredTypes');
    expect(Array.isArray(res.data.data.states)).toBe(true);
    expect(Array.isArray(res.data.data.cities)).toBe(true);
    expect(Array.isArray(res.data.data.experienceTypes)).toBe(true);
    expect(Array.isArray(res.data.data.preferredTypes)).toBe(true);
  });

  it('states contém o estado seedado (Buenos Aires)', async () => {
    const res = await api.get('/api/admin/workers/filter-options', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.data.states).toContain('Buenos Aires');
  });

  it('cities contém a cidade seedada (Palermo)', async () => {
    const res = await api.get('/api/admin/workers/filter-options', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.data.cities).toContain('Palermo');
  });

  it('experienceTypes contém TEA (seedado em workerAT)', async () => {
    const res = await api.get('/api/admin/workers/filter-options', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.data.experienceTypes).toContain('TEA');
  });

  it('preferredTypes contém home (seedado em workerAT)', async () => {
    const res = await api.get('/api/admin/workers/filter-options', authHeaders(adminToken));
    expect(res.status).toBe(200);
    expect(res.data.data.preferredTypes).toContain('home');
  });

  // 13. Requires auth
  it('retorna 401 sem token', async () => {
    const res = await api.get('/api/admin/workers/filter-options');
    expect(res.status).toBe(401);
  });
});
