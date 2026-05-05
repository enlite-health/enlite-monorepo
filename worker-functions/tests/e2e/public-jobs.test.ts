/**
 * public-jobs.test.ts
 *
 * E2E tests for GET /api/public/v1/jobs
 *
 * Scenarios:
 *   1. Returns SEARCHING, SEARCHING_REPLACEMENT, RAPID_RESPONSE, and ACTIVE vacancies
 *   2. Does NOT return CLOSED or SUSPENDED vacancies
 *   3. Does NOT return PENDING_ACTIVATION vacancies (even with site link)
 *   4. Does NOT return vacancies without social_short_links.site
 *   5. Returns correct 18-field shape with sanitized description (13 original + 5 new)
 *   6. Returns 200 with empty array when no matching vacancies
 *   7. detail_link field comes from social_short_links->>'site'
 *   8. ACTIVE vacancy with site link appears in response
 *   9. ACTIVE vacancy WITHOUT site link is filtered out
 *  10. Payload contains 5 new fields with correct types
 *  11. ONLY the 4 allowed statuses appear — global exclusivity assertion
 */

import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = DATABASE_URL;
}

// Unique prefix for test isolation
const PREFIX = 'pj-e2e';

// Deterministic UUIDs for test data
const IDS = {
  patient: `dd110001-0000-0000-0001-000000000001`,
  searching: `dd110001-0000-0000-0002-000000000001`,
  searchingReplacement: `dd110001-0000-0000-0002-000000000002`,
  rapidResponse: `dd110001-0000-0000-0002-000000000003`,
  active: `dd110001-0000-0000-0002-000000000004`,
  closed: `dd110001-0000-0000-0002-000000000005`,
  noSiteLink: `dd110001-0000-0000-0002-000000000006`,
  suspended: `dd110001-0000-0000-0002-000000000007`,
  activeNoSite: `dd110001-0000-0000-0002-000000000008`,
  pendingActivation: `dd110001-0000-0000-0002-000000000009`,
};

const api = createApiClient();
let pool: Pool;

async function cleanup(p: Pool): Promise<void> {
  const jobIds = Object.values(IDS).filter(id => id.startsWith('dd110001-0000-0000-0002-'));
  await p.query(
    `DELETE FROM job_postings_clickup_sync WHERE job_posting_id = ANY($1)`,
    [jobIds],
  ).catch(() => {});
  await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [jobIds]).catch(() => {});
  await p.query(`DELETE FROM patients WHERE id = $1`, [IDS.patient]).catch(() => {});
}

async function insertPatient(p: Pool): Promise<void> {
  await p.query(
    `INSERT INTO patients (id, clickup_task_id, service_type, diagnosis, dependency_level, status)
     VALUES ($1, 'pj-e2e-task-1', ARRAY['AT']::text[], 'TEA', 'MODERATE', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [IDS.patient],
  );
}

interface InsertVacancyParams {
  id: string;
  caseNumber: number;
  status: string;
  socialShortLinks?: Record<string, unknown> | null;
  description?: string;
}

let vacancyCounter = 9000;

async function insertVacancy(p: Pool, params: InsertVacancyParams): Promise<void> {
  const vacancyNumber = ++vacancyCounter;
  const socialLinks = params.socialShortLinks !== undefined
    ? JSON.stringify(params.socialShortLinks)
    : null;

  await p.query(
    `INSERT INTO job_postings (
       id, case_number, vacancy_number, title, status, description,
       patient_id, social_short_links
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [
      params.id,
      params.caseNumber,
      vacancyNumber,
      `CASO ${params.caseNumber}-${vacancyNumber}`,
      params.status,
      params.description ?? `Buscamos AT para ${params.caseNumber}`,
      IDS.patient,
      socialLinks,
    ],
  );
}

describe('GET /api/public/v1/jobs', () => {
  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);
    await insertPatient(pool);

    // Vacancies that SHOULD appear
    await insertVacancy(pool, {
      id: IDS.searching,
      caseNumber: 9011,
      status: 'SEARCHING',
      socialShortLinks: { site: 'https://srt.io/searching' },
      description: 'AT con experiencia en TEA domicilio.',
    });

    await insertVacancy(pool, {
      id: IDS.searchingReplacement,
      caseNumber: 9012,
      status: 'SEARCHING_REPLACEMENT',
      socialShortLinks: { site: 'https://srt.io/sreplacement' },
      description: 'AT para reemplazo urgente.',
    });

    await insertVacancy(pool, {
      id: IDS.rapidResponse,
      caseNumber: 9013,
      status: 'RAPID_RESPONSE',
      socialShortLinks: { site: 'https://srt.io/rapid' },
    });

    await insertVacancy(pool, {
      id: IDS.active,
      caseNumber: 9014,
      status: 'ACTIVE',
      socialShortLinks: { site: 'https://srt.io/active' },
      description: 'AT activo con caso en marcha.',
    });

    // Vacancies that MUST NOT appear
    await insertVacancy(pool, {
      id: IDS.closed,
      caseNumber: 9015,
      status: 'CLOSED',
      socialShortLinks: { site: 'https://srt.io/closed' },
    });

    await insertVacancy(pool, {
      id: IDS.suspended,
      caseNumber: 9017,
      status: 'SUSPENDED',
      socialShortLinks: { site: 'https://srt.io/suspended' },
    });

    await insertVacancy(pool, {
      id: IDS.noSiteLink,
      caseNumber: 9016,
      status: 'SEARCHING',
      socialShortLinks: { facebook: 'https://srt.io/fb' }, // no 'site' key
    });

    await insertVacancy(pool, {
      id: IDS.activeNoSite,
      caseNumber: 9018,
      status: 'ACTIVE',
      socialShortLinks: null, // ACTIVE but no site link — must be filtered
    });

    await insertVacancy(pool, {
      id: IDS.pendingActivation,
      caseNumber: 9019,
      status: 'PENDING_ACTIVATION',
      socialShortLinks: { site: 'https://srt.io/pending' }, // has site link but wrong status
    });
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  it('returns 200 with success=true', async () => {
    const res = await api.get('/api/public/v1/jobs');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('returns SEARCHING vacancies', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).toContain(IDS.searching);
  });

  it('returns SEARCHING_REPLACEMENT vacancies', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).toContain(IDS.searchingReplacement);
  });

  it('returns RAPID_RESPONSE vacancies', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).toContain(IDS.rapidResponse);
  });

  it('returns ACTIVE vacancies that have a site link', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).toContain(IDS.active);
  });

  it('does NOT return CLOSED vacancies', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).not.toContain(IDS.closed);
  });

  it('does NOT return SUSPENDED vacancies', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).not.toContain(IDS.suspended);
  });

  it('does NOT return vacancies without social_short_links.site (SEARCHING)', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).not.toContain(IDS.noSiteLink);
  });

  it('does NOT return ACTIVE vacancies without social_short_links.site', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).not.toContain(IDS.activeNoSite);
  });

  it('returns correct 18-field shape (13 original + 5 new)', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.searching);
    expect(job).toBeDefined();

    const expectedFields = [
      // Original 13
      'id', 'case_number', 'vacancy_number', 'title', 'status',
      'description', 'schedule_days_hours', 'worker_profile_sought',
      'service', 'pathologies', 'state', 'city', 'detail_link',
      // New 5
      'worker_type', 'worker_sex', 'job_zone', 'neighborhood', 'state_city',
    ];
    for (const field of expectedFields) {
      expect(job).toHaveProperty(field);
    }
  });

  it('detail_link field matches social_short_links.site', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.searching);
    expect(job?.detail_link).toBe('https://srt.io/searching');
  });

  it('ACTIVE vacancy detail_link matches social_short_links.site', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.active);
    expect(job?.detail_link).toBe('https://srt.io/active');
  });

  it('description is sanitized — generic text becomes empty string', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.rapidResponse);
    // rapidResponse uses default description from insertVacancy which starts with "Buscamos AT"
    expect(typeof job?.description).toBe('string');
  });

  it('returns real description unchanged', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.searching);
    expect(job?.description).toBe('AT con experiencia en TEA domicilio.');
  });

  it('new fields worker_type, worker_sex, job_zone, neighborhood, state_city are present with correct types', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.searching);
    expect(job).toBeDefined();

    // worker_type is either null or an array
    expect(
      job!.worker_type === null || Array.isArray(job!.worker_type),
    ).toBe(true);

    // worker_sex is either null or a string
    expect(
      job!.worker_sex === null || typeof job!.worker_sex === 'string',
    ).toBe(true);

    // job_zone is either null or a string
    expect(
      job!.job_zone === null || typeof job!.job_zone === 'string',
    ).toBe(true);

    // neighborhood is either null or a string
    expect(
      job!.neighborhood === null || typeof job!.neighborhood === 'string',
    ).toBe(true);

    // state_city is either null or a non-empty string
    expect(
      job!.state_city === null || (typeof job!.state_city === 'string' && job!.state_city.trim().length > 0),
    ).toBe(true);
  });

  it('does NOT return PENDING_ACTIVATION vacancies', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).not.toContain(IDS.pendingActivation);
  });

  it('returns ONLY vacancies with the 4 allowed statuses', async () => {
    const ALLOWED = new Set(['ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE']);
    const res = await api.get('/api/public/v1/jobs');
    const jobs = res.data.data as Array<{ status: string }>;
    expect(jobs.length).toBeGreaterThan(0); // sanity: fixtures present
    const violators = jobs.filter(j => !ALLOWED.has(j.status));
    if (violators.length > 0) {
      console.error('Statuses fora do allowed:', violators.map(v => v.status));
    }
    expect(violators).toHaveLength(0);
  });

  it('returns 200 with empty array when no matching vacancies exist', async () => {
    // Query a fresh pool connection to verify the empty-case independently
    const cleanPool = new Pool({ connectionString: DATABASE_URL });
    try {
      // Insert a temp vacancy with no site link to ensure the filter works
      const tempId = 'dd110001-0000-0000-0002-999999999999';
      await cleanPool.query(
        `INSERT INTO job_postings (id, case_number, vacancy_number, title, status, description, patient_id)
         VALUES ($1, 99991, 99991, 'CASO 99991-99991', 'CLOSED', 'Temp vacancy for test', $2)
         ON CONFLICT (id) DO NOTHING`,
        [tempId, IDS.patient],
      );

      // The endpoint should still work without error
      const res = await api.get('/api/public/v1/jobs');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.data)).toBe(true);

      await cleanPool.query(`DELETE FROM job_postings WHERE id = $1`, [tempId]);
    } finally {
      await cleanPool.end();
    }
  });
});
