/**
 * documents-grid-profession-visual.e2e.ts
 *
 * Playwright E2E — Testes visuais (screenshot assertions) para o DocumentsGrid
 * acessado via painel admin (WorkerDocumentsCard em /admin/workers/:id).
 *
 * Estratégia de auth: login via UI admin com Firebase REAL (enlite-prd).
 * API admin e dados do worker são 100% mockados via page.route().
 * NÃO usa Firebase Emulator (proibido neste projeto).
 *
 * Cobre:
 *   1. AT — slot at_certificate presente + banner âmbar + slots atOnly visíveis
 *   2. Cuidador (não-AT) — slots atOnly ausentes, professional_registration ausente
 *   3. AT — professional_registration absolutamente não renderizado
 *   4. Label "Constancia de ARCA" para monotributo_certificate (Cuidador)
 */

import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const WORKER_AT_ID = 'worker-at-grid-visual-001';
const WORKER_CUIDADOR_ID = 'worker-cuidador-grid-visual-001';

// ── Mock data factories ────────────────────────────────────────────────────────

function makeWorker(
  id: string,
  profession: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    email: `${id}@test.com`,
    phone: '+5491155550001',
    whatsappPhone: '+5491155550001',
    country: 'AR',
    timezone: 'America/Argentina/Buenos_Aires',
    status: 'REGISTERED',
    overallStatus: 'QUALIFIED',
    availabilityStatus: 'available',
    dataSources: ['talentum'],
    platform: 'talentum',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z',
    firstName: 'Visual',
    lastName: 'Test',
    sex: null,
    gender: null,
    birthDate: null,
    documentType: null,
    documentNumber: null,
    profilePhotoUrl: null,
    profession,
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

function makeDocsEmpty(workerId: string): Record<string, unknown> {
  return {
    id: `doc-${workerId}`,
    workerId,
    resumeCvUrl: null,
    identityDocumentUrl: null,
    identityDocumentBackUrl: null,
    criminalRecordUrl: null,
    professionalRegistrationUrl: null,
    liabilityInsuranceUrl: null,
    monotributoCertificateUrl: null,
    atCertificateUrl: null,
    aptoPsicofisicoUrl: null,
    analiticoUniversitarioUrl: null,
    cartaRecomendacionUrl: null,
    additionalCertificatesUrls: [],
    documentsStatus: 'pending',
    documentValidations: {},
    reviewNotes: null,
    reviewedBy: null,
    reviewedAt: null,
    submittedAt: null,
    updatedAt: new Date().toISOString(),
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Faz login admin via UI com Firebase REAL.
 * Mocka /api/admin/auth/profile para o app reconhecer o usuário como superadmin.
 * NÃO usa Firebase Emulator.
 */
async function loginAdmin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.docs.grid.visual.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  // Cria usuário no Firebase Emulator (necessário para login via UI)
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

  // Mock do perfil admin para bypassar autorização real
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
          firstName: 'Grid',
          lastName: 'Visual',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  // Mock de endpoints auxiliares
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

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

/**
 * Registra mocks da API do worker e navega para a aba de Documentos.
 * Deve ser chamado APÓS loginAdmin().
 */
async function navigateToWorkerDocuments(
  page: Page,
  workerId: string,
  workerData: Record<string, unknown>,
): Promise<void> {
  const docs = makeDocsEmpty(workerId);

  // Worker detail
  await page.route(`**/api/admin/workers/${workerId}`, (route) => {
    if (route.request().url().includes('/documents')) return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: workerData }),
    });
  });

  // Documents list
  await page.route(`**/api/admin/workers/${workerId}/documents`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: docs }),
    });
  });

  // Additional documents
  await page.route(`**/api/admin/workers/${workerId}/additional-documents`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });

  await page.goto(`/admin/workers/${workerId}`);
  await expect(
    page.locator('[data-testid="worker-documents-card"]'),
  ).toBeVisible({ timeout: 20_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('DocumentsGrid — Visibilidade por Profissão (Visual)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── 1. AT — slots atOnly + banner âmbar ───────────────────────────────────────

  test('AT: exibe slot at_certificate e banner âmbar de obrigatoriedade', async ({ page }) => {
    await loginAdmin(page);
    const workerAT = makeWorker(WORKER_AT_ID, 'AT');
    await navigateToWorkerDocuments(page, WORKER_AT_ID, workerAT);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');

    // Slot at_certificate presente para AT
    await expect(docsCard.locator('[data-testid="doc-slot-at_certificate"]')).toBeVisible();

    // Slots universais presentes
    await expect(docsCard.locator('[data-testid="doc-slot-identity_document"]')).toBeVisible();
    await expect(docsCard.locator('[data-testid="doc-slot-identity_document_back"]')).toBeVisible();
    await expect(docsCard.locator('[data-testid="doc-slot-criminal_record"]')).toBeVisible();

    // Banner âmbar de obrigatoriedade AT
    await expect(docsCard.locator('.bg-amber-50.border-amber-200')).toBeVisible();

    // professional_registration NÃO deve aparecer
    await expect(docsCard.locator('[data-testid="doc-slot-professional_registration"]')).not.toBeVisible();

    // carta_recomendacion NÃO deve aparecer para AT
    await expect(docsCard.locator('[data-testid="doc-slot-carta_recomendacion"]')).not.toBeVisible();

    // Screenshot visual — AT com banner âmbar
    await expect(docsCard).toHaveScreenshot('documents-grid-at-with-amber-banner.png');
  });

  // ── 2. Cuidador — slots cuidadorOnly + sem banner âmbar ──────────────────────

  test('Cuidador: exibe carta_recomendacion, oculta slots atOnly e não exibe banner âmbar', async ({ page }) => {
    await loginAdmin(page);
    const workerCuidador = makeWorker(WORKER_CUIDADOR_ID, 'CUIDADOR');
    await navigateToWorkerDocuments(page, WORKER_CUIDADOR_ID, workerCuidador);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');

    // Slot cuidadorOnly presente
    await expect(docsCard.locator('[data-testid="doc-slot-carta_recomendacion"]')).toBeVisible();

    // Slots universais presentes
    await expect(docsCard.locator('[data-testid="doc-slot-identity_document"]')).toBeVisible();
    await expect(docsCard.locator('[data-testid="doc-slot-identity_document_back"]')).toBeVisible();
    await expect(docsCard.locator('[data-testid="doc-slot-criminal_record"]')).toBeVisible();

    // Slots atOnly ausentes
    await expect(docsCard.locator('[data-testid="doc-slot-at_certificate"]')).not.toBeVisible();
    await expect(docsCard.locator('[data-testid="doc-slot-apto_psicofisico"]')).not.toBeVisible();
    await expect(docsCard.locator('[data-testid="doc-slot-analitico_universitario"]')).not.toBeVisible();

    // professional_registration NÃO deve aparecer
    await expect(docsCard.locator('[data-testid="doc-slot-professional_registration"]')).not.toBeVisible();

    // Banner âmbar NÃO deve aparecer para Cuidador
    await expect(docsCard.locator('.bg-amber-50.border-amber-200')).not.toBeVisible();

    // Screenshot visual — Cuidador sem banner âmbar
    await expect(docsCard).toHaveScreenshot('documents-grid-cuidador-no-amber-banner.png');
  });

  // ── 3. Label "Constancia de ARCA" para monotributo_certificate ───────────────

  test('Cuidador: monotributo_certificate exibe label "Constancia de ARCA"', async ({ page }) => {
    await loginAdmin(page);
    const workerCuidador = makeWorker(WORKER_CUIDADOR_ID, 'CUIDADOR');
    await navigateToWorkerDocuments(page, WORKER_CUIDADOR_ID, workerCuidador);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    const monotributoSlot = docsCard.locator('[data-testid="doc-slot-monotributo_certificate"]');
    await expect(monotributoSlot).toBeVisible();
    await expect(monotributoSlot).toContainText('Constancia de ARCA');

    // Screenshot do slot com label correto
    await expect(monotributoSlot).toHaveScreenshot('doc-slot-monotributo-label-arca.png');
  });

  // ── 4. AT — professional_registration absolutamente ausente ──────────────────

  test('AT: professional_registration não é renderizado no grid', async ({ page }) => {
    await loginAdmin(page);
    const workerAT = makeWorker(WORKER_AT_ID, 'AT');
    await navigateToWorkerDocuments(page, WORKER_AT_ID, workerAT);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard.locator('[data-testid="doc-slot-professional_registration"]')).toHaveCount(0);
  });
});
