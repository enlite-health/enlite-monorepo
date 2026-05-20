/**
 * i18n-vacancy-match-visual.e2e.ts
 *
 * Visual proof that the VacancyMatch feature (InviteProgressModal,
 * ScheduleInterviewModal) renders correctly in both es-AR and pt-BR
 * with zero raw i18n keys leaking to the DOM.
 *
 * Background: TD-016 (resolved 2026-05-19) refactored 7 hardcoded files
 * into useTranslation()/t(). This test guards against regressions where
 * a future change reintroduces hardcoded strings or breaks a key path.
 *
 * Approach:
 *   - Login as admin via Firebase Emulator + seed
 *   - Mock all API responses (vacancy, candidates, vacancy-match invite, slots)
 *   - For each language (es, pt-BR): open InviteProgressModal and
 *     ScheduleInterviewModal, screenshot, assert no `admin.<ns>.` text
 *     appears in DOM
 *   - Screenshots saved to e2e/screenshots/i18n-* for manual inspection
 *
 * Pre-conditions: same as vacancy-match.e2e.ts — Firebase Emulator
 * + Postgres docker (`enlite-postgres`) running. See CLAUDE.md.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const VACANCY_ID = 'cccccccc-0003-0003-0003-cccccccccccc';

const MOCK_VACANCY = {
  id: VACANCY_ID,
  case_number: 33001,
  title: 'Caso 33001 — i18n visual proof',
  status: 'BUSQUEDA',
  patient_zone: 'Palermo',
  required_professions: ['AT'],
  meet_link_1: 'https://meet.google.com/abc-defg-hij',
};

const MOCK_CANDIDATES = [
  {
    workerId: 'worker-i18n-001',
    workerName: 'Sofía Martínez',
    workerPhone: '+5491100000091',
    occupation: 'Acompañante Terapéutico',
    workZone: 'Palermo',
    distanceKm: 1.8,
    activeCasesCount: 0,
    overallStatus: 'QUALIFICADO',
    matchScore: 92,
    internalNotes: null,
    applicationStatus: 'under_review',
    alreadyApplied: false,
    messagedAt: null,
  },
  {
    workerId: 'worker-i18n-002',
    workerName: 'Diego López',
    workerPhone: '+5491100000092',
    occupation: 'AT',
    workZone: 'Belgrano',
    distanceKm: 3.5,
    activeCasesCount: 1,
    overallStatus: 'QUALIFICADO',
    matchScore: 78,
    internalNotes: null,
    applicationStatus: 'under_review',
    alreadyApplied: false,
    messagedAt: '2026-05-15T10:00:00Z',
  },
];

const POPULATED_MATCH_RESULTS = {
  success: true,
  data: {
    jobPostingId: VACANCY_ID,
    lastMatchAt: '2026-05-18T12:00:00Z',
    totalCandidates: 2,
    candidates: MOCK_CANDIDATES,
  },
};

/** Resposta do endpoint POST /vacancy-match */
const VACANCY_MATCH_INVITE_SUCCESS = {
  success: true,
  data: {
    templateSlug: 'ar_vacancy_match_complete',
    externalId: 'SM999',
    status: 'queued',
    to: '+5491100000091',
  },
};

const EMPTY_SLOTS = {
  success: true,
  data: [],
};

// ── Helpers ────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const email = `e2e.i18n.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as { localId: string };

  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at) VALUES ('${uid}', '${email}', 'Admin E2E i18n', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at) VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();
  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch { /* ignora */ }

  await page.route('**/api/admin/auth/profile', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid, email, role: 'superadmin',
          firstName: 'Admin', lastName: 'i18n',
          isActive: true, mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

async function setupMocks(page: Page) {
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_VACANCY }),
    }),
  );
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/match-results**`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(POPULATED_MATCH_RESULTS),
    }),
  );
  await page.route('**/api/admin/messaging/whatsapp/vacancy-match', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(VACANCY_MATCH_INVITE_SUCCESS),
    }),
  );
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/interview-slots**`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(EMPTY_SLOTS),
    }),
  );
}

/**
 * Reads all visible text on the page and asserts no raw i18n key from the
 * namespaces we refactored leaks to the DOM. A failure means a t() call is
 * pointing at a missing key OR a value is being rendered raw bypassing i18n.
 */
async function assertNoRawI18nKeys(page: Page) {
  const bodyText = await page.locator('body').innerText();
  const matches = bodyText.match(/admin\.(match|messaging|interviews)\.[a-zA-Z][a-zA-Z0-9_.]*/g);
  expect(
    matches,
    `Raw i18n keys leaked to DOM: ${matches?.join(', ')}`,
  ).toBeNull();
  expect(bodyText).not.toMatch(/admin\.(match|messaging|interviews)\./);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('VacancyMatch i18n visual proof', () => {
  test.setTimeout(60000);

  for (const lang of ['es', 'pt-BR'] as const) {
    test(`${lang}: InviteProgressModal renderiza sem chaves i18n cruas`, async ({ page }) => {
      await seedAdminAndLogin(page);
      await setupMocks(page);

      await page.goto(`/admin/vacancies/${VACANCY_ID}/match?lng=${lang}`);
      await expect(page.locator('text=Sofía Martínez').first()).toBeVisible({ timeout: 15000 });

      // Abre InviteProgressModal via ícone WhatsApp de Sofía (sem messagedAt)
      const sofiaRow = page.locator('tr', { hasText: 'Sofía Martínez' }).first();
      await sofiaRow.getByRole('button').first().click();

      // Modal abre e dispara envio automaticamente (sem dropdown de template)
      await expect(page.locator('text=/Enviar invitaci[oó]n|Enviar convite/i').first()).toBeVisible({ timeout: 10000 });

      // Aguarda status de progresso aparecer
      await expect(page.locator('text=/enviado|enviando/i').first()).toBeVisible({ timeout: 10000 });

      await page.screenshot({
        path: `e2e/screenshots/i18n-invite-progress-${lang}.png`,
        fullPage: true,
      });

      await assertNoRawI18nKeys(page);
    });

    test(`${lang}: ScheduleInterviewModal renderiza sem chaves i18n cruas`, async ({ page }) => {
      await seedAdminAndLogin(page);
      await setupMocks(page);

      await page.goto(`/admin/vacancies/${VACANCY_ID}/match?lng=${lang}`);
      await expect(page.locator('text=Sofía Martínez').first()).toBeVisible({ timeout: 15000 });

      // Seleciona um candidato para o botão "Agendar" aparecer
      const sofiaRow = page.locator('tr', { hasText: 'Sofía Martínez' }).first();
      await sofiaRow.locator('input[type="checkbox"]').check();

      // Abre ScheduleInterviewModal
      await page.getByRole('button', { name: /Agendar/i }).click();

      // Aguarda Phase 1 form
      await expect(page.locator('text=/Configurar slots/i').first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator('text=/Fecha de entrevistas|Data das entrevistas/i').first()).toBeVisible();

      await page.screenshot({
        path: `e2e/screenshots/i18n-schedule-interview-phase1-${lang}.png`,
        fullPage: true,
      });

      await assertNoRawI18nKeys(page);
    });
  }
});
