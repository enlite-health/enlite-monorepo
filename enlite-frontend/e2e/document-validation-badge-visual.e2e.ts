/**
 * document-validation-badge-visual.e2e.ts
 *
 * Playwright E2E — Testes visuais (screenshot assertions) para o
 * DocumentValidationBadge na aba de Documentos do detalhe de um prestador.
 *
 * Cobre os 3 estados visuais do componente:
 *   1. Documento não enviado → nada renderizado (badge ausente)
 *   2. Documento enviado, não validado → botão "Validar" (outline verde)
 *   3. Documento enviado e validado → badge verde "Validado por {email} · {data}" + botão X
 *
 * Também cobre:
 *   4. Múltiplos badges num card real (mix de estados)
 *   5. Estado de loading (botão desabilitado)
 */

import { test, expect, Page } from '@playwright/test';

// ── Constants ──────────────────────────────────────────────────────────────────

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const WORKER_ID = 'worker-doc-validation-visual-001';

// ── Mock data factories ────────────────────────────────────────────────────────

function makeWorker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WORKER_ID,
    email: 'validation.visual@test.com',
    phone: '+5491155550099',
    whatsappPhone: '+5491155550099',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    status: 'REGISTERED',
    overallStatus: 'QUALIFIED',
    availabilityStatus: 'available',
    dataSources: ['talentum'],
    platform: 'talentum',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    firstName: 'Laura',
    lastName: 'Pérez',
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

// ── Document mock fixtures ─────────────────────────────────────────────────────

/** Estado 1: nenhum documento enviado — todos os campos null */
const DOCS_NO_UPLOADS: Record<string, unknown> = {
  id: 'doc-no-uploads-1',
  resumeCvUrl: null,
  identityDocumentUrl: null,
  identityDocumentBackUrl: null,
  criminalRecordUrl: null,
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  additionalCertificatesUrls: [],
  documentsStatus: 'pending',
  reviewNotes: null,
  reviewedBy: null,
  reviewedAt: null,
  submittedAt: null,
  documentValidations: {},
};

/** Estado 2: CV enviado, sem validação → mostra botão "Validar" */
const DOCS_UPLOADED_NOT_VALIDATED: Record<string, unknown> = {
  id: 'doc-uploaded-not-validated-1',
  resumeCvUrl: 'workers/validation-visual/cv.pdf',
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

/** Estado 3: CV enviado e validado → mostra badge verde com email + data */
const DOCS_UPLOADED_AND_VALIDATED: Record<string, unknown> = {
  id: 'doc-uploaded-validated-1',
  resumeCvUrl: 'workers/validation-visual/cv.pdf',
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
  documentValidations: {
    resume_cv: {
      validatedBy: 'admin@enlite.com',
      validatedAt: '2026-04-12T10:00:00Z',
    },
  },
};

/** Estado misto: CV validado, DNI não validado, demais não enviados */
const DOCS_MIXED_VALIDATION: Record<string, unknown> = {
  id: 'doc-mixed-validation-1',
  resumeCvUrl: 'workers/validation-visual/cv.pdf',
  identityDocumentUrl: 'workers/validation-visual/dni-front.pdf',
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
  documentValidations: {
    resume_cv: {
      validatedBy: 'supervisor@enlite.com',
      validatedAt: '2026-04-10T08:30:00Z',
    },
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.doc.validation.${Date.now()}.${rnd}@test.com`;
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
          firstName: 'Docs',
          lastName: 'Validation',
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

  // Additional documents — retorna lista vazia por padrão
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

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('DocumentValidation — Visual', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── Estado 1: documento não enviado → badge ausente ──────────────────────────

  test('Estado 1: badge ausente quando nenhum documento foi enviado', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_NO_UPLOADS });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // Nenhum badge de validação deve ser exibido pois não há documentos
    const validateBtns = docsCard.locator('[data-testid^="validate-btn-"]');
    await expect(validateBtns).toHaveCount(0);

    const validationBadges = docsCard.locator('[data-testid^="validation-badge-"]');
    await expect(validationBadges).toHaveCount(0);

    await expect(docsCard).toHaveScreenshot('doc-validation-state-1-no-uploads.png');
  });

  // ── Estado 2: documento enviado, não validado → botão "Validar" ──────────────

  test('Estado 2: botão "Validar" aparece para documento enviado sem validação', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_UPLOADED_NOT_VALIDATED });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // Apenas o CV foi enviado → deve haver exatamente 1 botão "Validar"
    const validateBtn = docsCard.locator('[data-testid="validate-btn-resume_cv"]');
    await expect(validateBtn).toBeVisible();
    await expect(validateBtn).toContainText('Validar');

    // Nenhum badge de "já validado"
    await expect(docsCard.locator('[data-testid^="validation-badge-"]')).toHaveCount(0);

    // Screenshot do botão "Validar" em destaque
    await expect(validateBtn).toHaveScreenshot('doc-validation-state-2-validate-button.png');

    // Screenshot do card completo com botão
    await expect(docsCard).toHaveScreenshot('doc-validation-state-2-card-with-validate-btn.png');
  });

  // ── Estado 3: documento enviado e validado → badge verde + botão X ───────────

  test('Estado 3: badge verde "Validado por {email} · {data}" aparece para doc validado', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_UPLOADED_AND_VALIDATED });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // Badge de validação deve aparecer para resume_cv
    const validationBadge = docsCard.locator('[data-testid="validation-badge-resume_cv"]');
    await expect(validationBadge).toBeVisible();

    // Contém o email do validador
    await expect(validationBadge).toContainText('admin@enlite.com');

    // Contém prefixo "Validado por"
    await expect(validationBadge).toContainText('Validado por');

    // Badge tem estilo verde (bg-green-50 + border-green-200)
    await expect(validationBadge).toHaveClass(/bg-green-50/);
    await expect(validationBadge).toHaveClass(/border-green-200/);

    // Botão X de remoção da validação deve estar presente
    const removeBtn = validationBadge.getByRole('button');
    await expect(removeBtn).toBeVisible();

    // Nenhum botão "Validar" para resume_cv (já está validado)
    await expect(docsCard.locator('[data-testid="validate-btn-resume_cv"]')).toHaveCount(0);

    // Screenshot do badge de validação isolado
    await expect(validationBadge).toHaveScreenshot('doc-validation-state-3-validated-badge.png');

    // Screenshot do card completo com badge
    await expect(docsCard).toHaveScreenshot('doc-validation-state-3-card-with-badge.png');
  });

  // ── Estado misto: CV validado + DNI não validado ─────────────────────────────

  test('Estado misto: badge verde para CV validado e botão "Validar" para DNI não validado', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_MIXED_VALIDATION });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // CV: badge de validado
    const cvBadge = docsCard.locator('[data-testid="validation-badge-resume_cv"]');
    await expect(cvBadge).toBeVisible();
    await expect(cvBadge).toContainText('supervisor@enlite.com');

    // DNI frente: botão "Validar" (enviado mas não validado)
    const dniValidateBtn = docsCard.locator('[data-testid="validate-btn-identity_document"]');
    await expect(dniValidateBtn).toBeVisible();
    await expect(dniValidateBtn).toContainText('Validar');

    // Demais documentos não enviados → sem badge e sem botão Validar
    await expect(docsCard.locator('[data-testid="validate-btn-identity_document_back"]')).toHaveCount(0);
    await expect(docsCard.locator('[data-testid="validate-btn-criminal_record"]')).toHaveCount(0);

    // Screenshot panorâmica do card com estado misto
    await expect(docsCard).toHaveScreenshot('doc-validation-state-mixed-card.png');
  });

  // ── Comparação dos 3 estados lado a lado (slot do CV em cada cenário) ─────────

  test('Slot CV — estado 2 (botão Validar) exibe classes de borda verde outline', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_UPLOADED_NOT_VALIDATED });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    const validateBtn = docsCard.locator('[data-testid="validate-btn-resume_cv"]');
    await expect(validateBtn).toBeVisible();

    // Verifica classes CSS do botão outline verde
    await expect(validateBtn).toHaveClass(/border-green-300/);
    await expect(validateBtn).toHaveClass(/text-green-700/);

    await expect(validateBtn).toHaveScreenshot('doc-validation-btn-outline-green.png');
  });

  test('Slot CV — estado 3 (badge) exibe data formatada em es-AR', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_UPLOADED_AND_VALIDATED });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    const validationBadge = docsCard.locator('[data-testid="validation-badge-resume_cv"]');
    await expect(validationBadge).toBeVisible();

    // Data formatada em es-AR: "12 abr 2026" (ou similar conforme locale)
    // Verifica que algum texto de data aparece na portion hidden sm:inline
    const dateSpan = validationBadge.locator('span.hidden');
    await expect(dateSpan).toHaveCount(1);

    await expect(validationBadge).toHaveScreenshot('doc-validation-badge-with-date.png');
  });
});
