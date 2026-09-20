/**
 * vacancy-list-filters.e2e.test.ts
 *
 * E2E tests (real DB, no mocks) for the new filter params added to
 * GET /api/admin/vacancies and the new endpoint
 * GET /api/admin/vacancies/filter-options.
 *
 * Scenarios:
 *   1. workerType=AT  → returns only vacancies with 'AT' in required_professions
 *   2. workerType=CAREGIVER → returns only CAREGIVER vacancies
 *   3. state filter → ILIKE match on patient_addresses.state
 *   4. city filter → ILIKE match on patient_addresses.city
 *   5. requiredSex=F → match on jp.required_sex
 *   6. days filter — covers-all semantics:
 *      vacancy with Mon+Tue schedule PASSES days=1,2
 *      vacancy with Mon-only schedule does NOT pass days=1,2
 *   7. days filter — time overlap:
 *      vacancy with slot 08:00-12:00 on Mon PASSES days=1&time_from=09:00&time_to=11:00
 *      vacancy with slot 08:00-12:00 on Mon does NOT pass days=1&time_from=13:00&time_to=17:00
 *   8. time-only filter (no days): returns vacancies with any overlapping slot
 *   9. GET /api/admin/vacancies/filter-options → states & cities arrays
 *  10. filter-options requires auth → 401 without token
 *  11. Combined filters compose correctly (workerType + state)
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

const PREFIX = 'vlf-e2e';

// Deterministic UUID prefix for this suite
const IDS = {
  patientAT:        `cc110001-0000-0000-0001-000000000001`,
  patientCare:      `cc110001-0000-0000-0001-000000000002`,
  patientSex:       `cc110001-0000-0000-0001-000000000003`,
  patientSched:     `cc110001-0000-0000-0001-000000000004`,
  // vacancies
  vacAT:            `cc110001-0000-0000-0002-000000000001`,
  vacCare:          `cc110001-0000-0000-0002-000000000002`,
  vacSexF:          `cc110001-0000-0000-0002-000000000003`,
  vacSchedMonTue:   `cc110001-0000-0000-0002-000000000004`,
  vacSchedMonOnly:  `cc110001-0000-0000-0002-000000000005`,
  // addresses
  addrBA:           `cc110001-0000-0000-0003-000000000001`,
  addrCOR:          `cc110001-0000-0000-0003-000000000002`,
  addrSex:          `cc110001-0000-0000-0003-000000000003`,
  addrSched:        `cc110001-0000-0000-0003-000000000004`,
};

const api = createApiClient();
let pool: Pool;
let adminToken: string;

// ── seed helpers ──────────────────────────────────────────────────────────────

async function insertPatient(p: Pool, id: string, caseNum: number): Promise<void> {
  await p.query(
    `INSERT INTO patients (id, clickup_task_id, country, first_name, last_name, status)
     VALUES ($1, $2, 'AR', $3, 'VlfTest', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [id, `${PREFIX}-task-${id.slice(-4)}`, `vlf-${caseNum}`],
  );
}

async function insertAddress(
  p: Pool,
  id: string,
  patientId: string,
  state: string,
  city: string,
): Promise<void> {
  await p.query(
    `INSERT INTO patient_addresses
       (id, patient_id, address_formatted, address_raw, source, state, city)
     VALUES ($1, $2, $3, $3, 'e2e-vlf', $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [id, patientId, `${state} / ${city}`, state, city],
  );
}

interface VacancyOpts {
  id: string;
  patientId: string;
  addressId: string;
  caseNumber: number;
  requiredProfessions: string[];
  requiredSex?: string;
  schedule: object[];
}

let vacSeq = 91000;
async function insertVacancy(p: Pool, opts: VacancyOpts): Promise<void> {
  vacSeq++;
  await p.query(
    `INSERT INTO job_postings
       (id, case_number, vacancy_number, title, status, country,
        patient_id, patient_address_id, required_professions, required_sex, schedule)
     VALUES ($1, $2, $3, $4, 'SEARCHING', 'AR', $5, $6, $7, $8, $9)
     ON CONFLICT (id) DO NOTHING`,
    [
      opts.id,
      opts.caseNumber,
      vacSeq,
      `vlf-test-${opts.caseNumber}-${vacSeq}`,
      opts.patientId,
      opts.addressId,
      opts.requiredProfessions,
      opts.requiredSex ?? null,
      JSON.stringify(opts.schedule),
    ],
  );
}

async function cleanup(p: Pool): Promise<void> {
  const vacIds = Object.values(IDS).filter(id => id.startsWith('cc110001-0000-0000-0002-'));
  const addrIds = Object.values(IDS).filter(id => id.startsWith('cc110001-0000-0000-0003-'));
  const patIds = Object.values(IDS).filter(id => id.startsWith('cc110001-0000-0000-0001-'));

  await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [vacIds]).catch(() => {});
  await p.query(`DELETE FROM patient_addresses WHERE id = ANY($1)`, [addrIds]).catch(() => {});
  await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [patIds]).catch(() => {});
}

function authHeaders(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// ── setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await waitForBackend(api);
  pool = new Pool({ connectionString: DATABASE_URL });
  adminToken = await getMockToken(api, { uid: 'vlf-admin', email: 'vlf-admin@e2e.local', role: 'admin' });

  await cleanup(pool);

  // patients
  await insertPatient(pool, IDS.patientAT,    91001);
  await insertPatient(pool, IDS.patientCare,  91002);
  await insertPatient(pool, IDS.patientSex,   91003);
  await insertPatient(pool, IDS.patientSched, 91004);

  // addresses
  await insertAddress(pool, IDS.addrBA,    IDS.patientAT,    'Buenos Aires', 'Palermo');
  await insertAddress(pool, IDS.addrCOR,   IDS.patientCare,  'Córdoba',      'Nueva Córdoba');
  await insertAddress(pool, IDS.addrSex,   IDS.patientSex,   'Santa Fe',     'Rosario');
  await insertAddress(pool, IDS.addrSched, IDS.patientSched, 'Mendoza',      'Capital');

  // vacancies
  await insertVacancy(pool, {
    id: IDS.vacAT,
    patientId: IDS.patientAT,
    addressId: IDS.addrBA,
    caseNumber: 91001,
    requiredProfessions: ['AT'],
    requiredSex: 'F',
    schedule: [],
  });
  await insertVacancy(pool, {
    id: IDS.vacCare,
    patientId: IDS.patientCare,
    addressId: IDS.addrCOR,
    caseNumber: 91002,
    requiredProfessions: ['CAREGIVER'],
    schedule: [],
  });
  await insertVacancy(pool, {
    id: IDS.vacSexF,
    patientId: IDS.patientSex,
    addressId: IDS.addrSex,
    caseNumber: 91003,
    requiredProfessions: ['AT', 'CAREGIVER'],
    requiredSex: 'M',
    schedule: [],
  });
  // Mon+Tue schedule: slots for dayOfWeek=1 and dayOfWeek=2
  await insertVacancy(pool, {
    id: IDS.vacSchedMonTue,
    patientId: IDS.patientSched,
    addressId: IDS.addrSched,
    caseNumber: 91004,
    requiredProfessions: ['AT'],
    schedule: [
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
      { dayOfWeek: 2, startTime: '09:00', endTime: '13:00' },
    ],
  });
  // Mon-only schedule
  await insertVacancy(pool, {
    id: IDS.vacSchedMonOnly,
    patientId: IDS.patientSched,
    addressId: IDS.addrSched,
    caseNumber: 91005,
    requiredProfessions: ['AT'],
    schedule: [
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
    ],
  });
});

afterAll(async () => {
  await cleanup(pool);
  await pool.end();
});

// ── helper: extract only our fixture IDs from list response ───────────────────

const OUR_IDS = new Set(Object.values(IDS).filter(id => id.startsWith('cc110001-0000-0000-0002-')));

function ourIds(data: Array<{ id: string }>): string[] {
  return data.map(d => d.id).filter(id => OUR_IDS.has(id));
}

// ── scenario 1: workerType=AT ─────────────────────────────────────────────────

it('workerType=AT returns vacancies with AT in required_professions', async () => {
  const res = await api.get('/api/admin/vacancies?worker_type=AT', authHeaders(adminToken));
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).toContain(IDS.vacAT);
  expect(ids).toContain(IDS.vacSchedMonTue);
  expect(ids).toContain(IDS.vacSchedMonOnly);
  expect(ids).not.toContain(IDS.vacCare);
});

// ── scenario 2: workerType=CAREGIVER ─────────────────────────────────────────

it('workerType=CAREGIVER returns vacancies with CAREGIVER in required_professions', async () => {
  const res = await api.get('/api/admin/vacancies?worker_type=CAREGIVER', authHeaders(adminToken));
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).toContain(IDS.vacCare);
  expect(ids).toContain(IDS.vacSexF); // has both AT and CAREGIVER
  expect(ids).not.toContain(IDS.vacAT);
});

// ── scenario 3: state filter ──────────────────────────────────────────────────

it('state=Buenos Aires returns only BA vacancies', async () => {
  const res = await api.get(
    `/api/admin/vacancies?state=Buenos+Aires`,
    authHeaders(adminToken),
  );
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).toContain(IDS.vacAT);
  expect(ids).not.toContain(IDS.vacCare);
  expect(ids).not.toContain(IDS.vacSexF);
});

// ── scenario 4: city filter ───────────────────────────────────────────────────

it('city=Rosario returns only Rosario vacancies', async () => {
  const res = await api.get('/api/admin/vacancies?city=Rosario', authHeaders(adminToken));
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).toContain(IDS.vacSexF);
  expect(ids).not.toContain(IDS.vacAT);
  expect(ids).not.toContain(IDS.vacCare);
});

// ── scenario 5: requiredSex=F ─────────────────────────────────────────────────

it('required_sex=F returns only vacancies with required_sex=F', async () => {
  const res = await api.get('/api/admin/vacancies?required_sex=F', authHeaders(adminToken));
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).toContain(IDS.vacAT);
  expect(ids).not.toContain(IDS.vacSexF); // has required_sex=M
  expect(ids).not.toContain(IDS.vacCare); // has required_sex=NULL
});

// ── scenario 6a: days=1,2 — Mon+Tue vacancy PASSES ────────────────────────────

it('days=1,2: vacancy with Mon+Tue schedule passes', async () => {
  const res = await api.get('/api/admin/vacancies?days=1%2C2', authHeaders(adminToken));
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).toContain(IDS.vacSchedMonTue);
});

// ── scenario 6b: days=1,2 — Mon-only vacancy does NOT pass ────────────────────

it('days=1,2: vacancy with Mon-only schedule does NOT pass', async () => {
  const res = await api.get('/api/admin/vacancies?days=1%2C2', authHeaders(adminToken));
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).not.toContain(IDS.vacSchedMonOnly);
});

// ── scenario 7a: days=1 + time overlapping Mon slot ───────────────────────────

it('days=1 + time_from=09:00 + time_to=11:00: Mon 08:00-12:00 slot overlaps → passes', async () => {
  const res = await api.get(
    '/api/admin/vacancies?days=1&time_from=09%3A00&time_to=11%3A00',
    authHeaders(adminToken),
  );
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).toContain(IDS.vacSchedMonOnly);
});

// ── scenario 7b: days=1 + time NOT overlapping Mon slot ───────────────────────

it('days=1 + time_from=13:00 + time_to=17:00: Mon 08:00-12:00 slot does NOT overlap', async () => {
  const res = await api.get(
    '/api/admin/vacancies?days=1&time_from=13%3A00&time_to=17%3A00',
    authHeaders(adminToken),
  );
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).not.toContain(IDS.vacSchedMonOnly);
  expect(ids).not.toContain(IDS.vacSchedMonTue);
});

// ── scenario 8: time-only filter ──────────────────────────────────────────────

it('time_from=08:30 + time_to=09:30 (no days): returns vacancies with any overlapping slot', async () => {
  const res = await api.get(
    '/api/admin/vacancies?time_from=08%3A30&time_to=09%3A30',
    authHeaders(adminToken),
  );
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  // Mon 08:00-12:00 overlaps 08:30-09:30
  expect(ids).toContain(IDS.vacSchedMonOnly);
  expect(ids).toContain(IDS.vacSchedMonTue);
});

// ── scenario 9: filter-options endpoint ──────────────────────────────────────

it('GET /api/admin/vacancies/filter-options returns states and cities arrays', async () => {
  const res = await api.get('/api/admin/vacancies/filter-options', authHeaders(adminToken));
  expect(res.status).toBe(200);
  expect(res.data.success).toBe(true);

  const { states, cities } = res.data.data as { states: string[]; cities: string[] };
  expect(Array.isArray(states)).toBe(true);
  expect(Array.isArray(cities)).toBe(true);

  // Our fixtures contributed these values
  expect(states).toContain('Buenos Aires');
  expect(states).toContain('Córdoba');
  expect(cities).toContain('Palermo');
  expect(cities).toContain('Nueva Córdoba');

  // Must be sorted
  const sortedStates = [...states].sort();
  expect(states).toEqual(sortedStates);
  const sortedCities = [...cities].sort();
  expect(cities).toEqual(sortedCities);
});

// ── scenario 10: filter-options requires auth ─────────────────────────────────

it('GET /api/admin/vacancies/filter-options → 401 without token', async () => {
  const res = await api.get('/api/admin/vacancies/filter-options');
  expect(res.status).toBe(401);
});

// ── scenario 11: combined filters ────────────────────────────────────────────

it('combined workerType=AT + state=Buenos Aires returns intersection', async () => {
  const res = await api.get(
    '/api/admin/vacancies?worker_type=AT&state=Buenos+Aires',
    authHeaders(adminToken),
  );
  expect(res.status).toBe(200);
  const ids = ourIds(res.data.data as Array<{ id: string }>);
  expect(ids).toContain(IDS.vacAT);
  // vacSchedMonTue/vacSchedMonOnly are AT but in Mendoza, not BA
  expect(ids).not.toContain(IDS.vacSchedMonTue);
  expect(ids).not.toContain(IDS.vacSchedMonOnly);
  expect(ids).not.toContain(IDS.vacCare);
});
