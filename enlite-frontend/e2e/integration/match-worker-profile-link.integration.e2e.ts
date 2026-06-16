/**
 * match-worker-profile-link.integration.e2e.ts @integration
 *
 * Visual + structural regression for the match list → worker detail navigation
 * (feat/match-worker-profile-link):
 *
 *   - In the vacancy MATCH list, the provider name became a
 *     <button data-testid="match-worker-link"> that navigates to
 *     /admin/workers/:workerId with { state: { from: <current path> } }.
 *   - WorkerDetailPage "Volver" reads location.state.from and returns to the
 *     originating match list.
 *
 * Uses the integration auth pattern (mock Firebase Identity Toolkit + mock
 * /api/admin/auth/profile) — no Firebase Emulator nor real backend. All domain
 * endpoints are mocked below, including the POST /match the page fires on mount.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ── Mock identities ──────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-match-worker-link',
  email: 'admin.match-worker-link@e2e.test',
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

const VACANCY_ID = 'v-match-link-0000-0000-000000000000';
const WORKER_ID = 'w-test-1';

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 766,
  vacancy_number: 3,
  title: 'CASO 766-3',
  status: 'ACTIVE',
  dependency_level: 'TOTAL',
  required_professions: ['AT'],
  required_sex: 'ANY',
  patient_first_name: 'María',
  patient_last_name: 'González',
  patient_zone: 'Palermo',
  city: 'Buenos Aires',
  providers_needed: 1,
  created_at: '2026-01-10T12:00:00.000Z',
  closed_at: null,
  publications: [],
};

const MOCK_MATCH_RESULTS = {
  jobPostingId: VACANCY_ID,
  lastMatchAt: '2026-01-12T10:00:00.000Z',
  totalCandidates: 2,
  candidates: [
    {
      workerId: WORKER_ID,
      workerName: 'Juan Pérez',
      workerPhone: '+54 11 5555-0001',
      occupation: 'Acompañante Terapéutico',
      workZone: 'Palermo',
      distanceKm: 3.2,
      activeCasesCount: 0,
      overallStatus: 'QUALIFICADO',
      matchScore: 92,
      internalNotes: null,
      alreadyApplied: false,
      messagedAt: null,
    },
    {
      workerId: 'w-test-2',
      workerName: 'María García',
      workerPhone: '+54 11 5555-0002',
      occupation: 'Enfermera',
      workZone: 'Caballito',
      distanceKm: 6.7,
      activeCasesCount: 1,
      overallStatus: 'TALENTUM',
      matchScore: 78,
      internalNotes: null,
      alreadyApplied: false,
      messagedAt: null,
    },
  ],
};

const MOCK_WORKER = {
  id: WORKER_ID,
  email: 'juan.perez@example.com',
  phone: '+54 11 5555-0001',
  whatsappPhone: '+54 11 5555-0001',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  status: 'REGISTERED',
  overallStatus: null,
  availabilityStatus: null,
  dataSources: ['platform'],
  platform: 'enlite',
  createdAt: '2026-01-01T12:00:00.000Z',
  updatedAt: '2026-01-05T12:00:00.000Z',
  firstName: 'Juan',
  lastName: 'Pérez',
  sex: 'MALE',
  gender: null,
  birthDate: '1990-06-15',
  documentType: 'DNI',
  documentNumber: '30111222',
  profilePhotoUrl: null,
  profession: 'AT',
  occupation: 'Acompañante Terapéutico',
  knowledgeLevel: null,
  titleCertificate: null,
  experienceTypes: [],
  yearsExperience: '5',
  preferredTypes: [],
  preferredAgeRange: [],
  languages: ['ES'],
  sexualOrientation: null,
  race: null,
  religion: null,
  weightKg: null,
  heightCm: null,
  hobbies: [],
  diagnosticPreferences: [],
  linkedinUrl: null,
  isMatchable: true,
  isActive: true,
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
    address: 'Av. Santa Fe 1234',
    city: 'Buenos Aires',
    workZone: 'Palermo',
    interestZone: 'Recoleta',
  },
  encuadres: [],
  availability: [],
};

// ── Interceptors ─────────────────────────────────────────────────────────────

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

    if (url.includes('/api/admin/auth/profile')) {
      return ok({
        id: MOCK_ADMIN_USER.uid,
        email: MOCK_ADMIN_USER.email,
        role: 'superadmin',
        firstName: 'Match',
        lastName: 'Link',
        isActive: true,
        mustChangePassword: false,
      });
    }

    // Match results (GET) — authoritative source for the table.
    // Must come before the POST /match and generic vacancy-by-id matchers.
    if (/\/api\/admin\/vacancies\/[^/]+\/match-results/.test(url)) {
      return ok(MOCK_MATCH_RESULTS);
    }

    // Run match (POST) fired on mount — return the same candidates.
    if (/\/api\/admin\/vacancies\/[^/]+\/match(\?|$)/.test(url)) {
      return ok(MOCK_MATCH_RESULTS);
    }

    // Worker detail
    if (new RegExp(`/api/admin/workers/${WORKER_ID}(\\?|$)`).test(url)) {
      return ok(MOCK_WORKER);
    }

    // Worker additional documents (fetched on WorkerDetailPage mount)
    if (/\/api\/admin\/workers\/[^/]+\/additional-documents/.test(url)) {
      return ok([]);
    }

    // Vacancy detail by id
    if (/\/api\/admin\/vacancies\/[^/]+(\?|$)/.test(url)) {
      return ok(MOCK_VACANCY);
    }

    // Anything else — empty success so nothing crashes.
    if (route.request().method() === 'GET') {
      return ok(null);
    }

    return ok(null);
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

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Match list → Worker detail navigation @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 1920, height: 1080 } });
  test.setTimeout(120_000);

  test('clicking match candidate name navigates to worker detail and back to the match list', async ({
    page,
  }) => {
    await loginAsAdmin(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);

    const workerLink = page.locator('[data-testid="match-worker-link"]').first();
    await expect(workerLink).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Juan Pérez')).toBeVisible();

    // 1) Visual: the match table with the clickable candidate name.
    await expect(page).toHaveScreenshot('match-list-worker-link.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });

    // 2) Click the name → navigate to worker detail with origin in state.
    await workerLink.click();
    await page.waitForURL(new RegExp(`/admin/workers/${WORKER_ID}`), { timeout: 20_000 });
    await expect(page.getByText('Juan Pérez', { exact: false }).first()).toBeVisible({
      timeout: 20_000,
    });

    // Visual: worker detail reached from the match list.
    await expect(page).toHaveScreenshot('worker-detail-from-match.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });

    // 3) "Volver" reads location.state.from → returns to the origin match list.
    await page.getByRole('button', { name: /Volver/i }).click();
    await page.waitForURL(new RegExp(`/admin/vacancies/${VACANCY_ID}/match`), { timeout: 20_000 });
    await expect(page.locator('[data-testid="match-worker-link"]').first()).toBeVisible({
      timeout: 20_000,
    });
  });
});
