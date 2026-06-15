/**
 * vacancy-funnel-dispatch.e2e.ts
 *
 * Playwright E2E — Botão "Enviar invitaciones" no VacancyFunnelView
 *
 * Cenários cobertos:
 *   1. Botão disabled quando não há candidatos NOT_SENT (0 pendentes)
 *   2. Botão enabled com label "(3)" quando há 3 candidatos NOT_SENT
 *   3. Clique abre DispatchConfirmModal
 *   4. Confirmar abre InviteProgressModal e dispara o envio
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const FRONTEND_API_KEY =
  process.env.VITE_FIREBASE_API_KEY || 'AIzaSyByRp-NCY0m12iEoKyuIrV6vR49MZateXI';

const VACANCY_ID = 'dddddddd-0004-0004-0004-dddddddddddd';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 429,
  vacancy_number: 931,
  title: 'Caso 429-931 — AT',
  status: 'ACTIVO',
  country: 'ARG',
  patient_first_name: 'Paciente',
  patient_last_name: 'Dispatch E2E',
  patient_diagnosis: null,
  patient_zone: 'Palermo',
  patient_city: 'Buenos Aires',
  patient_neighborhood: 'Palermo',
  dependency_level: null,
  required_sex: null,
  required_professions: ['AT'],
  service_type: [],
  worker_attributes: null,
  age_range_min: null,
  age_range_max: null,
  payment_term_days: null,
  net_hourly_rate: null,
  weekly_hours: null,
  providers_needed: 1,
  talentum_project_id: null,
  talentum_description: null,
  talentum_whatsapp_url: null,
  talentum_slug: null,
  talentum_published_at: null,
  insurance_verified: false,
  publications: [],
  social_short_links: null,
  meet_link_1: null,
  meet_datetime_1: null,
  meet_link_2: null,
  meet_datetime_2: null,
  meet_link_3: null,
  meet_datetime_3: null,
  created_at: '2026-01-01T00:00:00Z',
  closed_at: null,
  schedule: {},
};

function makeRow(
  id: string,
  workerId: string,
  workerName: string,
  whatsappStatus: string,
  whatsappLastDispatchedAt: string | null = null,
) {
  return {
    id,
    workerId,
    workerName,
    workerEmail: null,
    workerPhone: null,
    workerAvatarUrl: null,
    invitedAt: '2026-04-10T10:00:00Z',
    funnelStage: 'INVITED',
    whatsappStatus,
    whatsappLastDispatchedAt,
    accepted: null,
    interviewResponse: null,
    registrationComplete: true,
    contactNotesCount: 0,
  };
}

const ROWS_ALL_SENT = [
  makeRow('r1', 'w1', 'Ana García', 'SENT', '2026-04-01T10:00:00Z'),
  makeRow('r2', 'w2', 'Bruno López', 'DELIVERED', '2026-04-01T10:01:00Z'),
];

const ROWS_WITH_PENDING = [
  makeRow('r1', 'w1', 'Ana García', 'NOT_SENT'),
  makeRow('r2', 'w2', 'Bruno López', 'NOT_SENT'),
  makeRow('r3', 'w3', 'Carla Méndez', 'NOT_SENT'),
  makeRow('r4', 'w4', 'Diego Sosa', 'SENT', '2026-04-01T10:00:00Z'),
];

const BASE_COUNTS = {
  INVITED: 4,
  POSTULATED: 0,
  PRE_SELECTED: 0,
  REJECTED: 0,
  WITHDREW: 0,
  ALL: 4,
};

const WHATSAPP_INVITE_SUCCESS = {
  success: true,
  data: {
    templateSlug: 'ar_vacancy_match_complete',
    externalId: 'SM999',
    status: 'queued',
    to: '+5491100000001',
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.dispatch.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as {
    localId?: string;
    idToken?: string;
    error?: { message: string };
  };
  if (!signUpData.localId) {
    throw new Error(
      `Firebase Emulator sign-up failed: ${JSON.stringify(signUpData)}`,
    );
  }
  const uid = signUpData.localId;

  await page.route('**/identitytoolkit.googleapis.com/**', async (route) => {
    const originalUrl = route.request().url();
    const parsed = new URL(originalUrl);
    const emulatorUrl = `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com${parsed.pathname}?${parsed.searchParams.toString().replace(/key=[^&]+/, `key=${FIREBASE_API_KEY}`)}`;
    try {
      const res = await fetch(emulatorUrl, {
        method: route.request().method(),
        headers: { 'Content-Type': 'application/json' },
        body: route.request().postData() ?? undefined,
      });
      const body = await res.text();
      await route.fulfill({ status: res.status, contentType: 'application/json', body });
    } catch {
      await route.abort();
    }
  });

  await page.route('**/securetoken.googleapis.com/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'mock-access-token-e2e',
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'mock-refresh-token-e2e',
        id_token: 'mock-id-token-e2e',
        user_id: uid,
        project_id: 'enlite-prd',
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
          id: uid,
          email,
          role: 'superadmin',
          firstName: 'Admin',
          lastName: 'Dispatch',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 30_000 });
}

async function mockBaseApis(
  page: Page,
  funnelRows: ReturnType<typeof makeRow>[],
): Promise<void> {
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
    }),
  );

  await page.route(
    `**/api/admin/vacancies/${VACANCY_ID}/funnel-table**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { rows: funnelRows, counts: BASE_COUNTS },
        }),
      }),
  );

  await page.route(
    `**/api/admin/vacancies/${VACANCY_ID}/funnel`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { stages: { INVITED: [], CONFIRMED: [], INTERVIEWING: [], SELECTED: [], REJECTED: [], PENDING: [] }, totalEncuadres: 0 },
        }),
      }),
  );

  await page.route(
    `**/api/admin/vacancies/${VACANCY_ID}/prescreening-config`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { questions: [], faq: [] } }),
      }),
  );

  await page.route(
    `**/api/admin/vacancies/${VACANCY_ID}/social-short-links`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      }),
  );

  await page.route(
    `**/api/admin/vacancies/${VACANCY_ID}/match-results**`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { jobPostingId: VACANCY_ID, lastMatchAt: null, totalCandidates: 0, candidates: [] },
        }),
      }),
  );
}

// ── Testes ────────────────────────────────────────────────────────────────────

test.describe('VacancyFunnelView — Dispatch Invites Button', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test('D1 — botão disabled quando 0 candidatos NOT_SENT', async ({ page }) => {
    await loginAsAdmin(page);
    await mockBaseApis(page, ROWS_ALL_SENT);

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await expect(page.locator('text=429').first()).toBeVisible({ timeout: 15_000 });

    const btn = page.getByRole('button', { name: /Enviar invitaciones/i });
    await expect(btn).toBeVisible();
    await expect(btn).toBeDisabled();

    await expect(page).toHaveScreenshot('dispatch-button-disabled.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('D2 — botão enabled com "(3)" quando há 3 candidatos NOT_SENT', async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await mockBaseApis(page, ROWS_WITH_PENDING);

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await expect(page.locator('text=429').first()).toBeVisible({ timeout: 15_000 });

    const btn = page.getByRole('button', { name: /Enviar invitaciones \(3\)/i });
    await expect(btn).toBeVisible();
    await expect(btn).toBeEnabled();

    await expect(page).toHaveScreenshot('dispatch-button-enabled.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('D3 — clique abre DispatchConfirmModal', async ({ page }) => {
    await loginAsAdmin(page);
    await mockBaseApis(page, ROWS_WITH_PENDING);

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await expect(page.locator('text=429').first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Enviar invitaciones \(3\)/i }).click();

    await expect(
      page.getByRole('heading', { name: /Confirmar envío/i }),
    ).toBeVisible({ timeout: 5_000 });

    await expect(page).toHaveScreenshot('dispatch-confirm-modal.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('D4 — confirmar abre InviteProgressModal', async ({ page }) => {
    await loginAsAdmin(page);
    await mockBaseApis(page, ROWS_WITH_PENDING);

    await page.route('**/api/admin/messaging/whatsapp/vacancy-match', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(WHATSAPP_INVITE_SUCCESS),
      }),
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await expect(page.locator('text=429').first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Enviar invitaciones \(3\)/i }).click();
    await expect(
      page.getByRole('heading', { name: /Confirmar envío/i }),
    ).toBeVisible({ timeout: 5_000 });

    await page.getByRole('button', { name: /^Enviar$/ }).click();

    // Título atual do InviteProgressModal é admin.messaging.title ("Enviar invitación")
    await expect(
      page.getByRole('heading', { name: /Enviar invitación/i }),
    ).toBeVisible({ timeout: 5_000 });

    await expect(page).toHaveScreenshot('dispatch-progress-modal.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
