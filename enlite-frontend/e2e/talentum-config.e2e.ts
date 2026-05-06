/**
 * talentum-config.e2e.ts — Playwright E2E
 *
 * Fase 4: TalentumConfigPage — revisar conteúdo gerado pela IA + prescreening + publicar.
 *
 * Cenários cobertos:
 *   (a) Page renderiza com summary card + GenerateAIButton (estado inicial)
 *   (b) Click em "Gerar com IA" → mostra loading → conteúdo aparece (description + perguntas)
 *   (c) Edita description → muda counter
 *   (d) Adiciona pergunta no PrescreeningStep
 *   (e) Click em "Publicar" → loading → navega para /admin/vacancies/:id
 *   (f) Erro de publish → mensagem inline vermelha
 *
 * Todas as chamadas à API são mockadas. Nenhum banco real.
 */

import { test, expect, type Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const MOCK_VACANCY_ID = 'vac-talentum-test-1';

// ── Mock data ────────────────────────────────────────────────────────────────

const MOCK_VACANCY = {
  id: MOCK_VACANCY_ID,
  case_number: 55,
  vacancy_number: 2,
  patient_first_name: 'Sofía',
  patient_last_name: 'Rodríguez',
  status: 'PENDING_ACTIVATION',
  talentum_published_at: null,
  closed_at: null,
  social_short_links: null,
};

const MOCK_AI_RESULT = {
  description: 'Se busca AT con experiencia en adultos mayores para acompañamiento domiciliario.',
  prescreening: {
    questions: [
      {
        question: '¿Tenés experiencia con adultos mayores?',
        responseType: ['text', 'audio'],
        desiredResponse: 'Sí, tengo experiencia',
        weight: 8,
        required: true,
        analyzed: true,
        earlyStoppage: false,
      },
    ],
    faq: [
      {
        question: '¿Cuántas horas son?',
        answer: '40 horas semanales',
      },
    ],
  },
};

const MOCK_PRESCREENING_SAVED = {
  questions: MOCK_AI_RESULT.prescreening.questions,
  faq: MOCK_AI_RESULT.prescreening.faq,
};

const MOCK_PUBLISH_RESULT = {
  projectId: 'proj-123',
  publicId: 'pub-abc',
  whatsappUrl: 'https://wa.me/5491100001111',
};

// ── Auth helper ───────────────────────────────────────────────────────────────

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.talentum.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as any;

  await page.route('**/api/admin/auth/profile', route =>
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
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Route mocks ───────────────────────────────────────────────────────────────

function mockGetVacancy(page: Page, vacancy = MOCK_VACANCY) {
  page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: vacancy }),
    }),
  );
}

function mockGenerateAIContent(page: Page, result = MOCK_AI_RESULT) {
  page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/generate-ai-content`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: result }),
    }),
  );
}

function mockSavePrescreening(page: Page) {
  page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/prescreening-config`, route => {
    if (route.request().method() === 'POST') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PRESCREENING_SAVED }),
      });
    } else {
      route.continue();
    }
  });
}

function mockPublishToTalentum(page: Page, shouldFail = false) {
  page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/publish-talentum`, route => {
    if (shouldFail) {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Error de conexión con Talentum' }),
      });
    } else {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_PUBLISH_RESULT }),
      });
    }
  });
}

function mockSocialLinksStats(page: Page) {
  page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/social-links-stats`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {} }),
    }),
  );
}

function mockVacancySocialLinks(page: Page) {
  page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}/social-links`, route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { channel: 'whatsapp', shortURL: '', social_short_links: {} } }),
    }),
  );
}

// ── Shared setup ──────────────────────────────────────────────────────────────

async function setupPage(page: Page, options: { publishFail?: boolean } = {}) {
  mockGetVacancy(page);
  mockGenerateAIContent(page);
  mockSavePrescreening(page);
  mockPublishToTalentum(page, options.publishFail ?? false);
  mockSocialLinksStats(page);
  mockVacancySocialLinks(page);
  await loginAsAdmin(page);
  await page.goto(`/admin/vacancies/${MOCK_VACANCY_ID}/talentum`);
  // Wait for vacancy summary to load
  await page.waitForSelector('text=CASO 55-2', { timeout: 10000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('TalentumConfigPage', () => {
  // (a) Initial render
  test('(a) renders summary card and generate AI button in idle state', async ({ page }) => {
    await setupPage(page);

    // Summary card shows vacancy title
    await expect(page.getByText('CASO 55-2')).toBeVisible();
    // Patient name
    await expect(page.getByText(/Sofía Rodríguez/)).toBeVisible();
    // Generate button visible
    await expect(page.getByRole('button', { name: /Generar contenido/i })).toBeVisible();
    // Publish button in header
    await expect(page.getByRole('button', { name: /Publicar en Talentum/i })).toBeVisible();

    await expect(page).toHaveScreenshot('talentum-config-initial.png');
  });

  // (b) Generate AI content
  test('(b) clicking generate AI shows loading then populates content', async ({ page }) => {
    await setupPage(page);

    const generateBtn = page.getByRole('button', { name: /Generar contenido/i });
    await generateBtn.click();

    // After generation the description textarea is populated
    await expect(page.getByRole('textbox')).toHaveValue(
      'Se busca AT con experiencia en adultos mayores para acompañamiento domiciliario.',
      { timeout: 8000 },
    );
    // Question from prescreening should appear
    await expect(page.getByText(/adultos mayores/)).toBeVisible();

    // Button becomes "Re-generar" outline variant
    await expect(page.getByRole('button', { name: /Re-generar/i })).toBeVisible();

    await expect(page).toHaveScreenshot('talentum-config-after-generate.png');
  });

  // (c) Edit description → counter updates
  test('(c) editing description updates character counter', async ({ page }) => {
    await setupPage(page);

    // Generate content first
    await page.getByRole('button', { name: /Generar contenido/i }).click();
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value.length > 0,
      { timeout: 8000 },
    );

    const textarea = page.getByRole('textbox');
    await textarea.fill('Texto editado manualmente.');

    // Counter should reflect new length
    const expectedCount = 'Texto editado manualmente.'.length;
    await expect(page.getByText(`${expectedCount}/4000`)).toBeVisible();

    await expect(page).toHaveScreenshot('talentum-config-edited-description.png');
  });

  // (d) Add question in PrescreeningStep
  test('(d) can add a new question in PrescreeningStep', async ({ page }) => {
    await setupPage(page);

    // Generate content to seed prescreening
    await page.getByRole('button', { name: /Generar contenido/i }).click();
    await page.waitForFunction(
      () => (document.querySelector('textarea') as HTMLTextAreaElement)?.value.length > 0,
      { timeout: 8000 },
    );

    // Click "Agregar pregunta" in PrescreeningStep
    await page.getByRole('button', { name: /Agregar pregunta/i }).click();

    // Should now show 2 questions
    const questionLabels = page.locator('text=/Pregunta \\d+/');
    await expect(questionLabels).toHaveCount(2, { timeout: 5000 });

    await expect(page).toHaveScreenshot('talentum-config-added-question.png');
  });

  // (e) Publish success → navigate to detail
  test('(e) publish navigates to vacancy detail on success', async ({ page }) => {
    await setupPage(page);

    // Mock updated vacancy with publishedAt
    const updatedVacancy = { ...MOCK_VACANCY, talentum_published_at: '2026-05-01T10:00:00Z' };
    // Re-mock for second fetch (post-publish)
    await page.route(`**/api/admin/vacancies/${MOCK_VACANCY_ID}`, route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: updatedVacancy }),
      }),
    );

    await page.getByRole('button', { name: /Publicar en Talentum/i }).click();

    // Should navigate to vacancy detail
    await expect(page).toHaveURL(`/admin/vacancies/${MOCK_VACANCY_ID}`, { timeout: 10000 });
  });

  // (f) Publish error → inline red message
  test('(f) publish error shows inline error message', async ({ page }) => {
    await setupPage(page, { publishFail: true });

    await page.getByRole('button', { name: /Publicar en Talentum/i }).click();

    // Error message appears near the publish button
    await expect(page.getByText(/Error de conexión con Talentum/i)).toBeVisible({ timeout: 8000 });

    await expect(page).toHaveScreenshot('talentum-config-publish-error.png');
  });
});
