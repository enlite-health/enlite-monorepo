/**
 * vacancy-funnel-dispatch.e2e.ts
 *
 * Playwright E2E — Botão único "Invitar prestadores" no VacancyFunnelView (089 T030)
 *
 * Substitui "Hacer match" e "Enviar invitaciones (N)". Backend mockado (só a entrada da vacante);
 * o fluxo de envio da página /match é do e2e integration `funil-vacante-invitar-prestadores-089`.
 *
 * Cenários cobertos:
 *   1. Contador 0: botão visível, sem bolinha e sem a 1ª linha; a 2ª linha fica
 *   2. Contador 3: bolinha "3" + "3 personas de esta vacante todavía no recibieron el WhatsApp"
 *   3. Clique navega para /admin/vacancies/:id/match
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
  publications: [],
  social_short_links: null,
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
  pendingInVacancyCount = 0,
): Promise<void> {
  // 054: o padrão da tela agora é Kanban, mas estes cenários mockam só `funnel-table` (Lista).
  // Fixa a Lista na chave v2 para o cenário mockado continuar coerente.
  await page.addInitScript(
    ([key]) => window.localStorage.setItem(key, 'list'),
    [`vacancy-funnel-view-v2-${VACANCY_ID}`],
  );
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
          data: { stages: { INVITED: [], INTERVIEWING: [], SELECTED: [], REJECTED: [], PENDING: [] }, totalEncuadres: 0 },
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
          data: { jobPostingId: VACANCY_ID, lastMatchAt: null, totalCandidates: 0, pendingInVacancyCount, candidates: [] },
        }),
      }),
  );
}

// ── Testes ────────────────────────────────────────────────────────────────────

test.describe('VacancyFunnelView — botão único Invitar prestadores (089 T030)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test('D1 — contador 0: botão visível, sem bolinha e sem a 1ª linha; a 2ª linha fica', async ({ page }) => {
    await loginAsAdmin(page);
    await mockBaseApis(page, ROWS_ALL_SENT, 0);

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await expect(page.locator('text=429').first()).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('button', { name: /Invitar prestadores/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Hacer match|Enviar invitaciones/i })).toHaveCount(0);
    await expect(page.getByTestId('invite-entry-count')).toHaveCount(0);
    await expect(page.getByTestId('invite-entry-pending-line')).toHaveCount(0);
    await expect(page.getByText(/Opcional · También podés buscar prestadores cerca del servicio/)).toBeVisible();
  });

  test('D2 — contador 3: bolinha 3 e a 1ª linha', async ({ page }) => {
    await loginAsAdmin(page);
    await mockBaseApis(page, ROWS_WITH_PENDING, 3);

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await expect(page.locator('text=429').first()).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('invite-entry-count')).toHaveText('3', { timeout: 10_000 });
    await expect(page.getByTestId('invite-entry-pending-line')).toHaveText(
      '3 personas de esta vacante todavía no recibieron el WhatsApp',
    );
  });

  test('D3 — clique navega para a página de match da vacante', async ({ page }) => {
    await loginAsAdmin(page);
    await mockBaseApis(page, ROWS_WITH_PENDING, 3);

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await expect(page.locator('text=429').first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: /Invitar prestadores/i }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${VACANCY_ID}/match$`), { timeout: 10_000 });
  });
});
