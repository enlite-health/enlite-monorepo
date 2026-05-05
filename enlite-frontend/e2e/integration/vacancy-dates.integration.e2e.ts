/**
 * vacancy-dates.integration.e2e.ts @integration
 *
 * Integration test for `published_at` and `closes_at` on job_postings.
 *
 * Runs against the real backend (Docker) + real Postgres. NO Gemini calls
 * happen on this path (vacancy CRUD only — AI is a separate endpoint).
 *
 * Covers four invariants:
 *   1. POST with explicit dates persists both verbatim
 *   2. POST with `published_at: null` defaults to NOW() (operations rule:
 *      publish date auto-fills with today when blank)
 *   3. POST with `closes_at: null` keeps it NULL (closes_at is optional)
 *   4. PUT updates both fields when whitelisted
 *
 * Auth: USE_MOCK_AUTH=true on the backend lets us send a mock_<base64> token
 * directly via Playwright's APIRequestContext. No Firebase, no UI.
 */

import { test, expect } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  cleanupVacancies,
  getVacancyById,
  type JobPostingRow,
} from '../helpers/db-test-helper';

const BACKEND_URL = 'http://localhost:8080';

// Mock-auth token accepted by the backend when USE_MOCK_AUTH=true
const MOCK_ADMIN = {
  uid: 'e2e-int-admin-dates',
  email: 'admin.dates@e2e.test',
  role: 'admin',
};
const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN), 'utf-8').toString('base64');

const AUTH_HEADERS = {
  Authorization: `Bearer ${MOCK_TOKEN}`,
  'Content-Type': 'application/json',
};

// ── Helpers ────────────────────────────────────────────────────────────────────

interface CreateVacancyBody {
  case_number: number;
  patient_id: string;
  patient_address_id: string | null;
  required_professions: string[];
  required_sex: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
  required_experience: string | null;
  worker_attributes: string | null;
  schedule: Array<{ dayOfWeek: number; startTime: string; endTime: string }>;
  work_schedule: string | null;
  providers_needed: number;
  salary_text: string;
  payment_day: string | null;
  daily_obs: string | null;
  status: string;
  published_at: string | null;
  closes_at: string | null;
}

function buildBody(
  patientId: string,
  addressId: string,
  overrides: Partial<CreateVacancyBody> = {},
): CreateVacancyBody {
  return {
    case_number: 999_000 + Math.floor(Math.random() * 1000),
    patient_id: patientId,
    patient_address_id: addressId,
    required_professions: ['AT'],
    required_sex: null,
    age_range_min: null,
    age_range_max: null,
    required_experience: null,
    worker_attributes: null,
    schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
    work_schedule: null,
    providers_needed: 1,
    salary_text: 'A convenir',
    payment_day: null,
    daily_obs: null,
    status: 'SEARCHING',
    published_at: null,
    closes_at: null,
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('Vacancy date fields persistence @integration', () => {
  test.setTimeout(30_000);

  let patientId = '';
  let addressId = '';
  const createdVacancyIds: string[] = [];

  test.beforeAll(() => {
    const result = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'IntegDates',
      lastName: `Patient${Date.now()}`,
      diagnosis: 'TEA leve',
      dependencyLevel: 'SEVERE',
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    patientId = result.patientId;
    addressId = result.addressId ?? '';
  });

  test.afterAll(() => {
    cleanupVacancies(createdVacancyIds);
    cleanupTestPatient(patientId);
  });

  test('POST persists explicit published_at and closes_at verbatim', async ({ request }) => {
    test.skip(!patientId || !addressId, 'Could not seed test patient + address');

    const body = buildBody(patientId, addressId, {
      published_at: '2026-04-15',
      closes_at: '2026-12-31',
    });

    const res = await request.post(`${BACKEND_URL}/api/admin/vacancies`, {
      headers: AUTH_HEADERS,
      data: body,
    });
    expect(res.ok(), `POST failed: ${res.status()} ${await res.text()}`).toBe(true);
    const json = await res.json();
    const vacancyId = json.data.id as string;
    createdVacancyIds.push(vacancyId);

    const row = getVacancyById(vacancyId) as JobPostingRow;
    expect(row).not.toBeNull();
    // Postgres returns timestamptz as `2026-04-15 00:00:00+00`. The local DB
    // is UTC, so the calendar date matches what we sent.
    expect(row.published_at).toContain('2026-04-15');
    expect(row.closes_at).toContain('2026-12-31');
  });

  test('POST with null published_at defaults to NOW() (within last minute)', async ({ request }) => {
    const body = buildBody(patientId, addressId, {
      published_at: null,
      closes_at: null,
    });

    const before = Date.now();
    const res = await request.post(`${BACKEND_URL}/api/admin/vacancies`, {
      headers: AUTH_HEADERS,
      data: body,
    });
    const after = Date.now();
    expect(res.ok(), `POST failed: ${res.status()} ${await res.text()}`).toBe(true);
    const json = await res.json();
    const vacancyId = json.data.id as string;
    createdVacancyIds.push(vacancyId);

    const row = getVacancyById(vacancyId) as JobPostingRow;
    expect(row.published_at).not.toBeNull();
    const persistedMs = new Date(row.published_at as string).getTime();
    // Allow 60s of clock skew between Playwright host and Docker container.
    expect(persistedMs).toBeGreaterThanOrEqual(before - 60_000);
    expect(persistedMs).toBeLessThanOrEqual(after + 60_000);
  });

  test('POST with null closes_at keeps it NULL (optional field)', async ({ request }) => {
    const body = buildBody(patientId, addressId, {
      published_at: '2026-04-20',
      closes_at: null,
    });

    const res = await request.post(`${BACKEND_URL}/api/admin/vacancies`, {
      headers: AUTH_HEADERS,
      data: body,
    });
    expect(res.ok()).toBe(true);
    const json = await res.json();
    const vacancyId = json.data.id as string;
    createdVacancyIds.push(vacancyId);

    const row = getVacancyById(vacancyId) as JobPostingRow;
    expect(row.published_at).toContain('2026-04-20');
    expect(row.closes_at).toBeNull();
  });

  test('PUT updates published_at and closes_at on existing vacancy', async ({ request }) => {
    // Create a baseline vacancy first
    const createRes = await request.post(`${BACKEND_URL}/api/admin/vacancies`, {
      headers: AUTH_HEADERS,
      data: buildBody(patientId, addressId, {
        published_at: '2026-01-10',
        closes_at: null,
      }),
    });
    expect(createRes.ok()).toBe(true);
    const createdId = (await createRes.json()).data.id as string;
    createdVacancyIds.push(createdId);

    // Now PATCH the dates via PUT
    const updateRes = await request.put(
      `${BACKEND_URL}/api/admin/vacancies/${createdId}`,
      {
        headers: AUTH_HEADERS,
        data: {
          published_at: '2026-06-01',
          closes_at: '2026-09-30',
        },
      },
    );
    expect(updateRes.ok(), `PUT failed: ${updateRes.status()} ${await updateRes.text()}`).toBe(true);

    const row = getVacancyById(createdId) as JobPostingRow;
    expect(row.published_at).toContain('2026-06-01');
    expect(row.closes_at).toContain('2026-09-30');
  });
});
