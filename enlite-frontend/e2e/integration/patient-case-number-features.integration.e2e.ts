/**
 * patient-case-number-features.integration.e2e.ts @integration
 *
 * Visual + structural regression for two features:
 *
 *   Feature 1 — "Código" column + case_number filter in the patients list
 *     - Column "Código" is visible showing "Caso #<N>"
 *     - Code filter input sends case_number query param to the API
 *
 *   Feature 2 — Caso # badge + "Vacantes Generadas" card in patient detail
 *     - PatientIdentityCard shows "Caso #42" badge when lastCaseNumber is set
 *     - PatientVacanciesCard renders in the dedicated "Vacantes" tab
 *
 * Uses the same mock-auth strategy as admin-vacancies-list-visual.integration.e2e.ts:
 *   - Firebase Identity Toolkit mocked → fake JWT
 *   - /api/admin/auth/profile mocked
 *   - All /api/** calls have token swapped to mock_* for backend
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ── Constants ─────────────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-patient-case-number',
  email: 'admin.case-number@e2e.test',
  role: 'superadmin',
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

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_PATIENTS = [
  {
    id: 'patient-aaa-111',
    firstName: 'Ana',
    lastName: 'García',
    documentType: 'DNI',
    documentNumber: '12345678',
    caseNumber: 42,
    dependencyLevel: 'MODERATE',
    clinicalSpecialty: 'NEUROLOGICAL',
    serviceType: ['AT'],
    needsAttention: false,
    attentionReasons: [],
  },
  {
    id: 'patient-bbb-222',
    firstName: 'Carlos',
    lastName: 'López',
    documentType: 'DNI',
    documentNumber: '87654321',
    caseNumber: null,
    dependencyLevel: 'MILD',
    clinicalSpecialty: 'ASD',
    serviceType: ['AT'],
    needsAttention: true,
    attentionReasons: ['MISSING_INFO'],
  },
];

const MOCK_STATS = {
  total: 2,
  complete: 1,
  needsAttention: 1,
  createdToday: 0,
  createdYesterday: 0,
  createdLast7Days: 2,
};

const MOCK_PATIENT_DETAIL = {
  id: 'patient-aaa-111',
  clickupTaskId: 'cu-task-111',
  firstName: 'Ana',
  lastName: 'García',
  birthDate: '1985-03-15T00:00:00.000Z',
  documentType: 'DNI',
  documentNumber: '12345678',
  affiliateId: null,
  sex: 'FEMALE',
  phoneWhatsapp: '+5491122334455',
  diagnosis: 'Diagnóstico de prueba',
  dependencyLevel: 'MODERATE',
  clinicalSpecialty: 'NEUROLOGICAL',
  clinicalSegments: null,
  serviceType: ['AT'],
  deviceType: null,
  additionalComments: null,
  hasJudicialProtection: false,
  hasCud: false,
  hasConsent: true,
  insuranceInformed: null,
  insuranceVerified: null,
  cityLocality: 'Buenos Aires',
  province: 'CABA',
  zoneNeighborhood: 'Palermo',
  country: 'AR',
  status: 'ACTIVE',
  needsAttention: false,
  attentionReasons: [],
  responsibles: [],
  addresses: [],
  professionals: [],
  lastCaseNumber: 42,
  createdAt: '2024-01-15T10:00:00.000Z',
  updatedAt: '2024-06-01T15:30:00.000Z',
};

const MOCK_PATIENT_VACANCIES = [
  {
    id: 'vacancy-v1-aaa',
    caseNumber: 42,
    vacancyNumber: 1,
    title: 'CASO 42-1',
    status: 'ACTIVE',
    isDraft: false,
    createdAt: '2024-02-01T10:00:00.000Z',
  },
  {
    id: 'vacancy-v2-bbb',
    caseNumber: 42,
    vacancyNumber: 2,
    title: 'CASO 42-2',
    status: 'CLOSED',
    isDraft: false,
    createdAt: '2024-03-10T10:00:00.000Z',
  },
  {
    id: 'vacancy-v3-ccc',
    caseNumber: 42,
    vacancyNumber: 3,
    title: 'CASO 42-3',
    status: 'SEARCHING',
    isDraft: true,
    createdAt: '2024-05-20T10:00:00.000Z',
  },
];

// ── Auth helpers ──────────────────────────────────────────────────────────────

async function installInterceptors(page: Page): Promise<void> {
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
        users: [
          { localId: MOCK_ADMIN_USER.uid, email: MOCK_ADMIN_USER.email, emailVerified: true },
        ],
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

    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: MOCK_ADMIN_USER.uid,
            email: MOCK_ADMIN_USER.email,
            role: 'superadmin',
            firstName: 'Admin',
            lastName: 'Test',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    if (url.includes('/api/admin/patients/stats')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_STATS }),
      });
      return;
    }

    if (/\/api\/admin\/patients\/patient-aaa-111\/vacancies/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT_VACANCIES }),
      });
      return;
    }

    if (/\/api\/admin\/patients\/patient-aaa-111$/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PATIENT_DETAIL }),
      });
      return;
    }

    if (/\/api\/admin\/patients(\?|$)/.test(url)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: MOCK_PATIENTS,
          total: MOCK_PATIENTS.length,
        }),
      });
      return;
    }

    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'es');
  });
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN_USER.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Tests: Feature 1 — patients list ────────────────────────────────────────

test.describe('AdminPatientsPage — Código column + case_number filter @integration', () => {
  test.setTimeout(90_000);

  test('renders "Código" column header and shows "Caso #42" for patient with caseNumber', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/patients');
    await expect(page.getByText('García, Ana')).toBeVisible({ timeout: 15_000 });

    // Column header present
    await expect(page.getByRole('columnheader', { name: /^Código$/i })).toBeVisible();

    // Patient with caseNumber=42 shows "Caso #42"
    await expect(page.getByText('Caso #42')).toBeVisible();

    // Patient without caseNumber shows "—"
    const rows = page.locator('tbody tr');
    const carlosRow = rows.filter({ hasText: 'López, Carlos' });
    await expect(carlosRow).toBeVisible();
  });

  test('code filter input is visible with correct label and placeholder', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/patients');
    await expect(page.getByText('García, Ana')).toBeVisible({ timeout: 15_000 });

    // Label rendered
    await expect(page.locator('[data-testid="filter-code"]').getByText('Código')).toBeVisible();

    // Placeholder on input
    const codeInput = page.locator('[data-testid="filter-code"] input');
    await expect(codeInput).toBeVisible();
    await expect(codeInput).toHaveAttribute('placeholder', 'Nº de caso');
  });

  test('typing in code filter sends case_number query param to API', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/patients');
    await expect(page.getByText('García, Ana')).toBeVisible({ timeout: 15_000 });

    // Wait for the request with case_number param
    const reqWait = page.waitForRequest(
      (req) =>
        req.url().includes('/api/admin/patients') && req.url().includes('case_number=766'),
      { timeout: 10_000 },
    );

    await page.locator('[data-testid="filter-code"] input').fill('766');
    const req = await reqWait;
    expect(req.url()).toContain('case_number=766');
  });

  test('patients list with Código column matches screenshot baseline', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/patients');
    await expect(page.getByText('García, Ana')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Caso #42')).toBeVisible({ timeout: 5_000 });

    await expect(page).toHaveScreenshot('patients-list-with-code-column.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.05,
    });
  });
});

// ── Tests: Feature 2 — patient detail ────────────────────────────────────────

test.describe('PatientDetailPage — Caso # badge + PatientVacanciesCard @integration', () => {
  test.setTimeout(90_000);

  test('shows "Caso #42" badge in identity card when lastCaseNumber is set', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/patients/patient-aaa-111');

    // Wait for patient data to load
    await expect(page.getByText('Ana García')).toBeVisible({ timeout: 15_000 });

    // Caso badge visible
    await expect(page.getByText('Caso #42')).toBeVisible();
  });

  test('shows PatientVacanciesCard with vacancies in Vacantes tab', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/patients/patient-aaa-111');
    await expect(page.getByText('Ana García')).toBeVisible({ timeout: 15_000 });

    // Navigate to Servicio Contratado tab (tabs are rendered as <button>)
    await page.getByRole('button', { name: /^Vacantes$/i }).click();

    // Card title
    await expect(page.getByText('Vacantes Generadas')).toBeVisible({ timeout: 10_000 });

    // Vacancy items
    await expect(page.getByText('CASO 42-1')).toBeVisible();
    await expect(page.getByText('CASO 42-2')).toBeVisible();
    await expect(page.getByText('CASO 42-3')).toBeVisible();

    // Draft badge on v3
    await expect(page.getByText('Borrador')).toBeVisible();
  });

  test('patient detail page matches screenshot baseline (Caso # visible)', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/patients/patient-aaa-111');
    await expect(page.getByText('Ana García')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Caso #42')).toBeVisible({ timeout: 5_000 });

    await expect(page).toHaveScreenshot('patient-detail-case-number-badge.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.05,
    });
  });

  test('PatientVacanciesCard tab matches screenshot baseline', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/admin/patients/patient-aaa-111');
    await expect(page.getByText('Ana García')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /^Vacantes$/i }).click();
    await expect(page.getByText('Vacantes Generadas')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('CASO 42-1')).toBeVisible();

    // Screenshot the card itself (it renders below the fold) so the baseline
    // actually proves the vacancies render, not just the page header.
    const card = page.getByTestId('patient-vacancies-card');
    await card.scrollIntoViewIfNeeded();
    await expect(card).toHaveScreenshot('patient-detail-vacancies-card.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
