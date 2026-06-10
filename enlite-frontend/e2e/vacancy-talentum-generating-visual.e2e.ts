/**
 * vacancy-talentum-generating-visual.e2e.ts — Playwright E2E (VISUAL)
 *
 * Captura o estado de LOADING do VacancyTalentumCard ao gerar conteúdo com IA.
 *
 * Contexto: a geração via Vertex leva ~40s. O feedback antigo era só um spinner
 * de 16px no botão — operadores achavam que "no pasó nada" e recarregavam,
 * perdendo o preview. Este teste valida o feedback forte: skeleton + mensagem
 * "Generando… puede tardar hasta 1 minuto. No recargues."
 *
 * generate-ai-content é mockado com delay longo pra congelar o estado de loading.
 * Auth via Firebase Emulator (porta 9099), todas as APIs mockadas.
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const MOCK_VACANCY_ID = 'cccccccc-7860-7860-7860-cccccccccccc';

const MOCK_VACANCY = {
  id: MOCK_VACANCY_ID,
  case_number: 786,
  vacancy_number: 1368,
  title: 'Caso 786-1368 — Acompañante Terapéutico',
  status: 'SEARCHING',
  country: 'ARG',
  patient_first_name: 'Paciente',
  patient_last_name: 'Demo',
  patient_diagnosis: 'Autismo',
  patient_zone: 'Nuñez, CABA',
  patient_city: 'Buenos Aires',
  patient_neighborhood: 'Nuñez',
  dependency_level: 'MODERATE',
  required_sex: 'M',
  required_professions: ['AT'],
  service_type: ['AT'],
  worker_attributes: null,
  age_range_min: 25,
  age_range_max: null,
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
  created_at: '2026-05-01T00:00:00Z',
  closed_at: null,
  schedule: { saturday: [{ start: '14:30', end: '19:30' }], sunday: [{ start: '14:30', end: '19:30' }] },
};

async function loginAsAdmin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.talentum.gen.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as { localId?: string };
  if (!signUpData.localId) throw new Error(`Emulator sign-up failed: ${JSON.stringify(signUpData)}`);
  const uid = signUpData.localId;

  await page.route('**/identitytoolkit.googleapis.com/**', async (route) => {
    const parsed = new URL(route.request().url());
    const emulatorUrl = `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com${parsed.pathname}?${parsed.searchParams.toString().replace(/key=[^&]+/, `key=${FIREBASE_API_KEY}`)}`;
    try {
      const res = await fetch(emulatorUrl, {
        method: route.request().method(),
        headers: { 'Content-Type': 'application/json' },
        body: route.request().postData() ?? undefined,
      });
      await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
    } catch {
      await route.abort();
    }
  });

  await page.route('**/securetoken.googleapis.com/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: 'mock-access-token-e2e',
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'mock-refresh-token-e2e',
        id_token: 'mock-id-token-e2e',
        user_id: 'mock-uid-e2e',
        project_id: 'enlite-prd',
      }),
    }),
  );

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { id: uid, email, role: 'superadmin', firstName: 'Admin', lastName: 'QA', isActive: true, mustChangePassword: false },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 30_000 });
}

async function mockVacancyApis(page: Page): Promise<void> {
  const ok = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, (route) => route.fulfill(ok(MOCK_VACANCY)));
  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, (route) =>
    route.fulfill(ok({ questions: [], faq: [] })),
  );
  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/social-short-links`, (route) => route.fulfill(ok(null)));
  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/funnel-table**`, (route) =>
    route.fulfill(ok({ rows: [], counts: { INVITED: 0, POSTULATED: 0, PRE_SELECTED: 0, REJECTED: 0, WITHDREW: 0, ALL: 0 } })),
  );
  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/funnel`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { stages: {}, totalEncuadres: 0 } }) }),
  );
  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/match-results**`, (route) =>
    route.fulfill(ok({ jobPostingId: MOCK_VACANCY_ID, lastMatchAt: null, totalCandidates: 0, candidates: [] })),
  );

  // generate-ai-content: NÃO resolve durante o teste — congela o loading pra captura.
  await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/generate-ai-content`, async (route) => {
    await new Promise((r) => setTimeout(r, 60_000));
    await route.fulfill(ok({ description: 'x', prescreening: { questions: [], faq: [] } }));
  });
}

test.describe('VacancyTalentumCard — estado de geração com IA (visual)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test('mostra skeleton + aviso "no recargues" durante a geração', async ({ page }) => {
    await loginAsAdmin(page);
    await mockVacancyApis(page);

    await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}`);
    await expect(page.locator('text=786').first()).toBeVisible({ timeout: 15_000 });

    // Vai pra aba Talentum
    await page.getByRole('button', { name: 'Talentum', exact: true }).click();

    const card = page.getByTestId('talentum-card');
    await expect(card).toBeVisible({ timeout: 10_000 });

    // Clica "Regenerar descripción" → dispara o loading (request congelado)
    await card.getByRole('button', { name: /Regenerar descripción/i }).click();

    // Feedback forte visível: região status (skeleton) com "Generando…" + aviso
    const status = card.getByRole('status');
    await expect(status).toBeVisible({ timeout: 10_000 });
    await expect(status.getByText('Generando…')).toBeVisible();
    await expect(card.getByText(/No cierres ni recargues la página/i)).toBeVisible();

    await expect(card).toHaveScreenshot('talentum-generating-loading.png', {
      maxDiffPixelRatio: 0.03,
    });
  });
});
