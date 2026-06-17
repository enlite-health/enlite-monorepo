/**
 * documents-grid-profession-visual.e2e.ts
 *
 * Playwright E2E — Testes visuais (screenshot assertions) para o DocumentsGrid
 * acessado via painel admin (WorkerDocumentsCard em /admin/workers/:id).
 *
 * Estratégia de auth: fake Firebase auth via page.route() — SEM emulator, SEM
 * conta real. Técnica idêntica à usada em blocked-attempts-visual.e2e.ts.
 * API admin e dados do worker são 100% mockados via page.route().
 *
 * Cobre:
 *   1. AT — slot at_certificate presente + banner âmbar + slots atOnly visíveis
 *   2. Cuidador (não-AT) — slots atOnly ausentes, professional_registration ausente
 *   3. AT — professional_registration absolutamente não renderizado
 *   4. Label "Constancia de ARCA" para monotributo_certificate (Cuidador)
 */

import { test, expect, Page, Route } from '@playwright/test';

// ── Auth constants ─────────────────────────────────────────────────────────────

const MOCK_ADMIN = {
  uid: 'docs-grid-vis-admin-uid',
  email: 'docs.grid.visual@e2e.test',
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
        users: [{ localId: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, emailVerified: true }],
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
          id: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          role: MOCK_ADMIN.role,
          firstName: 'Grid',
          lastName: 'Visual',
          isActive: true,
          mustChangePassword: false,
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

/**
 * Registra mocks da API do worker e navega para a aba de Documentos.
 * Deve ser chamado APÓS loginAsAdmin().
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
    await loginAsAdmin(page);
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
    await expect(
      docsCard.locator('[data-testid="doc-slot-professional_registration"]'),
    ).not.toBeVisible();

    // carta_recomendacion NÃO deve aparecer para AT
    await expect(
      docsCard.locator('[data-testid="doc-slot-carta_recomendacion"]'),
    ).not.toBeVisible();

    // Screenshot visual — AT com banner âmbar
    await expect(docsCard).toHaveScreenshot('documents-grid-at-with-amber-banner.png');
  });

  // ── 2. Cuidador — slots cuidadorOnly + sem banner âmbar ──────────────────────

  test('Cuidador: exibe carta_recomendacion, oculta slots atOnly e não exibe banner âmbar', async ({
    page,
  }) => {
    await loginAsAdmin(page);
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
    await expect(
      docsCard.locator('[data-testid="doc-slot-at_certificate"]'),
    ).not.toBeVisible();
    await expect(
      docsCard.locator('[data-testid="doc-slot-apto_psicofisico"]'),
    ).not.toBeVisible();
    await expect(
      docsCard.locator('[data-testid="doc-slot-analitico_universitario"]'),
    ).not.toBeVisible();

    // professional_registration NÃO deve aparecer
    await expect(
      docsCard.locator('[data-testid="doc-slot-professional_registration"]'),
    ).not.toBeVisible();

    // Banner âmbar NÃO deve aparecer para Cuidador
    await expect(docsCard.locator('.bg-amber-50.border-amber-200')).not.toBeVisible();

    // Screenshot visual — Cuidador sem banner âmbar
    await expect(docsCard).toHaveScreenshot('documents-grid-cuidador-no-amber-banner.png');
  });

  // ── 3. Label "Constancia de ARCA" para monotributo_certificate ───────────────

  test('Cuidador: monotributo_certificate exibe label "Constancia de ARCA"', async ({ page }) => {
    await loginAsAdmin(page);
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
    await loginAsAdmin(page);
    const workerAT = makeWorker(WORKER_AT_ID, 'AT');
    await navigateToWorkerDocuments(page, WORKER_AT_ID, workerAT);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(
      docsCard.locator('[data-testid="doc-slot-professional_registration"]'),
    ).toHaveCount(0);
  });
});
