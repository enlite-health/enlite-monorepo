/**
 * document-validation-modal-visual.e2e.ts
 *
 * Playwright E2E — Testes visuais (screenshot assertions) para a
 * ConfirmValidationModal aberta pelo DocumentValidationBadge.
 *
 * Cobre:
 *   1. Abertura da modal ao clicar em "Validar"
 *   2. Conteúdo da modal (título + texto de aviso)
 *   3. Cancelar fecha a modal (modal ausente no DOM)
 *   4. Fechar via tecla Escape
 *   5. Fechar via clique no overlay
 *   6. Estado de loading no botão confirmar
 */

import { test, expect, Page } from '@playwright/test';

// ── Constants ──────────────────────────────────────────────────────────────────

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const WORKER_ID = 'worker-modal-visual-001';

// ── Mock data factories ────────────────────────────────────────────────────────

function makeWorker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WORKER_ID,
    email: 'modal.visual@test.com',
    phone: '+5491155550088',
    whatsappPhone: '+5491155550088',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    status: 'REGISTERED',
    overallStatus: 'QUALIFIED',
    availabilityStatus: 'available',
    dataSources: ['talentum'],
    platform: 'talentum',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    firstName: 'Carlos',
    lastName: 'García',
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
    isMatchable: true,
    isActive: true,
    serviceAreas: [],
    location: null,
    encuadres: [],
    availability: [],
    documents: null,
    ...overrides,
  };
}

// ── Document fixtures ──────────────────────────────────────────────────────────

/** CV enviado, sem validação → mostra botão "Validar" que abre a modal */
const DOCS_CV_UPLOADED_NOT_VALIDATED: Record<string, unknown> = {
  id: 'doc-modal-visual-001',
  resumeCvUrl: 'workers/modal-visual/cv.pdf',
  identityDocumentUrl: null,
  identityDocumentBackUrl: null,
  criminalRecordUrl: null,
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  additionalCertificatesUrls: [],
  documentsStatus: 'incomplete',
  reviewNotes: null,
  reviewedBy: null,
  reviewedAt: null,
  submittedAt: '2026-03-10T00:00:00Z',
  documentValidations: {},
};

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.modal.validation.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as Record<string, unknown>;
  if (!signUpData.localId) {
    throw new Error(`Firebase sign-up failed: ${JSON.stringify(signUpData)}`);
  }
  const uid = signUpData.localId as string;

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
          firstName: 'Modal',
          lastName: 'Tester',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.route('**/api/admin/workers/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { today: 0, yesterday: 0, sevenDaysAgo: 0 } }),
    }),
  );

  await page.route('**/api/admin/workers/case-options', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );

  await page.goto('/login?next=%2Fadmin');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

async function mockWorkerApis(
  page: Page,
  workerOverrides: Record<string, unknown>,
): Promise<void> {
  const workerBody = JSON.stringify({
    success: true,
    data: makeWorker(workerOverrides),
  });

  await page.route(`**/api/admin/workers/${WORKER_ID}`, (route) => {
    if (route.request().url().includes('/documents')) {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: workerBody,
    });
  });

  await page.route(`**/api/admin/workers/${WORKER_ID}/additional-documents`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
}

async function navigateToDocumentsTab(page: Page): Promise<void> {
  await page.goto(`/admin/workers/${WORKER_ID}`);
  await expect(
    page.locator('[data-testid="worker-documents-card"]'),
  ).toBeVisible({ timeout: 20_000 });
}

async function openModal(page: Page): Promise<void> {
  const validateBtn = page.locator('[data-testid="validate-btn-resume_cv"]');
  await expect(validateBtn).toBeVisible({ timeout: 10_000 });
  await validateBtn.click();
  await expect(page.locator('[data-testid="confirm-validation-modal"]')).toBeVisible({
    timeout: 5_000,
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('ConfirmValidationModal — Visual', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── 1. Clicar em "Validar" abre a modal ─────────────────────────────────────

  test('modal: abertura ao clicar em Validar', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_CV_UPLOADED_NOT_VALIDATED });
    await navigateToDocumentsTab(page);

    const validateBtn = page.locator('[data-testid="validate-btn-resume_cv"]');
    await expect(validateBtn).toBeVisible();

    // Modal não existe antes de clicar
    await expect(page.locator('[data-testid="confirm-validation-modal"]')).toHaveCount(0);

    await validateBtn.click();

    const modal = page.locator('[data-testid="confirm-validation-modal"]');
    await expect(modal).toBeVisible({ timeout: 5_000 });

    await expect(page).toHaveScreenshot('modal-open.png');
  });

  // ── 2. Conteúdo da modal — título e texto de aviso visíveis ─────────────────

  test('modal: conteúdo — título e texto de aviso visíveis', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_CV_UPLOADED_NOT_VALIDATED });
    await navigateToDocumentsTab(page);
    await openModal(page);

    const modal = page.locator('[data-testid="confirm-validation-modal"]');

    // Título "Validar documento"
    const title = modal.locator('#confirm-validation-title');
    await expect(title).toBeVisible();
    await expect(title).toContainText('Validar documento');

    // Texto de aviso com garantia de idoneidade
    const body = modal.locator('p');
    await expect(body).toBeVisible();
    await expect(body).toContainText('garantizás la idoneidad');

    // Botões presentes
    await expect(modal.locator('[data-testid="cancel-validation-btn"]')).toBeVisible();
    await expect(modal.locator('[data-testid="confirm-validation-btn"]')).toBeVisible();

    // O botão confirmar não deve estar desabilitado no estado inicial
    await expect(modal.locator('[data-testid="confirm-validation-btn"]')).not.toBeDisabled();

    await expect(modal).toHaveScreenshot('modal-content.png');
  });

  // ── 3. Cancelar fecha a modal ───────────────────────────────────────────────

  test('modal: cancelar fecha a modal e retorna ao estado base', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_CV_UPLOADED_NOT_VALIDATED });
    await navigateToDocumentsTab(page);
    await openModal(page);

    const modal = page.locator('[data-testid="confirm-validation-modal"]');
    await expect(modal).toBeVisible();

    await modal.locator('[data-testid="cancel-validation-btn"]').click();

    // Modal não deve mais existir no DOM
    await expect(page.locator('[data-testid="confirm-validation-modal"]')).toHaveCount(0);

    // Botão "Validar" deve continuar visível (estado base restaurado)
    await expect(page.locator('[data-testid="validate-btn-resume_cv"]')).toBeVisible();

    await expect(page).toHaveScreenshot('modal-cancelled.png');
  });

  // ── 4. Fechar via Escape ────────────────────────────────────────────────────

  test('modal: pressionar Escape fecha a modal', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_CV_UPLOADED_NOT_VALIDATED });
    await navigateToDocumentsTab(page);
    await openModal(page);

    await expect(page.locator('[data-testid="confirm-validation-modal"]')).toBeVisible();

    await page.keyboard.press('Escape');

    // Modal fechada após Escape
    await expect(page.locator('[data-testid="confirm-validation-modal"]')).toHaveCount(0);

    // Botão "Validar" restaurado
    await expect(page.locator('[data-testid="validate-btn-resume_cv"]')).toBeVisible();

    await expect(page).toHaveScreenshot('modal-escaped.png');
  });

  // ── 5. Fechar via clique no overlay ────────────────────────────────────────

  test('modal: clicar no overlay fecha a modal', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_CV_UPLOADED_NOT_VALIDATED });
    await navigateToDocumentsTab(page);
    await openModal(page);

    const overlay = page.locator('[data-testid="confirm-validation-modal"]');
    await expect(overlay).toBeVisible();

    // Clica no canto inferior direito do overlay (longe do sidebar e do card branco)
    // O overlay é fixed inset-0, z-50; o sidebar fica à esquerda com z-40 (coberto pela modal)
    // Usamos force:true pois o overlay cobre o sidebar
    await overlay.click({ position: { x: 1400, y: 800 }, force: true });

    await expect(page.locator('[data-testid="confirm-validation-modal"]')).toHaveCount(0);

    await expect(page).toHaveScreenshot('modal-overlay-close.png');
  });

  // ── 6. Estado de loading no botão confirmar ─────────────────────────────────

  test('modal: estado de loading — botão confirmar fica disabled com spinner', async ({
    page,
  }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_CV_UPLOADED_NOT_VALIDATED });

    // Intercepta a chamada de validação e deixa pendente para capturar o loading
    let resolveValidation!: () => void;
    const validationPending = new Promise<void>((resolve) => {
      resolveValidation = resolve;
    });

    await page.route(
      `**/api/admin/workers/${WORKER_ID}/documents/resume_cv/validate`,
      async (route) => {
        await validationPending;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      },
    );

    await navigateToDocumentsTab(page);
    await openModal(page);

    const confirmBtn = page.locator('[data-testid="confirm-validation-btn"]');
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).not.toBeDisabled();

    // Clica no confirmar sem await — a requisição fica pendente, botão entra em loading
    void confirmBtn.click();

    // Aguarda o botão ficar desabilitado (loading state ativado)
    await expect(confirmBtn).toBeDisabled({ timeout: 5_000 });

    // Captura o estado de loading: modal visível com botão disabled + spinner
    await expect(page.locator('[data-testid="confirm-validation-modal"]')).toHaveScreenshot(
      'modal-loading.png',
    );

    // Libera a requisição para não deixar o teste suspenso
    resolveValidation();
  });
});
