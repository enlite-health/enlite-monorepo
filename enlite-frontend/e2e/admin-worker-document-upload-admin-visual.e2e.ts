/**
 * admin-worker-document-upload-admin-visual.e2e.ts
 *
 * Playwright E2E — Testes visuais para o fluxo de upload de documentos
 * no painel ADMIN (WorkerDetailPage), usando rotas mockadas.
 */

import { test, expect, Page } from '@playwright/test';
import { fileURLToPath } from 'url';
import * as path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';
const WORKER_ID = 'worker-upload-visual-001';
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample.pdf');

const DOCS_EMPTY = {
  id: 'doc-empty-1', resumeCvUrl: null, identityDocumentUrl: null,
  identityDocumentBackUrl: null, criminalRecordUrl: null,
  professionalRegistrationUrl: null, liabilityInsuranceUrl: null,
  monotributoCertificateUrl: null, atCertificateUrl: null,
  additionalCertificatesUrls: [], documentsStatus: 'pending',
  documentValidations: {}, reviewNotes: null,
  reviewedBy: null, reviewedAt: null, submittedAt: null,
};

function makeWorker(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WORKER_ID, email: 'upload-visual@test.com',
    phone: '+5491155550099', whatsappPhone: '+5491155550099',
    country: 'AR', timezone: 'America/Argentina/Buenos_Aires',
    status: 'REGISTERED', overallStatus: 'QUALIFIED',
    availabilityStatus: 'available', dataSources: ['talentum'],
    platform: 'talentum', createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-03-10T00:00:00Z', firstName: 'Carlos',
    lastName: 'Ramírez', sex: null, gender: null, birthDate: null,
    documentType: null, documentNumber: null, profilePhotoUrl: null,
    profession: null, occupation: null, knowledgeLevel: null,
    titleCertificate: null, experienceTypes: [], yearsExperience: null,
    preferredTypes: [], preferredAgeRange: [], languages: [],
    sexualOrientation: null, race: null, religion: null,
    weightKg: null, heightCm: null, hobbies: [],
    diagnosticPreferences: [], linkedinUrl: null,
    isMatchable: true, isActive: true, serviceAreas: [],
    location: null, encuadres: [], availability: [], documents: null,
    ...overrides,
  };
}

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.upload.visual.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';
  const res = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }) },
  );
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.localId) throw new Error(`Firebase sign-up failed: ${JSON.stringify(data)}`);
  const uid = data.localId as string;

  await page.route('**/api/admin/auth/profile', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { id: uid, email, role: 'superadmin',
        firstName: 'Upload', lastName: 'Visual', isActive: true, mustChangePassword: false } }) }));
  await page.route('**/api/admin/workers/stats', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { today: 0, yesterday: 0, sevenDaysAgo: 0 } }) }));
  await page.route('**/api/admin/workers/case-options', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }) }));

  await page.goto('/login?next=%2Fadmin');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

async function mockWorkerApis(
  page: Page,
  workerOverrides: Record<string, unknown>,
): Promise<void> {
  await page.route(`**/api/admin/workers/${WORKER_ID}`, (route) => {
    if (route.request().url().includes('/documents')) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: makeWorker(workerOverrides) }) });
  });
  await page.route(`**/api/admin/workers/${WORKER_ID}/additional-documents`, (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) });
  });
}

async function mockAdminUploadFlow(
  page: Page,
  saveDocsData: Record<string, unknown>,
  gcsDelay?: Promise<void>,
): Promise<void> {
  await page.route(`**/api/admin/workers/${WORKER_ID}/documents/upload-url`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: {
        signedUrl: 'https://storage.googleapis.com/mock', filePath: 'workers/test/doc.pdf' } }) }));
  await page.route('https://storage.googleapis.com/**', async (route) => {
    if (route.request().method() === 'PUT') {
      if (gcsDelay) await gcsDelay;
      await route.fulfill({ status: 200 });
    } else { await route.continue(); }
  });
  await page.route(`**/api/admin/workers/${WORKER_ID}/documents/save`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: saveDocsData }) }));
}

function mockWorkerRefetch(page: Page, workerOverrides: Record<string, unknown>): Promise<void> {
  return page.route(`**/api/admin/workers/${WORKER_ID}`, (route) => {
    if (route.request().url().includes('/documents')) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ success: true, data: makeWorker(workerOverrides) }) });
  });
}

async function triggerAdminUpload(page: Page, docType: string): Promise<void> {
  await page.locator(`[data-testid="doc-slot-${docType}"]`)
    .locator('input[type="file"]').setInputFiles(SAMPLE_PDF);
}

async function navigateToWorker(page: Page): Promise<void> {
  await page.goto(`/admin/workers/${WORKER_ID}`);
  await expect(page.locator('[data-testid="worker-documents-card"]')).toBeVisible({ timeout: 20_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('Admin Worker Document Upload — Visual', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test('exibe spinner durante upload e borda azul após conclusão', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_EMPTY });

    let resolveGCS!: () => void;
    const gcsHeld = new Promise<void>((r) => { resolveGCS = r; });
    const docsAfterUpload = { ...DOCS_EMPTY, id: 'doc-after-1', resumeCvUrl: 'workers/test/doc.pdf' };

    await mockAdminUploadFlow(page, docsAfterUpload, gcsHeld);
    await mockWorkerRefetch(page, { documents: docsAfterUpload });
    await navigateToWorker(page);

    await triggerAdminUpload(page, 'resume_cv');
    const slot = page.locator('[data-testid="doc-slot-resume_cv"]');
    await expect(slot.locator('[data-testid="upload-spinner"]')).toBeVisible({ timeout: 5_000 });

    resolveGCS();

    await expect(slot.locator('[data-testid="upload-spinner"]')).not.toBeVisible({ timeout: 15_000 });
    await expect(slot.locator('[data-state="uploaded"]')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('[data-testid="worker-documents-card"]'))
      .toHaveScreenshot('admin-upload-spinner-then-uploaded.png');
  });

  test('exibe card no estado azul após upload de monotributo_certificate', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { profession: 'AT', documents: DOCS_EMPTY });

    const docsAfterUpload = { ...DOCS_EMPTY, id: 'doc-mono-1', monotributoCertificateUrl: 'workers/test/doc.pdf' };
    await mockAdminUploadFlow(page, docsAfterUpload);
    await mockWorkerRefetch(page, { profession: 'AT', documents: docsAfterUpload });
    await navigateToWorker(page);

    await triggerAdminUpload(page, 'monotributo_certificate');
    await expect(page.locator('[data-testid="doc-slot-monotributo_certificate"] [data-state="uploaded"]'))
      .toBeVisible({ timeout: 15_000 });

    await expect(page.locator('[data-testid="worker-documents-card"]'))
      .toHaveScreenshot('admin-upload-monotributo-uploaded.png');
  });

  test('exibe card no estado azul após upload de at_certificate', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { profession: 'AT', documents: DOCS_EMPTY });

    const docsAfterUpload = { ...DOCS_EMPTY, id: 'doc-at-cert-1', atCertificateUrl: 'workers/test/doc.pdf' };
    await mockAdminUploadFlow(page, docsAfterUpload);
    await mockWorkerRefetch(page, { profession: 'AT', documents: docsAfterUpload });
    await navigateToWorker(page);

    await triggerAdminUpload(page, 'at_certificate');
    await expect(page.locator('[data-testid="doc-slot-at_certificate"] [data-state="uploaded"]'))
      .toBeVisible({ timeout: 15_000 });

    await expect(page.locator('[data-testid="worker-documents-card"]'))
      .toHaveScreenshot('admin-upload-at-certificate-uploaded.png');
  });

  test('exibe texto de erro em vermelho quando save falha (HTTP 500)', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_EMPTY });

    await page.route(`**/api/admin/workers/${WORKER_ID}/documents/upload-url`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: {
          signedUrl: 'https://storage.googleapis.com/mock', filePath: 'workers/test/doc.pdf' } }) }));
    await page.route('https://storage.googleapis.com/**', async (route) => {
      route.request().method() === 'PUT'
        ? await route.fulfill({ status: 200 })
        : await route.continue();
    });
    await page.route(`**/api/admin/workers/${WORKER_ID}/documents/save`, (r) =>
      r.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Internal server error' }) }));

    await navigateToWorker(page);
    await triggerAdminUpload(page, 'resume_cv');

    const slot = page.locator('[data-testid="doc-slot-resume_cv"]');
    await expect(slot.locator('.text-red-500')).toBeVisible({ timeout: 15_000 });
    await expect(slot.locator('[data-state="empty"]')).toBeVisible();

    await expect(page.locator('[data-testid="worker-documents-card"]'))
      .toHaveScreenshot('admin-upload-save-error-500.png');
  });

  test('exibe card azul após upload de resume_cv — estado persistido', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { documents: DOCS_EMPTY });

    const docsAfterUpload = { ...DOCS_EMPTY, id: 'doc-cv-1', resumeCvUrl: 'workers/test/doc.pdf' };
    await mockAdminUploadFlow(page, docsAfterUpload);
    await mockWorkerRefetch(page, { documents: docsAfterUpload });
    await navigateToWorker(page);

    await triggerAdminUpload(page, 'resume_cv');
    await expect(page.locator('[data-testid="doc-slot-resume_cv"] [data-state="uploaded"]'))
      .toBeVisible({ timeout: 15_000 });

    await expect(page.locator('[data-testid="worker-documents-card"]'))
      .toHaveScreenshot('admin-upload-resume-cv-uploaded.png');
  });

  test('valida que os 8 tipos de documentos estão visíveis para prestador AT', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkerApis(page, { profession: 'AT', documents: DOCS_EMPTY });
    await navigateToWorker(page);

    const docsCard = page.locator('[data-testid="worker-documents-card"]');
    // 8 slots: 6 base + monotributo_certificate + at_certificate
    await expect(docsCard.locator('[data-state]')).toHaveCount(8);
    await expect(docsCard.locator('[data-state="empty"]')).toHaveCount(8);
    await expect(docsCard.locator('[data-state="uploaded"]')).toHaveCount(0);

    await expect(docsCard).toHaveScreenshot('admin-upload-at-worker-8-slots-empty.png');
  });
});
