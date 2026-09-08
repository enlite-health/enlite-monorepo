/**
 * blocked-attempts.e2e.ts
 *
 * Playwright E2E — Tela de tentativas de postulação bloqueadas
 * Rota: /admin/recruitment/blocked-attempts
 *
 * Fluxos cobertos:
 *   - Página renderiza título e subtítulo
 *   - Estado POPULADO: agrega totais + tabela com worker/vacancy/reason
 *   - Estado VAZIO: mostra mensagem de estado vazio
 *   - Screenshot visual obrigatório — estado POPULADO
 *   - Screenshot visual obrigatório — estado VAZIO
 *   - Filtro por motivo envia query param correto
 *   - Link na AdminRecruitmentPage aponta para /blocked-attempts
 */

import { test, expect, Page } from '@playwright/test';
import { E2E_EMAIL, loginAsAdmin } from './helpers/kanban-notes-e2e-helper';


// ── Mock data ─────────────────────────────────────────────────────────────────

const WORKER_ID_1 = 'aaaaaaaa-0001-0001-0001-000000000001';
const WORKER_ID_2 = 'aaaaaaaa-0002-0002-0002-000000000002';
const VACANCY_ID_1 = 'bbbbbbbb-0001-0001-0001-000000000001';

const MOCK_BLOCKED_ATTEMPTS = [
  {
    id: 'ba-0001',
    workerId: WORKER_ID_1,
    jobPostingId: VACANCY_ID_1,
    blockedReason: 'registration_incomplete',
    missingFields: ['profession', 'worker_documents'],
    attemptCount: 3,
    firstAttemptedAt: '2026-06-01T10:00:00Z',
    lastAttemptedAt: '2026-06-15T14:30:00Z',
    acquisitionChannel: 'whatsapp',
    createdAt: '2026-06-01T10:00:00Z',
    updatedAt: '2026-06-15T14:30:00Z',
  },
  {
    id: 'ba-0002',
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

const MOCK_AGGREGATES = {
  totalBlocked: 42,
  byReason: {
    registration_incomplete: 35,
    worker_disabled: 5,
    worker_not_found: 2,
  },
};

const MOCK_PAGINATION = {
  total: 2,
  limit: 20,
  offset: 0,
  page: 1,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
};

const MOCK_WORKER_1 = {
  id: WORKER_ID_1,
  firstName: 'María',
  lastName: 'González',
  status: 'INCOMPLETE_REGISTER',
  email: 'maria@test.com',
  phone: null,
  whatsappPhone: null,
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  dataSources: [],
  platform: 'self',
  overallStatus: null,
  availabilityStatus: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  sex: null,
  gender: null,
  birthDate: null,
  documentType: null,
  documentNumber: null,
  profilePhotoUrl: null,
  profession: null,
  occupation: null,
  knowledgeLevel: null,
  titleCertificate: null,
  experienceTypes: [],
  yearsExperience: null,
  preferredTypes: [],
  preferredAgeRange: [],
  languages: [],
  sexualOrientation: null,
  race: null,
  religion: null,
  weightKg: null,
  heightCm: null,
  hobbies: [],
  diagnosticPreferences: [],
  linkedinUrl: null,
  isMatchable: false,
  isActive: false,
  documents: null,
  serviceAreas: [],
  location: null,
  encuadres: [],
};

const MOCK_WORKER_2 = { ...MOCK_WORKER_1, id: WORKER_ID_2, firstName: 'Carlos', lastName: 'Ruiz' };

const MOCK_VACANCY_1 = {
  id: VACANCY_ID_1,
  title: 'CASO 766-1',
  status: 'OPEN',
  case_number: 766,
  vacancy_number: 1,
  patient_id: null,
  patient_first_name: null,
  patient_last_name: null,
  patient_diagnosis: null,
  patient_zone: 'CABA',
  patient_city: null,
  patient_neighborhood: null,
  patient_address_id: null,
  patient_address_formatted: null,
  patient_address_raw: null,
  required_sex: null,
  required_professions: ['AT'],
  age_range_min: null,
  age_range_max: null,
  required_experience: null,
  worker_attributes: null,
  service_type: ['AT'],
  dependency_level: 'SEVERE',
  schedule: null,
  schedule_days_hours: null,
  work_schedule: null,
  country: 'AR',
  city: null,
  providers_needed: 1,
  insurance_verified: null,
  salary_text: null,
  payment_day: null,
  daily_obs: null,
  published_at: null,
  closes_at: null,
  talentum_description: null,
  talentum_project_id: null,
  talentum_whatsapp_url: null,
  talentum_slug: null,
  talentum_published_at: null,
  is_draft: false,
  meet_link_1: null,
  meet_datetime_1: null,
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
  social_short_links: null,
  encuadres: [],
  publications: [],
  created_at: '2026-01-01T00:00:00Z',
  closed_at: null,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  // Login com a conta STAFF REAL (enlite-prd). Antes: `accounts:signUp` no emulador
  // + `docker exec enlite-postgres` para inserir o usuário — duas dependências de
  // infra que este spec não precisa ter (ele mocka todos os endpoints que assere) e
  // que o prendiam a um emulador e a um container de nome fixo, compartilhado entre
  // worktrees. Usuário do emulador também não carrega custom claim, e sem ela a
  // sessão cai na navegação de PRESTADOR.
  //
  // Catch-all primeiro: sem ele, chamadas não mockadas escapam para
  // VITE_API_WORKER_FUNCTIONS_URL e morrem em CORS (o backend só libera a origem
  // localhost:5173), derrubando a sessão admin em qualquer outra porta.
  await page.route('**/api/admin/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: null }),
    }),
  );

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: 'e2e-blocked-admin',
          email: E2E_EMAIL,
          role: 'admin',
          firstName: 'Blocked',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.route('**/api/admin/users*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );

  await loginAsAdmin(page);
}

function mockBlockedAPI(page: Page, attempts = MOCK_BLOCKED_ATTEMPTS): void {
  page.route('**/api/admin/recruitment/blocked-attempts**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: attempts,
        aggregates: MOCK_AGGREGATES,
        pagination: MOCK_PAGINATION,
      }),
    }),
  );

  // Resolve worker names
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

  // Resolve vacancy
  page.route(`**/api/admin/vacancies/${VACANCY_ID_1}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_VACANCY_1 }),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('BlockedAttemptsPage', () => {
  test.setTimeout(90000);

  test('página renderiza título e agrega totais', async ({ page }) => {
    await seedAdminAndLogin(page);
    mockBlockedAPI(page);

    await page.goto('/admin/recruitment/blocked-attempts');

    await expect(
      page.locator('[data-testid="blocked-content"]'),
    ).toBeVisible({ timeout: 20000 });

    // Title text (es-AR translation)
    await expect(
      page.locator('text=Intentos de postulación bloqueados').first(),
    ).toBeVisible({ timeout: 10000 });

    // Aggregate total
    await expect(page.getByTestId('agg-total')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('agg-total').getByText('42')).toBeVisible();
  });

  test('tabela exibe worker name, vacancy title e reason', async ({ page }) => {
    await seedAdminAndLogin(page);
    mockBlockedAPI(page);

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.locator('[data-testid="blocked-content"]')).toBeVisible({ timeout: 20000 });

    // Worker names (resolved via getWorkerById mock)
    await expect(page.locator('text=María González').first()).toBeVisible({ timeout: 15000 });

    // Vacancy title
    await expect(page.locator('text=CASO 766-1').first()).toBeVisible({ timeout: 10000 });

    // Translated reason (not raw enum)
    await expect(
      page.locator('text=Registro incompleto').first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test('estado vazio exibe mensagem correta', async ({ page }) => {
    await seedAdminAndLogin(page);

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

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.locator('[data-testid="blocked-content"]')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('blocked-empty')).toBeVisible({ timeout: 10000 });

    await expect(
      page.locator('text=No hay intentos de postulación bloqueados').first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test('filtro por motivo inclui reason no query param', async ({ page }) => {
    await seedAdminAndLogin(page);
    mockBlockedAPI(page);

    const capturedUrls: string[] = [];
    page.route('**/api/admin/recruitment/blocked-attempts**', (route) => {
      capturedUrls.push(route.request().url());
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: MOCK_BLOCKED_ATTEMPTS,
          aggregates: MOCK_AGGREGATES,
          pagination: MOCK_PAGINATION,
        }),
      });
    });

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.locator('[data-testid="blocked-content"]')).toBeVisible({ timeout: 20000 });

    // Select reason filter
    const select = page.locator('[data-testid="blocked-filters"] select').first();
    await select.selectOption('worker_disabled');

    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/recruitment/blocked-attempts') &&
        resp.url().includes('reason=worker_disabled'),
    );

    const filtered = capturedUrls.find((u) => u.includes('reason=worker_disabled'));
    expect(filtered).toBeDefined();
  });

  test('screenshot visual — estado POPULADO', async ({ page }) => {
    await seedAdminAndLogin(page);
    mockBlockedAPI(page);

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.locator('[data-testid="blocked-content"]')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('agg-total').getByText('42')).toBeVisible({ timeout: 10000 });

    // Wait for resolved names
    await expect(page.locator('text=María González').first()).toBeVisible({ timeout: 15000 });

    await expect(page).toHaveScreenshot('blocked-attempts-populated.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('screenshot visual — estado VAZIO', async ({ page }) => {
    await seedAdminAndLogin(page);

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

    await page.goto('/admin/recruitment/blocked-attempts');
    await expect(page.locator('[data-testid="blocked-content"]')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('blocked-empty')).toBeVisible({ timeout: 10000 });

    await expect(page).toHaveScreenshot('blocked-attempts-empty.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('link em AdminRecruitmentPage aponta para /blocked-attempts', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Mock recruitment dashboard data endpoints
    page.route('**/api/admin/recruitment/clickup-cases**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    page.route('**/api/admin/recruitment/talentum-workers**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    page.route('**/api/admin/recruitment/progreso**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    page.route('**/api/admin/recruitment/publications**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    page.route('**/api/admin/recruitment/encuadres**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
    page.route('**/api/admin/recruitment/global-metrics**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {} }),
      }),
    );

    await page.goto('/admin/recruitment');

    // Link "Ver intentos bloqueados" should exist
    const link = page.getByRole('link', { name: /intentos bloqueados/i });
    await expect(link).toBeVisible({ timeout: 15000 });
    expect(await link.getAttribute('href')).toContain('/admin/recruitment/blocked-attempts');
  });
});
