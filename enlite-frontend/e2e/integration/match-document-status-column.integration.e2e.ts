/**
 * match-document-status-column.integration.e2e.ts @integration
 *
 * Visual + structural regression for the new "Documentos" column on the
 * vacancy match list (/admin/vacancies/:id/match).
 *
 * The column renders the shared DocsStatusBadge driven by
 * SavedCandidate.documentStatus (worker_documents.documents_status), with the
 * 6 canonical values + null → '—'.
 *
 * Uses the integration auth pattern (mock Firebase Identity Toolkit + mock
 * /api/admin/auth/profile) and mocks GET /api/admin/vacancies/:id,
 * POST /api/admin/vacancies/:id/match and GET /api/admin/vacancies/:id/match-results
 * via page.route() — does NOT require the Firebase Emulator or a real backend.
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_ADMIN_USER = {
  uid: 'e2e-match-docs-visual',
  email: 'admin.match-docs-visual@e2e.test',
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

const VACANCY_ID = 'v-match-docs-0000-0000-000000000000';

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 234,
  vacancy_number: 12,
  status: 'ACTIVE',
  is_draft: false,
};

// One candidate per documents_status value + a null one.
const MOCK_CANDIDATES = [
  candidate('w-1', 'Ana Gómez', 'approved', 95),
  candidate('w-2', 'Bruno Díaz', 'submitted', 88),
  candidate('w-3', 'Carla Ruiz', 'under_review', 80),
  candidate('w-4', 'Diego Mora', 'pending', 72),
  candidate('w-5', 'Elena Vega', 'incomplete', 64),
  candidate('w-6', 'Fabio Luna', 'rejected', 55),
  candidate('w-7', 'Gina Soto', null, 40),
];

function candidate(
  workerId: string,
  workerName: string,
  documentStatus: string | null,
  matchScore: number,
) {
  return {
    workerId,
    workerName,
    workerPhone: '+5491100000000',
    occupation: 'AT',
    workZone: 'Palermo',
    distanceKm: 3.1,
    activeCasesCount: 0,
    overallStatus: 'QUALIFICADO',
    documentStatus,
    matchScore,
    internalNotes: null,
    alreadyApplied: false,
    messagedAt: null,
  };
}

const MATCH_RESPONSE = {
  jobPostingId: VACANCY_ID,
  lastMatchAt: '2026-06-15T12:00:00Z',
  totalCandidates: MOCK_CANDIDATES.length,
  candidates: MOCK_CANDIDATES,
};

// ── Auth + API interceptors ──────────────────────────────────────────────────

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
            firstName: 'Match',
            lastName: 'Docs',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    // POST .../match and GET .../match-results both feed SavedCandidate[].
    if (url.includes(`/api/admin/vacancies/${VACANCY_ID}/match`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MATCH_RESPONSE }),
      });
      return;
    }

    // GET single vacancy detail.
    if (url.includes(`/api/admin/vacancies/${VACANCY_ID}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
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

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('VacancyMatchPage — Documentos column @integration', () => {
  test.setTimeout(90_000);

  test('renders the Documentos column header and per-candidate badges', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);

    await expect(page.getByText('Ana Gómez')).toBeVisible({ timeout: 20_000 });

    // New column header is present.
    await expect(page.getByRole('columnheader', { name: /^Documentos$/ })).toBeVisible();

    // Badges per status (es locale labels).
    await expect(page.getByText('Aprobado', { exact: true })).toBeVisible();
    await expect(page.getByText('Enviado', { exact: true })).toBeVisible();
    await expect(page.getByText('En revisión', { exact: true })).toBeVisible();
    await expect(page.getByText('Pendiente', { exact: true })).toBeVisible();
    await expect(page.getByText('Incompleto', { exact: true })).toBeVisible();
    await expect(page.getByText('Rechazado', { exact: true })).toBeVisible();

    // Null documentStatus → em dash placeholder.
    await expect(page.getByText('—').first()).toBeVisible();
  });

  test('matches Playwright screenshot baseline (es locale)', async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`/admin/vacancies/${VACANCY_ID}/match`);
    await expect(page.getByText('Ana Gómez')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Gina Soto')).toBeVisible({ timeout: 10_000 });

    await expect(page).toHaveScreenshot('match-document-status-column.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });
});
