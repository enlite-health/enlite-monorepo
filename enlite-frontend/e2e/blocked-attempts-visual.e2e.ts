/**
 * blocked-attempts-visual.e2e.ts
 *
 * Visual E2E — Tela de tentativas de postulação bloqueadas.
 * Rota: /admin/recruitment/blocked-attempts
 *
 * Objetivo: provar a experiência real do operador via screenshot determinístico.
 * Todos os endpoints são mockados — zero dependência de dados reais.
 *
 * Auth: Firebase Identity Toolkit interceptado localmente (sem emulador, sem conta real).
 * Técnica idêntica à usada em full-create-vacancy.integration.e2e.ts.
 *
 * Estados capturados:
 *   1. POPULADO — agregados no topo, badges de campos faltantes, múltiplos motivos
 *   2. VAZIO — empty state com ícone e mensagem
 *   3. ERRO — alert com mensagem de erro e botão retry
 *   4. FILTRADO — only registration_incomplete reason applied
 *
 * Run: pnpm test:e2e:no-integration --update-snapshots (1ª vez)
 *      pnpm test:e2e:no-integration (runs subsequentes)
 */

import { test, expect, Page, Route } from '@playwright/test';

// ── Auth constants ─────────────────────────────────────────────────────────────

const MOCK_ADMIN = {
  uid: 'blocked-vis-admin-uid',
  email: 'blocked.visual@e2e.test',
  role: 'superadmin',
};

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN.uid,
      email: MOCK_ADMIN.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

// ── Deterministic fixture IDs ─────────────────────────────────────────────────

const WORKER_ID_1 = 'aaaaaaaa-ba01-ba01-ba01-000000000001';
const WORKER_ID_2 = 'aaaaaaaa-ba02-ba02-ba02-000000000002';
const VACANCY_ID_1 = 'bbbbbbbb-ba01-ba01-ba01-000000000001';

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_ATTEMPTS_POPULATED = [
  {
    id: 'ba-vis-0001',
    workerId: WORKER_ID_1,
    jobPostingId: VACANCY_ID_1,
    blockedReason: 'registration_incomplete',
    missingFields: ['profession', 'worker_documents', 'criminalRecord'],
    attemptCount: 5,
    firstAttemptedAt: '2026-06-01T10:00:00Z',
    lastAttemptedAt: '2026-06-15T14:30:00Z',
    acquisitionChannel: 'whatsapp',
    createdAt: '2026-06-01T10:00:00Z',
    updatedAt: '2026-06-15T14:30:00Z',
  },
  {
    id: 'ba-vis-0002',
    workerId: WORKER_ID_2,
    jobPostingId: VACANCY_ID_1,
    blockedReason: 'worker_disabled',
    missingFields: [],
    attemptCount: 1,
    firstAttemptedAt: '2026-06-10T09:00:00Z',
    lastAttemptedAt: '2026-06-10T09:00:00Z',
    acquisitionChannel: null,
    createdAt: '2026-06-10T09:00:00Z',
    updatedAt: '2026-06-10T09:00:00Z',
  },
];

const MOCK_AGGREGATES_POPULATED = {
  totalBlocked: 42,
  byReason: {
    registration_incomplete: 35,
    worker_disabled: 5,
    worker_not_found: 2,
  },
};

const MOCK_PAGINATION = {
  total: 2, limit: 20, offset: 0, page: 1, totalPages: 1,
  hasNext: false, hasPrev: false,
};

const MOCK_WORKER_TEMPLATE = {
  status: 'INCOMPLETE_REGISTER', phone: null, whatsappPhone: null,
  country: 'AR', timezone: 'America/Argentina/Buenos_Aires', dataSources: [],
  platform: 'self', overallStatus: null, availabilityStatus: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  sex: null, gender: null, birthDate: null, documentType: null, documentNumber: null,
  profilePhotoUrl: null, profession: null, occupation: null, knowledgeLevel: null,
  titleCertificate: null, experienceTypes: [], yearsExperience: null, preferredTypes: [],
  preferredAgeRange: [], languages: [], sexualOrientation: null, race: null, religion: null,
  weightKg: null, heightCm: null, hobbies: [], diagnosticPreferences: [], linkedinUrl: null,
  isMatchable: false, isActive: false, documents: null, serviceAreas: [], location: null,
  encuadres: [],
};

const MOCK_WORKER_1 = {
  ...MOCK_WORKER_TEMPLATE,
  id: WORKER_ID_1, firstName: 'María', lastName: 'González',
  email: 'maria.vis@test.com',
};

const MOCK_WORKER_2 = {
  ...MOCK_WORKER_TEMPLATE,
  id: WORKER_ID_2, firstName: 'Carlos', lastName: 'Ruiz',
  email: 'carlos.vis@test.com',
};

const MOCK_VACANCY_1 = {
  id: VACANCY_ID_1, title: 'CASO 766-1', status: 'OPEN', case_number: 766,
  vacancy_number: 1, patient_id: null, patient_zone: 'CABA', required_professions: ['AT'],
  service_type: ['AT'], dependency_level: 'SEVERE', country: 'AR',
  providers_needed: 1, is_draft: false, encuadres: [], publications: [],
  created_at: '2026-01-01T00:00:00Z', closed_at: null,
  patient_first_name: null, patient_last_name: null, patient_diagnosis: null,
  patient_city: null, patient_neighborhood: null, patient_address_id: null,
  patient_address_formatted: null, patient_address_raw: null, required_sex: null,
  age_range_min: null, age_range_max: null, required_experience: null,
  worker_attributes: null, schedule: null, schedule_days_hours: null, work_schedule: null,
  city: null, insurance_verified: null, salary_text: null, payment_day: null,
  daily_obs: null, published_at: null, closes_at: null, talentum_description: null,
  talentum_project_id: null, talentum_whatsapp_url: null, talentum_slug: null,
  talentum_published_at: null, meet_link_1: null, meet_datetime_1: null,
  meet_link_2: null, meet_datetime_2: null, meet_link_3: null, meet_datetime_3: null,
  social_short_links: null,
};

// ── Auth helper (no emulator, no real Firebase) ───────────────────────────────

async function installFakeFirebaseAuth(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          localId: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    if (url.includes('token') || url.includes('securetoken')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id_token: FAKE_ID_TOKEN,
          access_token: FAKE_ID_TOKEN,
          expires_in: '3600',
          token_type: 'Bearer',
          refresh_token: 'fake-refresh-token',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{
          localId: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, emailVerified: true,
        }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
      }),
    });
  });

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, role: MOCK_ADMIN.role,
          firstName: 'Visual', lastName: 'E2E', isActive: true, mustChangePassword: false,
        },
      }),
    }),
  );
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installFakeFirebaseAuth(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Mock API helpers ──────────────────────────────────────────────────────────

function mockBlockedPopulated(page: Page): void {
  page.route('**/api/admin/recruitment/blocked-attempts**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: MOCK_ATTEMPTS_POPULATED,
        aggregates: MOCK_AGGREGATES_POPULATED,
        pagination: MOCK_PAGINATION,
      }),
    }),
  );
  page.route(`**/api/admin/workers/${WORKER_ID_1}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_WORKER_1 }),
    }),
  );
  page.route(`**/api/admin/workers/${WORKER_ID_2}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_WORKER_2 }),
    }),
  );
  page.route(`**/api/admin/vacancies/${VACANCY_ID_1}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_VACANCY_1 }),
    }),
  );
}

function mockBlockedEmpty(page: Page): void {
  page.route('**/api/admin/recruitment/blocked-attempts**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [],
        aggregates: { totalBlocked: 0, byReason: {} },
        pagination: { ...MOCK_PAGINATION, total: 0 },
      }),
    }),
  );
}

function mockBlockedError(page: Page): void {
  page.route('**/api/admin/recruitment/blocked-attempts**', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Internal server error' }),
    }),
  );
}

function mockBlockedFiltered(page: Page, workerRoute = true): void {
  page.route('**/api/admin/recruitment/blocked-attempts**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [MOCK_ATTEMPTS_POPULATED[0]],
        aggregates: { totalBlocked: 35, byReason: { registration_incomplete: 35 } },
        pagination: { ...MOCK_PAGINATION, total: 1 },
      }),
    }),
  );
  if (workerRoute) {
    page.route(`**/api/admin/workers/${WORKER_ID_1}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_WORKER_1 }),
      }),
    );
  }
  page.route(`**/api/admin/vacancies/${VACANCY_ID_1}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_VACANCY_1 }),
    }),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('BlockedAttemptsPage — visual proof', () => {
  test.setTimeout(90000);

  test('POPULADO: agrega totais + tabela + badges campos faltantes', async ({ page }) => {
    await loginAsAdmin(page);
    mockBlockedPopulated(page);

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.locator('[data-testid="blocked-content"]')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('agg-total').getByText('42')).toBeVisible({ timeout: 10000 });

    // Wait for async worker name resolution
    await expect(page.locator('text=María González').first()).toBeVisible({ timeout: 20000 });
    await expect(page.locator('text=Carlos Ruiz').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=CASO 766-1').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Registro incompleto').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Profesión').first()).toBeVisible({ timeout: 5000 });

    await expect(page).toHaveScreenshot('blocked-attempts-populated.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('VAZIO: empty state com ícone e mensagem', async ({ page }) => {
    await loginAsAdmin(page);
    mockBlockedEmpty(page);

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.locator('[data-testid="blocked-content"]')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('blocked-empty')).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator('text=No hay intentos de postulación bloqueados').first(),
    ).toBeVisible({ timeout: 5000 });

    await expect(page).toHaveScreenshot('blocked-attempts-empty.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('ERRO: alert com mensagem de erro e botão retry', async ({ page }) => {
    await loginAsAdmin(page);
    mockBlockedError(page);

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.getByTestId('blocked-error')).toBeVisible({ timeout: 20000 });
    await expect(
      page.getByRole('button', { name: /Reintentar/i }),
    ).toBeVisible({ timeout: 5000 });

    await expect(page).toHaveScreenshot('blocked-attempts-error.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('FILTRADO: apenas motivo registration_incomplete aplicado', async ({ page }) => {
    await loginAsAdmin(page);
    mockBlockedFiltered(page);

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.locator('[data-testid="blocked-content"]')).toBeVisible({ timeout: 20000 });

    const select = page.locator('[data-testid="blocked-filters"] select').first();
    await select.selectOption('registration_incomplete');

    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/recruitment/blocked-attempts') &&
        resp.status() === 200,
      { timeout: 10000 },
    );

    await expect(page.locator('text=María González').first()).toBeVisible({ timeout: 20000 });

    await expect(page).toHaveScreenshot('blocked-attempts-filtered.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });
});
