/**
 * admin-worker-documents-visual.e2e.ts
 *
 * Playwright E2E — Testes visuais (screenshot assertions) para a aba de
 * Documentos do detalhe de um prestador no painel admin.
 *
 * Cobre:
 *   1. Estado misto (enviado/vazio) para prestador não-AT (6 slots)
 *   2. Estado para prestador AT (8 slots + banner âmbar de aviso)
 *   3. Todos os documentos enviados — não-AT (6 cards com borda azul)
 *   4. Nenhum documento enviado — estado vazio (cards cinzas)
 *   5. Seção de documentos adicionais com itens
 *   6. Badge de status REJEITADO (borda vermelha no badge)
 */

import { test, expect, Page } from '@playwright/test';

// ── Constants ──────────────────────────────────────────────────────────────────

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const WORKER_ID = 'worker-docs-visual-001';

// ── Mock data factories ────────────────────────────────────────────────────────

function makeWorker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WORKER_ID,
    email: 'visual@test.com',
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
    firstName: 'María',
    lastName: 'González',
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

const DOCS_MIXED: Record<string, unknown> = {
  id: 'doc-mixed-1',
  resumeCvUrl: 'workers/visual/cv.pdf',
  identityDocumentUrl: 'workers/visual/dni-front.pdf',
  identityDocumentBackUrl: null,
  criminalRecordUrl: 'workers/visual/criminal.pdf',
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
};

const DOCS_ALL_UPLOADED: Record<string, unknown> = {
  id: 'doc-all-1',
  resumeCvUrl: 'workers/visual/cv.pdf',
  identityDocumentUrl: 'workers/visual/dni-front.pdf',
  identityDocumentBackUrl: 'workers/visual/dni-back.pdf',
  criminalRecordUrl: 'workers/visual/criminal.pdf',
  professionalRegistrationUrl: 'workers/visual/reg.pdf',
  liabilityInsuranceUrl: 'workers/visual/insurance.pdf',
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  additionalCertificatesUrls: [],
  documentsStatus: 'submitted',
  reviewNotes: null,
  reviewedBy: null,
  reviewedAt: null,
  submittedAt: '2026-03-15T00:00:00Z',
};

const DOCS_EMPTY: Record<string, unknown> = {
  id: 'doc-empty-1',
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
};

const DOCS_AT_MIXED: Record<string, unknown> = {
  id: 'doc-at-1',
  resumeCvUrl: 'workers/visual/cv.pdf',
  identityDocumentUrl: 'workers/visual/dni-front.pdf',
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
};

const DOCS_REJECTED: Record<string, unknown> = {
  id: 'doc-rejected-1',
  resumeCvUrl: 'workers/visual/cv.pdf',
  identityDocumentUrl: 'workers/visual/dni-front.pdf',
  identityDocumentBackUrl: null,
  criminalRecordUrl: null,
  professionalRegistrationUrl: null,
  liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null,
  atCertificateUrl: null,
  additionalCertificatesUrls: [],
  documentsStatus: 'rejected',
  reviewNotes: 'Documento ilegível. Por favor, reenvie com melhor qualidade.',
  reviewedBy: 'admin-1',
  reviewedAt: '2026-04-01T12:00:00Z',
  submittedAt: '2026-03-20T00:00:00Z',
};

const ADDITIONAL_DOCS = [
  {
    id: 'addoc-1',
    label: 'Certificado Primeros Auxilios',
    filePath: 'workers/visual/first-aid.pdf',
    uploadedAt: '2026-03-12T00:00:00Z',
  },
  {
    id: 'addoc-2',
    label: 'Diploma de Psicología',
    filePath: 'workers/visual/diploma.pdf',
    uploadedAt: '2026-03-14T00:00:00Z',
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.docs.visual.${Date.now()}.${rnd}@test.com`;
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

  // Mock auth profile so the app considers the user an admin
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
          lastName: 'Visual',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  // Mock auxiliary list endpoints that may be fetched on route change
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
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

/**
 * Register page.route() mocks for the worker detail and additional documents
 * endpoints. Must be called BEFORE page.goto().
 */
async function mockWorkerApis(
  page: Page,
  workerOverrides: Record<string, unknown>,
  additionalDocs: unknown[] = [],
): Promise<void> {
  const workerBody = JSON.stringify({
    success: true,
    data: makeWorker(workerOverrides),
  });

  const additionalDocsBody = JSON.stringify(additionalDocs);

  // Worker detail — exact ID match
  await page.route(`**/api/admin/workers/${WORKER_ID}`, (route) => {
    // Skip document sub-routes
    if (route.request().url().includes('/documents')) {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: workerBody,
    });
  });

  // Additional documents list
  await page.route(`**/api/admin/workers/${WORKER_ID}/additional-documents`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: additionalDocsBody,
    });
  });
}

async function navigateToDocumentsTab(page: Page): Promise<void> {
  await page.goto(`/admin/workers/${WORKER_ID}`);
  // The documents tab is active by default, wait for the card to appear
  await expect(
    page.locator('[data-testid="worker-documents-card"]'),
  ).toBeVisible({ timeout: 20_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('Admin Worker Documents — Visual', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── 1. Estado misto — prestador não-AT (6 slots) ─────────────────────────────

  test('exibe 6 slots com estado misto (enviado/vazio) para prestador não-AT', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_MIXED });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // 3 slots enviados (CV, DNI frente, antecedentes)
    const uploadedSlots = docsCard.locator('[data-state="uploaded"]');
    await expect(uploadedSlots).toHaveCount(3);

    // 3 slots vazios (verso DNI, registro, seguro)
    const emptySlots = docsCard.locator('[data-state="empty"]');
    await expect(emptySlots).toHaveCount(3);

    // Não deve exibir os 2 slots exclusivos de AT (monotributo e certif. AT)
    await expect(docsCard.locator('[data-state]')).toHaveCount(6);

    await expect(docsCard).toHaveScreenshot('worker-docs-non-at-mixed-state.png');
  });

  // ── 2. Prestador AT — 8 slots + banner âmbar ────────────────────────────────

  test('exibe 8 slots e banner âmbar de aviso para prestador AT', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { profession: 'AT', documents: DOCS_AT_MIXED });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // 8 slots totais para AT
    await expect(docsCard.locator('[data-state]')).toHaveCount(8);

    // Banner âmbar de aviso obrigatório de AT
    const atWarning = docsCard.locator('.bg-amber-50.border-amber-200');
    await expect(atWarning).toBeVisible();

    await expect(docsCard).toHaveScreenshot('worker-docs-at-mixed-with-warning.png');
  });

  // ── 3. Todos os documentos enviados — não-AT ─────────────────────────────────

  test('exibe todos os 6 cards com borda azul quando todos os docs estão enviados (não-AT)', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_ALL_UPLOADED });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // Todos os 6 slots devem estar no estado "uploaded" com borda primary (azul)
    const uploadedSlots = docsCard.locator('[data-state="uploaded"]');
    await expect(uploadedSlots).toHaveCount(6);

    // Nenhum slot vazio
    await expect(docsCard.locator('[data-state="empty"]')).toHaveCount(0);

    // Badge de status "submitted"
    const statusBadge = docsCard.locator('span.rounded-full');
    await expect(statusBadge).toBeVisible();
    await expect(statusBadge).toContainText('submitted');

    await expect(docsCard).toHaveScreenshot('worker-docs-non-at-all-uploaded.png');
  });

  // ── 4. Nenhum documento enviado — estado vazio ───────────────────────────────

  test('exibe todos os cards no estado cinza/vazio quando nenhum documento foi enviado', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_EMPTY });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // 6 slots vazios (não-AT por padrão)
    const emptySlots = docsCard.locator('[data-state="empty"]');
    await expect(emptySlots).toHaveCount(6);

    // Nenhum slot enviado
    await expect(docsCard.locator('[data-state="uploaded"]')).toHaveCount(0);

    await expect(docsCard).toHaveScreenshot('worker-docs-all-empty-state.png');
  });

  // ── 5. Seção de documentos adicionais com itens ──────────────────────────────

  test('exibe a seção de documentos adicionais com a lista de itens', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_MIXED }, ADDITIONAL_DOCS);
    await navigateToDocumentsTab(page);

    // Aguarda o card principal carregar antes de verificar a seção adicional
    await expect(
      page.locator('[data-testid="worker-documents-card"]'),
    ).toBeVisible();

    // A seção adicional fica após o card principal (sem card wrapper próprio)
    const additionalSection = page.locator('text=Otros Documentos').locator('../..');
    await expect(additionalSection).toBeVisible({ timeout: 10_000 });

    // Os dois documentos adicionais devem ser listados
    await expect(page.getByText('Certificado Primeros Auxilios')).toBeVisible();
    await expect(page.getByText('Diploma de Psicología')).toBeVisible();

    await expect(additionalSection).toHaveScreenshot('worker-docs-additional-section-with-items.png');
  });

  // ── 6. Badge de status REJEITADO ─────────────────────────────────────────────

  test('exibe badge de status "rejected" com cor vermelha e notas de revisão', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_REJECTED });
    await navigateToDocumentsTab(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    await expect(docsCard).toBeVisible();

    // Badge com texto "rejected" e classes de cor vermelha
    const statusBadge = docsCard.locator('span.rounded-full');
    await expect(statusBadge).toBeVisible();
    await expect(statusBadge).toContainText('rejected');
    await expect(statusBadge).toHaveClass(/text-red-700/);
    await expect(statusBadge).toHaveClass(/bg-cancelled/);

    // Bloco de notas de revisão deve aparecer
    const reviewNotesBlock = docsCard.locator('.bg-gray-200.rounded-lg');
    await expect(reviewNotesBlock).toBeVisible();
    await expect(reviewNotesBlock).toContainText('Documento ilegível');

    await expect(docsCard).toHaveScreenshot('worker-docs-rejected-status-with-notes.png');
  });

  // ── 7. Seção adicional — estado vazio ────────────────────────────────────────

  test('exibe mensagem de "sem documentos adicionais" quando a lista está vazia', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_MIXED }, []);
    await navigateToDocumentsTab(page);

    await expect(
      page.locator('[data-testid="worker-documents-card"]'),
    ).toBeVisible();

    const additionalSection = page.locator('text=Otros Documentos').locator('../..');
    await expect(additionalSection).toBeVisible({ timeout: 10_000 });

    // Mensagem de lista vazia
    await expect(
      page.getByText(/No hay documentos adicionales/i),
    ).toBeVisible({ timeout: 5_000 });

    await expect(additionalSection).toHaveScreenshot('worker-docs-additional-section-empty.png');
  });

  // ── 8. Vista panorâmica da aba completa de documentos ────────────────────────

  test('vista panorâmica da aba de documentos com estado misto', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_MIXED }, ADDITIONAL_DOCS);
    await navigateToDocumentsTab(page);

    // Aguarda ambos os componentes renderizarem
    await expect(
      page.locator('[data-testid="worker-documents-card"]'),
    ).toBeVisible();
    await expect(page.getByText('Certificado Primeros Auxilios')).toBeVisible({ timeout: 10_000 });

    // Captura o container que engloba o card principal + seção adicional
    const tabContent = page.locator('.mb-6').filter({
      has: page.locator('[data-testid="worker-documents-card"]'),
    }).last();

    await expect(tabContent).toHaveScreenshot('worker-docs-tab-full-view.png');
  });
});
