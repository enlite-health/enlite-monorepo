/**
 * worker-tags.integration.e2e.ts @integration
 *
 * Visual regression for the "Tags para Profissionais" feature:
 *   1. Worker detail — colored tag chips rendered below "Altura", with the
 *      "+ Tag" dropdown to assign more from the catalog.
 *   2. Tag catalog admin page (/admin/tags) — CRUD list, admin-only.
 *   3. Worker listing — tag multi-select filter (dropdown open).
 *
 * Uses the integration auth pattern (mock Firebase Identity Toolkit + mock
 * /api/admin/auth/profile). All domain endpoints are mocked via page.route so
 * the REAL UI renders with controlled data. Profile role is 'admin' so the
 * admin-only catalog menu/route is reachable.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ── Mock identities ──────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-worker-tags',
  email: 'admin.worker-tags@e2e.test',
  role: 'admin',
};
const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN_USER), 'utf-8').toString('base64');
const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN_USER.uid,
      uid: MOCK_ADMIN_USER.uid,
      email: MOCK_ADMIN_USER.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

// ── Mock domain data ─────────────────────────────────────────────────────────

const WORKER_ID = 'w-tags-0000-0000-000000000001';

const TAG_DISPONIVEL = { id: 'tag-1', name: 'Disponible ya', color: '#16A34A', description: 'Puede empezar de inmediato' };
const TAG_NOCTURNO = { id: 'tag-2', name: 'Turno noche', color: '#7C3AED', description: 'Prefiere turnos nocturnos' };
const TAG_EXPERIENCIA = { id: 'tag-3', name: 'Experiencia Alzheimer', color: '#EA580C', description: undefined };
const TAG_BILINGUE = { id: 'tag-4', name: 'Bilingüe', color: '#0EA5E9', description: 'Español + Inglés' };

// Catalog returned by GET /api/admin/worker-tags (createdBy/at fields included)
const CATALOG = [TAG_DISPONIVEL, TAG_NOCTURNO, TAG_EXPERIENCIA, TAG_BILINGUE].map((t) => ({
  ...t,
  createdBy: MOCK_ADMIN_USER.uid,
  createdAt: '2026-06-01T12:00:00.000Z',
  updatedAt: '2026-06-01T12:00:00.000Z',
}));

const MOCK_WORKER = {
  id: WORKER_ID,
  email: 'lucia.fernandez@example.com',
  phone: '+54 11 5555-0042',
  whatsappPhone: '+54 11 5555-0042',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  status: 'REGISTERED',
  overallStatus: null,
  availabilityStatus: null,
  dataSources: ['platform'],
  platform: 'enlite',
  createdAt: '2026-01-01T12:00:00.000Z',
  updatedAt: '2026-01-05T12:00:00.000Z',
  firstName: 'Lucía',
  lastName: 'Fernández',
  sex: 'FEMALE',
  gender: null,
  birthDate: '1992-03-20',
  documentType: 'DNI',
  documentNumber: '33444555',
  profilePhotoUrl: null,
  profession: 'AT',
  occupation: 'Acompañante Terapéutico',
  knowledgeLevel: null,
  titleCertificate: null,
  experienceTypes: [],
  yearsExperience: '6',
  preferredTypes: [],
  preferredAgeRange: [],
  languages: ['ES'],
  sexualOrientation: null,
  race: null,
  religion: null,
  weightKg: 62,
  heightCm: 1.68,
  hobbies: [],
  diagnosticPreferences: [],
  linkedinUrl: null,
  isMatchable: true,
  isActive: true,
  // The new field under test:
  tags: [TAG_DISPONIVEL, TAG_NOCTURNO],
  documents: {
    id: 'doc-1',
    resumeCvUrl: null,
    identityDocumentUrl: null,
    identityDocumentBackUrl: null,
    criminalRecordUrl: null,
    professionalRegistrationUrl: null,
    liabilityInsuranceUrl: null,
    monotributoCertificateUrl: null,
    atCertificateUrl: null,
    additionalCertificatesUrls: [],
    documentsStatus: 'PENDING',
    reviewNotes: null,
    reviewedBy: null,
    reviewedAt: null,
    submittedAt: null,
    documentValidations: {},
  },
  serviceAreas: [],
  location: {
    address: 'Av. Corrientes 2500',
    city: 'Buenos Aires',
    workZone: 'Almagro',
    interestZone: 'Caballito',
  },
  encuadres: [],
  availability: [],
};

const MOCK_WORKER_ROW = {
  id: WORKER_ID,
  email: 'lucia.fernandez@example.com',
  phone: '+54 11 5555-0042',
  first_name_encrypted: null,
  last_name_encrypted: null,
  firstName: 'Lucía',
  lastName: 'Fernández',
  data_sources: ['platform'],
  created_at: '2026-01-01T12:00:00.000Z',
  status: 'REGISTERED',
  documents_status: 'pending',
  cases_count: 0,
};

// ── Interceptors ─────────────────────────────────────────────────────────────

async function installInterceptors(page: Page, role: string = 'admin'): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: MOCK_ADMIN_USER.uid,
          email: MOCK_ADMIN_USER.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
        id_token: FAKE_ID_TOKEN,
      }),
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const ok = (data: unknown) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });

    // Admin profile — role 'admin' so the tag catalog menu/route is allowed.
    if (url.includes('/api/admin/auth/profile')) {
      return ok({
        id: MOCK_ADMIN_USER.uid,
        email: MOCK_ADMIN_USER.email,
        role,
        firstName: 'Worker',
        lastName: 'Tags',
        isActive: true,
        mustChangePassword: false,
      });
    }

    // Tag catalog (distinct path "worker-tags")
    if (/\/api\/admin\/worker-tags(\?|$)/.test(url)) {
      return ok(CATALOG);
    }

    // Worker case options (filter dropdown)
    if (url.includes('/api/admin/workers/case-options')) {
      return ok([]);
    }

    // Worker date stats
    if (url.includes('/api/admin/workers/stats')) {
      return ok({ total: 1, byDate: [] });
    }

    // Worker detail by id
    if (new RegExp(`/api/admin/workers/${WORKER_ID}(\\?|$)`).test(url)) {
      return ok(MOCK_WORKER);
    }

    // Worker additional documents (fetched on WorkerDetailPage mount)
    if (/\/api\/admin\/workers\/[^/]+\/additional-documents/.test(url)) {
      return ok([]);
    }

    // Worker listing (envelope: { success, data: [...], total })
    if (/\/api\/admin\/workers(\?|$)/.test(url)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [MOCK_WORKER_ROW], total: 1 }),
      });
    }

    // Anything else: empty success so nothing crashes.
    if (route.request().method() === 'GET') {
      return ok(null);
    }

    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page, role: string = 'admin'): Promise<void> {
  await installInterceptors(page, role);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'es');
  });
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Worker Tags @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1920, height: 1080 } });
  test.setTimeout(120_000);

  test('worker detail renders colored tag chips below Altura', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/admin/workers/${WORKER_ID}`);

    // Both assigned tags must be visible as chips.
    await expect(page.getByText('Disponible ya', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Turno noche', { exact: true })).toBeVisible();

    // The "+ Tag" add control must be present (any staff can assign).
    const addBtn = page.getByRole('button', { name: /Agregar|Añadir|\+ ?Tag|Etiqueta/i }).first();
    await expect(addBtn).toBeVisible();

    await expect(page).toHaveScreenshot('worker-detail-tags.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('tag catalog admin page lists tags (admin-only)', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/tags');

    // Did NOT get bounced by the admin route guard.
    await expect(page).toHaveURL(/\/admin\/tags/, { timeout: 20_000 });

    // Catalog rows visible.
    await expect(page.getByText('Disponible ya', { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Experiencia Alzheimer', { exact: true })).toBeVisible();
    await expect(page.getByText('Bilingüe', { exact: true })).toBeVisible();

    await expect(page).toHaveScreenshot('tag-catalog-page.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('worker listing exposes the tag filter (dropdown open)', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/workers');

    // Wait for the list to settle (row renders the worker's email).
    await expect(page.getByText('lucia.fernandez@example.com').first()).toBeVisible({ timeout: 20_000 });

    // Open the tag multi-select filter (its trigger reads "Todas" — feminine,
    // unique vs the other "Todos" selects).
    const tagFilterBtn = page.getByRole('button', { name: 'Todas', exact: true }).first();
    await expect(tagFilterBtn).toBeVisible({ timeout: 20_000 });
    await tagFilterBtn.click();

    // Options from the catalog appear in the dropdown.
    await expect(page.getByText('Turno noche', { exact: true })).toBeVisible({ timeout: 10_000 });

    await expect(page).toHaveScreenshot('worker-list-tag-filter.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('tag create modal renders (name + color + description)', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/tags');
    await expect(page).toHaveURL(/\/admin\/tags/, { timeout: 20_000 });

    // Open the create modal.
    await page.getByRole('button', { name: /Nueva Etiqueta/i }).click();

    const nameInput = page.locator('#tag-name');
    await expect(nameInput).toBeVisible({ timeout: 10_000 });

    // Fill with sample data so the preview chip is meaningful.
    await nameInput.fill('Disponible fines de semana');
    // Pick a color from the preset palette (pink #DB2777).
    await page.getByRole('button', { name: '#DB2777' }).click();
    await page.locator('#tag-description').fill('Puede trabajar sábados y domingos');

    await expect(page).toHaveScreenshot('tag-create-modal.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('non-admin (recruiter) cannot see the catalog menu and is bounced from /admin/tags', async ({
    page,
  }) => {
    await loginAsAdmin(page, 'recruiter');

    // 1) Sidebar must NOT contain the "Etiquetas" cadastro menu item.
    await page.goto('/admin/workers');
    await expect(page.getByText('Prestadores', { exact: false }).first()).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole('navigation').getByText('Etiquetas', { exact: true }),
    ).toHaveCount(0);

    // 2) Direct navigation to /admin/tags is bounced by the route guard.
    await page.goto('/admin/tags');
    await expect(page).not.toHaveURL(/\/admin\/tags/, { timeout: 20_000 });
  });
});
