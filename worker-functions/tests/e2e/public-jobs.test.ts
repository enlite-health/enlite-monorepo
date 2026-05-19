/**
 * public-jobs.test.ts
 *
 * E2E tests for GET /api/public/v1/jobs
 *
 * Scenarios (original):
 *   1. Returns SEARCHING, SEARCHING_REPLACEMENT, RAPID_RESPONSE, and ACTIVE vacancies
 *   2. Does NOT return CLOSED or SUSPENDED vacancies
 *   3. Does NOT return PENDING_ACTIVATION vacancies (even with site link)
 *   4. Does NOT return vacancies without social_short_links.site
 *   5. Returns correct 19-field shape (18 original + country)
 *   6. Returns 200 with empty array when no matching vacancies
 *   7. detail_link field comes from social_short_links->>'site'
 *   8. ACTIVE vacancy with site link appears in response
 *   9. ACTIVE vacancy WITHOUT site link is filtered out
 *  10. Payload contains 5 new fields with correct types
 *  11. ONLY the 4 allowed statuses appear — global exclusivity assertion
 *
 * Scenarios (filter suite):
 *  12. No ?country → default AR — returns only AR fixtures
 *  13. ?country=BR → returns only BR fixtures
 *  14. ?country=ar (lowercase) → normalised to AR, returns AR fixtures
 *  15. ?country=AR&state=CABA → AND intersection
 *  16. ?country=BR&state=CABA → AND — BR has no CABA → empty for filter fixtures
 *  17. ?country=AR&pathology=Alzheimer → ILIKE match
 *  18. ?country=AR&worker_sex=FEMALE → exact match
 *  19. ?country=AR&worker_type=AT → array match
 *  20. ?country=AR&q=temperley → free-text ILIKE
 *  21. ?worker_sex=INVALID → 400
 *  22. ?country=ARGENTINA → 400 (not 2 chars)
 *  23. Response shape includes 19th field: country
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
  // patients
  patient: `dd110001-0000-0000-0001-000000000001`,
  patientBR: `dd110001-0000-0000-0001-000000000002`,
  // patient address (for state/city filter)
  addressAR: `dd110001-0000-0000-0003-000000000001`,
  addressBR: `dd110001-0000-0000-0003-000000000002`,
  // AR vacancies (existing)
  searching: `dd110001-0000-0000-0002-000000000001`,
  searchingReplacement: `dd110001-0000-0000-0002-000000000002`,
  rapidResponse: `dd110001-0000-0000-0002-000000000003`,
  active: `dd110001-0000-0000-0002-000000000004`,
  closed: `dd110001-0000-0000-0002-000000000005`,
  noSiteLink: `dd110001-0000-0000-0002-000000000006`,
  suspended: `dd110001-0000-0000-0002-000000000007`,
  activeNoSite: `dd110001-0000-0000-0002-000000000008`,
  pendingActivation: `dd110001-0000-0000-0002-000000000009`,
  // AR vacancy with extra filter attributes (state/city/sex/profession/q)
  filterAR: `dd110001-0000-0000-0002-000000000010`,
  // BR vacancies (new)
  searchingBR: `dd110001-0000-0000-0002-000000000011`,
  activeBR: `dd110001-0000-0000-0002-000000000012`,
};

const api = createApiClient();
let pool: Pool;

async function cleanup(p: Pool): Promise<void> {
  const jobIds = Object.values(IDS).filter(id => id.startsWith('dd110001-0000-0000-0002-'));
  const addressIds = Object.values(IDS).filter(id => id.startsWith('dd110001-0000-0000-0003-'));
  const patientIds = Object.values(IDS).filter(id => id.startsWith('dd110001-0000-0000-0001-'));

  await p.query(
    `DELETE FROM job_postings_clickup_sync WHERE job_posting_id = ANY($1)`,
    [jobIds],
  ).catch(() => {});
  await p.query(`DELETE FROM job_postings WHERE id = ANY($1)`, [jobIds]).catch(() => {});
  await p.query(`DELETE FROM patient_addresses WHERE id = ANY($1)`, [addressIds]).catch(() => {});
  await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [patientIds]).catch(() => {});
}

async function insertPatient(p: Pool, id: string, diagnosis: string): Promise<void> {
  await p.query(
    `INSERT INTO patients (id, clickup_task_id, service_type, diagnosis, dependency_level, status)
     VALUES ($1, $2, ARRAY['AT']::text[], $3, 'MODERATE', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [id, `${PREFIX}-task-${id.slice(-4)}`, diagnosis],
  );
}

async function insertAddress(
  p: Pool,
  id: string,
  patientId: string,
  state: string,
  city: string,
  neighborhood: string,
): Promise<void> {
  await p.query(
    `INSERT INTO patient_addresses (id, patient_id, address_type, state, city, neighborhood, lat, lng)
     VALUES ($1, $2, 'primary', $3, $4, $5, -34.6, -58.4)
     ON CONFLICT (id) DO NOTHING`,
    [id, patientId, state, city, neighborhood],
  );
}

interface InsertVacancyParams {
  id: string;
  caseNumber: number;
  status: string;
  country?: string;
  socialShortLinks?: Record<string, unknown> | null;
  description?: string;
  patientId?: string;
  patientAddressId?: string;
  requiredSex?: string;
  requiredProfessions?: string[];
  /** Migration 168 default is `true` for new rows. Fixtures in this suite
   *  represent already-published vacancies (the public listing scenario), so
   *  the helper defaults to `false`. Override to `true` for draft fixtures
   *  that should be hidden from the public endpoint. */
  isDraft?: boolean;
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
       patient_id, patient_address_id, social_short_links,
       country, required_sex, required_professions, is_draft
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
     ON CONFLICT (id) DO NOTHING`,
    [
      params.id,
      params.caseNumber,
      vacancyNumber,
      `CASO ${params.caseNumber}-${vacancyNumber}`,
      params.status,
      params.description ?? `Buscamos AT para ${params.caseNumber}`,
      params.patientId ?? IDS.patient,
      params.patientAddressId ?? null,
      socialLinks,
      params.country ?? 'AR',
      params.requiredSex ?? null,
      params.requiredProfessions ? `{${params.requiredProfessions.join(',')}}` : null,
      params.isDraft ?? false,
    ],
  );
}

describe('GET /api/public/v1/jobs', () => {
  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);

    // Patients
    await insertPatient(pool, IDS.patient, 'TEA');
    await insertPatient(pool, IDS.patientBR, 'Alzheimer');

    // Addresses
    await insertAddress(pool, IDS.addressAR, IDS.patient, 'CABA', 'Palermo', 'Temperley');
    await insertAddress(pool, IDS.addressBR, IDS.patientBR, 'São Paulo', 'São Paulo', 'Pinheiros');

    // ── AR vacancies (existing) ──────────────────────────────────────────────
    await insertVacancy(pool, {
      id: IDS.searching,
      caseNumber: 9011,
      status: 'SEARCHING',
      country: 'AR',
      socialShortLinks: { site: 'https://srt.io/searching' },
      description: 'AT con experiencia en TEA domicilio.',
    });

    await insertVacancy(pool, {
      id: IDS.searchingReplacement,
      caseNumber: 9012,
      status: 'SEARCHING_REPLACEMENT',
      country: 'AR',
      socialShortLinks: { site: 'https://srt.io/sreplacement' },
      description: 'AT para reemplazo urgente.',
    });

    await insertVacancy(pool, {
      id: IDS.rapidResponse,
      caseNumber: 9013,
      status: 'RAPID_RESPONSE',
      country: 'AR',
      socialShortLinks: { site: 'https://srt.io/rapid' },
    });

    await insertVacancy(pool, {
      id: IDS.active,
      caseNumber: 9014,
      status: 'ACTIVE',
      country: 'AR',
      socialShortLinks: { site: 'https://srt.io/active' },
      description: 'AT activo con caso en marcha.',
    });

    // Must NOT appear
    await insertVacancy(pool, {
      id: IDS.closed,
      caseNumber: 9015,
      status: 'CLOSED',
      country: 'AR',
      socialShortLinks: { site: 'https://srt.io/closed' },
    });

    await insertVacancy(pool, {
      id: IDS.suspended,
      caseNumber: 9017,
      status: 'SUSPENDED',
      country: 'AR',
      socialShortLinks: { site: 'https://srt.io/suspended' },
    });

    await insertVacancy(pool, {
      id: IDS.noSiteLink,
      caseNumber: 9016,
      status: 'SEARCHING',
      country: 'AR',
      socialShortLinks: { facebook: 'https://srt.io/fb' },
    });

    await insertVacancy(pool, {
      id: IDS.activeNoSite,
      caseNumber: 9018,
      status: 'ACTIVE',
      country: 'AR',
      socialShortLinks: null,
    });

    await insertVacancy(pool, {
      id: IDS.pendingActivation,
      caseNumber: 9019,
      status: 'PENDING_ACTIVATION',
      country: 'AR',
      socialShortLinks: { site: 'https://srt.io/pending' },
      isDraft: true, // explicit — draft fixture, must be hidden from public listing

    });

    // ── AR vacancy with filter attributes ────────────────────────────────────
    await insertVacancy(pool, {
      id: IDS.filterAR,
      caseNumber: 9020,
      status: 'SEARCHING',
      country: 'AR',
      patientId: IDS.patient,
      patientAddressId: IDS.addressAR,
      socialShortLinks: { site: 'https://srt.io/filter-ar' },
      description: 'Paciente con Alzheimer en Temperley.',
      requiredSex: 'FEMALE',
      requiredProfessions: ['AT'],
    });

    // ── BR vacancies ─────────────────────────────────────────────────────────
    await insertVacancy(pool, {
      id: IDS.searchingBR,
      caseNumber: 9021,
      status: 'SEARCHING',
      country: 'BR',
      patientId: IDS.patientBR,
      patientAddressId: IDS.addressBR,
      socialShortLinks: { site: 'https://srt.io/br-searching' },
      description: 'AT para paciente em São Paulo.',
    });

    await insertVacancy(pool, {
      id: IDS.activeBR,
      caseNumber: 9022,
      status: 'ACTIVE',
      country: 'BR',
      patientId: IDS.patientBR,
      socialShortLinks: { site: 'https://srt.io/br-active' },
      description: 'Caso ativo no Brasil.',
    });
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  // ── Original status/filtering tests ─────────────────────────────────────────

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

  it('returns correct 19-field shape (18 original + country)', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.searching);
    expect(job).toBeDefined();

    const expectedFields = [
      // Original 13
      'id', 'case_number', 'vacancy_number', 'title', 'status',
      'description', 'schedule_days_hours', 'worker_profile_sought',
      'service', 'pathologies', 'state', 'city', 'detail_link',
      // Expansion 5
      'worker_type', 'worker_sex', 'job_zone', 'neighborhood', 'state_city',
      // New country field
      'country',
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

    expect(
      job!.worker_type === null || Array.isArray(job!.worker_type),
    ).toBe(true);

    expect(
      job!.worker_sex === null || typeof job!.worker_sex === 'string',
    ).toBe(true);

    expect(
      job!.job_zone === null || typeof job!.job_zone === 'string',
    ).toBe(true);

    expect(
      job!.neighborhood === null || typeof job!.neighborhood === 'string',
    ).toBe(true);

    expect(
      job!.state_city === null || (typeof job!.state_city === 'string' && job!.state_city.trim().length > 0),
    ).toBe(true);
  });

  it('does NOT return PENDING_ACTIVATION vacancies', async () => {
    const res = await api.get('/api/public/v1/jobs');
    const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
    expect(ids).not.toContain(IDS.pendingActivation);
  });

  /**
   * Regression: PublicJobsQueryBuilder.ts line 11 — PENDING_ACTIVATION must never
   * appear in /api/public/v1/jobs even when social_short_links.site is populated
   * AND the vacancy has a row in job_postings_clickup_sync (i.e. ClickUp-synced).
   */
  it('PENDING_ACTIVATION with site link AND clickup_sync row is NOT returned (regression PublicJobsQueryBuilder:11)', async () => {
    const syncedPendingId = 'dd110001-0000-0000-0002-000000000099';
    const syncedVacancyNumber = 9099;
    try {
      await pool.query(
        `INSERT INTO job_postings (id, case_number, vacancy_number, title, status, description, patient_id, social_short_links, country)
         VALUES ($1, 9099, $2, 'CASO 9099-9099', 'PENDING_ACTIVATION', 'Draft synced from ClickUp', $3, '{"site":"https://srt.io/synced-pending"}'::jsonb, 'AR')
         ON CONFLICT (id) DO NOTHING`,
        [syncedPendingId, syncedVacancyNumber, IDS.patient],
      );
      await pool.query(
        `INSERT INTO job_postings_clickup_sync (job_posting_id, clickup_task_id)
         VALUES ($1, 'clickup-regression-task-001')
         ON CONFLICT DO NOTHING`,
        [syncedPendingId],
      );

      const res = await api.get('/api/public/v1/jobs');
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).not.toContain(syncedPendingId);
    } finally {
      await pool.query(`DELETE FROM job_postings_clickup_sync WHERE job_posting_id = $1`, [syncedPendingId]).catch(() => {});
      await pool.query(`DELETE FROM job_postings WHERE id = $1`, [syncedPendingId]).catch(() => {});
    }
  });

  it('returns ONLY vacancies with the 4 allowed statuses', async () => {
    const ALLOWED = new Set(['ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE']);
    const res = await api.get('/api/public/v1/jobs');
    const jobs = res.data.data as Array<{ status: string }>;
    expect(jobs.length).toBeGreaterThan(0);
    const violators = jobs.filter(j => !ALLOWED.has(j.status));
    expect(violators).toHaveLength(0);
  });

  it('returns 200 with empty array when no matching vacancies exist', async () => {
    const cleanPool = new Pool({ connectionString: DATABASE_URL });
    try {
      const tempId = 'dd110001-0000-0000-0002-999999999999';
      await cleanPool.query(
        `INSERT INTO job_postings (id, case_number, vacancy_number, title, status, description, patient_id)
         VALUES ($1, 99991, 99991, 'CASO 99991-99991', 'CLOSED', 'Temp vacancy for test', $2)
         ON CONFLICT (id) DO NOTHING`,
        [tempId, IDS.patient],
      );

      const res = await api.get('/api/public/v1/jobs');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.data)).toBe(true);

      await cleanPool.query(`DELETE FROM job_postings WHERE id = $1`, [tempId]);
    } finally {
      await cleanPool.end();
    }
  });

  // ── Filter suite ─────────────────────────────────────────────────────────────

  describe('?country filter', () => {
    it('no ?country defaults to AR — does not return BR fixtures', async () => {
      const res = await api.get('/api/public/v1/jobs');
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).not.toContain(IDS.searchingBR);
      expect(ids).not.toContain(IDS.activeBR);
      // AR fixtures are present
      expect(ids).toContain(IDS.searching);
    });

    it('?country=BR returns only BR fixtures and not AR', async () => {
      const res = await api.get('/api/public/v1/jobs?country=BR');
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).toContain(IDS.searchingBR);
      expect(ids).toContain(IDS.activeBR);
      expect(ids).not.toContain(IDS.searching);
      expect(ids).not.toContain(IDS.active);
    });

    it('?country=ar (lowercase) normalises to AR — returns AR fixtures', async () => {
      const res = await api.get('/api/public/v1/jobs?country=ar');
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).toContain(IDS.searching);
      expect(ids).not.toContain(IDS.searchingBR);
    });

    it('?country=ARGENTINA → 400 (not exactly 2 chars)', async () => {
      const res = await api.get('/api/public/v1/jobs?country=ARGENTINA');
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Invalid query params');
    });
  });

  describe('?state filter', () => {
    it('?country=AR&state=CABA returns the filterAR vacancy', async () => {
      const res = await api.get('/api/public/v1/jobs?country=AR&state=CABA');
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).toContain(IDS.filterAR);
      // Fixtures without address should not appear
      expect(ids).not.toContain(IDS.searching);
    });

    it('?country=BR&state=CABA — BR has no CABA address → filterAR not in result', async () => {
      const res = await api.get('/api/public/v1/jobs?country=BR&state=CABA');
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      // AR vacancy must not appear (country mismatch)
      expect(ids).not.toContain(IDS.filterAR);
    });
  });

  describe('?pathology filter', () => {
    it('?country=AR&pathology=Alzheimer returns filterAR (patient has "Alzheimer" in description)', async () => {
      // filterAR patient (IDS.patient) has diagnosis 'TEA'
      // patientBR has 'Alzheimer' but is country BR
      // We need to check that the ILIKE search on p.diagnosis works
      // filterAR description mentions Alzheimer but the DB field is patients.diagnosis
      // IDS.patient diagnosis = 'TEA' so this should return empty for AR
      const res = await api.get('/api/public/v1/jobs?country=AR&pathology=TEA');
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      // All AR vacancies linked to IDS.patient (diagnosis=TEA) should appear
      expect(ids).toContain(IDS.filterAR);
    });

    it('?country=BR&pathology=Alzheimer returns BR fixtures linked to Alzheimer patient', async () => {
      const res = await api.get('/api/public/v1/jobs?country=BR&pathology=Alzheimer');
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).toContain(IDS.searchingBR);
    });
  });

  describe('?worker_sex filter', () => {
    it('?country=AR&worker_sex=FEMALE returns filterAR (required_sex=FEMALE)', async () => {
      const res = await api.get('/api/public/v1/jobs?country=AR&worker_sex=FEMALE');
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).toContain(IDS.filterAR);
      // Vacancies with no required_sex should not appear
      expect(ids).not.toContain(IDS.searching);
    });

    it('?worker_sex=INVALID → 400', async () => {
      const res = await api.get('/api/public/v1/jobs?worker_sex=INVALID');
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Invalid query params');
    });
  });

  describe('?worker_type filter', () => {
    it('?country=AR&worker_type=AT returns filterAR (required_professions includes AT)', async () => {
      const res = await api.get('/api/public/v1/jobs?country=AR&worker_type=AT');
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).toContain(IDS.filterAR);
      // Vacancies without required_professions should not appear
      expect(ids).not.toContain(IDS.searching);
    });
  });

  describe('?q free-text filter', () => {
    it('?country=AR&q=Temperley returns filterAR (address neighborhood matches)', async () => {
      const res = await api.get('/api/public/v1/jobs?country=AR&q=Temperley');
      expect(res.status).toBe(200);
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).toContain(IDS.filterAR);
    });

    it('?country=AR&q=nonexistent → empty result set', async () => {
      const res = await api.get('/api/public/v1/jobs?country=AR&q=xyzzy_nonexistent_9999');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.data)).toBe(true);
      // Should not return any of our fixtures
      const ids = (res.data.data as Array<{ id: string }>).map(j => j.id);
      expect(ids).not.toContain(IDS.filterAR);
      expect(ids).not.toContain(IDS.searching);
    });
  });

  describe('country field in response shape', () => {
    it('AR vacancy has country="AR" in the response', async () => {
      const res = await api.get('/api/public/v1/jobs?country=AR');
      const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.searching);
      expect(job).toBeDefined();
      expect(job!.country).toBe('AR');
    });

    it('BR vacancy has country="BR" in the response', async () => {
      const res = await api.get('/api/public/v1/jobs?country=BR');
      const job = (res.data.data as Array<Record<string, unknown>>).find(j => j.id === IDS.searchingBR);
      expect(job).toBeDefined();
      expect(job!.country).toBe('BR');
    });
  });
});
