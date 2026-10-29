import { test, expect, Page } from '@playwright/test';
import { fileURLToPath } from 'url';
import * as path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE_PDF = path.join(__dirname, 'fixtures', 'sample.pdf');

type DocType =
  | 'resume_cv'
  | 'identity_document'
  | 'criminal_record'
  | 'professional_registration'
  | 'liability_insurance';

interface DocSlot {
  docType: DocType;
  urlField: string;
}

const DOC_SLOTS: DocSlot[] = [
  { docType: 'resume_cv', urlField: 'resumeCvUrl' },
  { docType: 'identity_document', urlField: 'identityDocumentUrl' },
  { docType: 'criminal_record', urlField: 'criminalRecordUrl' },
  { docType: 'professional_registration', urlField: 'professionalRegistrationUrl' },
  { docType: 'liability_insurance', urlField: 'liabilityInsuranceUrl' },
];

const BASE_DOCS = {
  id: 'test-id',
  workerId: 'test-worker',
  resumeCvUrl: null as string | null,
  identityDocumentUrl: null as string | null,
  criminalRecordUrl: null as string | null,
  professionalRegistrationUrl: null as string | null,
  liabilityInsuranceUrl: null as string | null,
  documentsStatus: 'pending',
  submittedAt: null as string | null,
  updatedAt: new Date().toISOString(),
};

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

async function registerAndNavigateToDocuments(page: Page, email: string): Promise<void> {
  await page.goto('/register');
  await page.getByPlaceholder('sucorreo@ejemplo.com').fill(email);
  await page.locator('input[type="password"]').nth(0).fill('TestPass123!');
  await page.locator('input[type="password"]').nth(1).fill('TestPass123!');
  await page.getByText(/Acepto recibir comunicaciones|acepto/i).click();
  await page.getByText(/Registrarse|Crear cuenta/i).click();
  await expect(page).toHaveURL('/', { timeout: 10000 });
  await page.goto('/worker/profile');
  await expect(page.locator('h1')).toContainText(/perfil|profile/i, { timeout: 10000 });
  await page.getByRole('button', { name: /documentos|documents/i }).click();
  await expect(page.locator('.animate-pulse')).not.toBeVisible({ timeout: 10000 });
}

/** Mocks the 3-step upload flow: upload-url → GCS PUT → save. */
async function mockUploadFlow(
  page: Page,
  saveOverrides: Record<string, string | null> = {},
): Promise<void> {
  await page.route('https://storage.googleapis.com/**', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({ status: 200 });
    } else {
      await route.continue();
    }
  });
  await page.route('**/api/workers/me/documents/upload-url', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { signedUrl: 'https://storage.googleapis.com/mock', filePath: 'workers/test/doc.pdf' },
      }),
    });
  });
  await page.route('**/api/workers/me/documents/save', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { ...BASE_DOCS, ...saveOverrides } }),
    });
  });
}

async function triggerUpload(page: Page, docType: DocType): Promise<void> {
  await page
    .locator(`[data-testid="doc-slot-${docType}"]`)
    .locator('input[type="file"]')
    .setInputFiles(SAMPLE_PDF);
}

// ──────────────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────────────

test.describe('Documents Upload Flow - E2E', () => {
  test.beforeEach(async ({ page }) => {
    // Default: GET returns no documents so every test starts from an empty state.
    await page.route('**/api/workers/me/documents', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: null }),
        });
      } else {
        await route.continue();
      }
    });
  });

  // ── Estado inicial ────────────────────────────────────────

  test('shows skeleton while fetching documents', async ({ page }) => {
    let resolveGet!: () => void;
    const getHeld = new Promise<void>((r) => { resolveGet = r; });

    // Override beforeEach — delay the GET response so the skeleton is observable.
    await page.route('**/api/workers/me/documents', async (route) => {
      if (route.request().method() === 'GET') {
        await getHeld;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: null }),
        });
      } else {
        await route.continue();
      }
    });

    const email = `e2e.skeleton.${Date.now()}@test.com`;
    await page.goto('/register');
    await page.getByPlaceholder('sucorreo@ejemplo.com').fill(email);
    await page.locator('input[type="password"]').nth(0).fill('TestPass123!');
    await page.locator('input[type="password"]').nth(1).fill('TestPass123!');
    await page.getByText(/Acepto recibir comunicaciones|acepto/i).click();
    await page.getByText(/Registrarse|Crear cuenta/i).click();
    await expect(page).toHaveURL('/', { timeout: 10000 });
    await page.goto('/worker/profile');
    await page.getByRole('button', { name: /documentos|documents/i }).click();

    // Skeleton must be visible while fetch is in-flight.
    await expect(page.locator('.animate-pulse')).toBeVisible({ timeout: 5000 });

    resolveGet();

    // Skeleton must disappear once fetch completes.
    await expect(page.locator('.animate-pulse')).not.toBeVisible({ timeout: 10000 });
  });

  test('shows all 5 document cards in empty (clickable) state', async ({ page }) => {
    const email = `e2e.empty.${Date.now()}@test.com`;
    await registerAndNavigateToDocuments(page, email);

    for (const { docType } of DOC_SLOTS) {
      const slot = page.locator(`[data-testid="doc-slot-${docType}"]`);
      await expect(slot).toBeVisible();
      // Empty cards must have role="button" (clickable to trigger file picker).
      await expect(slot.locator('[role="button"]')).toBeVisible();
      // No blue border — not uploaded yet.
      await expect(slot.locator('[data-state="uploaded"]')).not.toBeVisible();
    }
  });

  // ── Upload por tipo de documento (5 testes individuais) ───

  for (const { docType, urlField } of DOC_SLOTS) {
    test(`upload: ${docType} — spinner during upload, blue border after`, async ({ page }) => {
      const email = `e2e.upload.${docType}.${Date.now()}@test.com`;
      await registerAndNavigateToDocuments(page, email);

      let resolveGCS!: () => void;
      const gcsHeld = new Promise<void>((r) => { resolveGCS = r; });

      // Delay GCS PUT so the spinner stays visible long enough to assert.
      await page.route('https://storage.googleapis.com/**', async (route) => {
        if (route.request().method() === 'PUT') {
          await gcsHeld;
          await route.fulfill({ status: 200 });
        } else {
          await route.continue();
        }
      });
      await page.route('**/api/workers/me/documents/upload-url', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { signedUrl: 'https://storage.googleapis.com/mock', filePath: `workers/test/${docType}.pdf` },
          }),
        });
      });
      await page.route('**/api/workers/me/documents/save', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { ...BASE_DOCS, [urlField]: `workers/test/${docType}.pdf` } }),
        });
      });

      const slot = page.locator(`[data-testid="doc-slot-${docType}"]`);
      await triggerUpload(page, docType);

      // 1. Spinner must appear (uploading state).
      await expect(slot.locator('[data-testid="upload-spinner"]')).toBeVisible({ timeout: 5000 });
      // 2. Blue border must NOT be visible yet.
      await expect(slot.locator('[data-state="uploaded"]')).not.toBeVisible();

      // Release the GCS hold to let the upload finish.
      resolveGCS();

      // 3. Spinner must disappear.
      await expect(slot.locator('[data-testid="upload-spinner"]')).not.toBeVisible({ timeout: 10000 });
      // 4. Blue border must appear (uploaded state).
      await expect(slot.locator('[data-state="uploaded"]')).toBeVisible({ timeout: 10000 });
      // 5. Delete and view action buttons must be visible.
      await expect(slot.locator('[aria-label="Quitar documento"]')).toBeVisible();
      await expect(slot.locator('[aria-label="Ver documento"]')).toBeVisible();
      // 6. Card must no longer be a clickable button.
      await expect(slot.locator('[role="button"]')).not.toBeVisible();
    });
  }

  // ── Upload dos 5 documentos em sequência ─────────────────

  test('uploads all 5 documents sequentially — each shows uploaded state', async ({ page }) => {
    const email = `e2e.all5.${Date.now()}@test.com`;
    await registerAndNavigateToDocuments(page, email);

    const accumulated: Record<string, string | null> = {};

    for (const { docType, urlField } of DOC_SLOTS) {
      accumulated[urlField] = `workers/test/${docType}.pdf`;
      await mockUploadFlow(page, { ...accumulated });
      await triggerUpload(page, docType);

      const slot = page.locator(`[data-testid="doc-slot-${docType}"]`);
      // Spinner must appear then disappear for each document.
      await expect(slot.locator('[data-testid="upload-spinner"]')).toBeVisible({ timeout: 5000 });
      await expect(slot.locator('[data-testid="upload-spinner"]')).not.toBeVisible({ timeout: 10000 });
      // Blue border must appear.
      await expect(slot.locator('[data-state="uploaded"]')).toBeVisible({ timeout: 10000 });
    }

    // Final state: all 5 slots must show uploaded state.
    for (const { docType } of DOC_SLOTS) {
      await expect(
        page.locator(`[data-testid="doc-slot-${docType}"] [data-state="uploaded"]`),
      ).toBeVisible();
    }
  });

  // ── Estado de erro ────────────────────────────────────────

  test('error: shows red error text when upload-url endpoint fails', async ({ page }) => {
    const email = `e2e.err-url.${Date.now()}@test.com`;
    await registerAndNavigateToDocuments(page, email);

    await page.route('**/api/workers/me/documents/upload-url', async (route) => {
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Internal Server Error' }),
      });
    });

    const slot = page.locator('[data-testid="doc-slot-resume_cv"]');
    await triggerUpload(page, 'resume_cv');

    // Error text must appear below the card.
    await expect(slot.locator('.text-red-500')).toBeVisible({ timeout: 10000 });
    // No blue border — upload failed.
    await expect(slot.locator('[data-state="uploaded"]')).not.toBeVisible();
    // Card must be clickable again so the user can retry.
    await expect(slot.locator('[role="button"]')).toBeVisible({ timeout: 10000 });
  });

  test('error: shows red error text when GCS PUT fails', async ({ page }) => {
    const email = `e2e.err-gcs.${Date.now()}@test.com`;
    await registerAndNavigateToDocuments(page, email);

    await page.route('**/api/workers/me/documents/upload-url', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: { signedUrl: 'https://storage.googleapis.com/mock', filePath: 'workers/test/doc.pdf' },
        }),
      });
    });
    await page.route('https://storage.googleapis.com/**', async (route) => {
      if (route.request().method() === 'PUT') {
        await route.fulfill({ status: 403, body: 'Forbidden' });
      } else {
        await route.continue();
      }
    });

    const slot = page.locator('[data-testid="doc-slot-resume_cv"]');
    await triggerUpload(page, 'resume_cv');

    await expect(slot.locator('.text-red-500')).toBeVisible({ timeout: 10000 });
    await expect(slot.locator('[data-state="uploaded"]')).not.toBeVisible();
  });

  test('error: errors are isolated — failure on one card does not affect others', async ({ page }) => {
    const email = `e2e.err-isolated.${Date.now()}@test.com`;
    await registerAndNavigateToDocuments(page, email);

    let callCount = 0;
    await page.route('**/api/workers/me/documents/upload-url', async (route) => {
      callCount++;
      if (callCount === 1) {
        // First call (resume_cv) fails.
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false }),
        });
      } else {
        // Subsequent calls succeed.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { signedUrl: 'https://storage.googleapis.com/mock', filePath: 'workers/test/doc.pdf' },
          }),
        });
      }
    });
    await page.route('https://storage.googleapis.com/**', async (route) => {
      route.request().method() === 'PUT'
        ? await route.fulfill({ status: 200 })
        : await route.continue();
    });
    await page.route('**/api/workers/me/documents/save', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { ...BASE_DOCS, identityDocumentUrl: 'workers/test/doc.pdf' } }),
      });
    });

    // Upload resume_cv — should fail.
    const resumeSlot = page.locator('[data-testid="doc-slot-resume_cv"]');
    await triggerUpload(page, 'resume_cv');
    await expect(resumeSlot.locator('.text-red-500')).toBeVisible({ timeout: 10000 });

    // Upload identity_document — should succeed.
    const dniSlot = page.locator('[data-testid="doc-slot-identity_document"]');
    await triggerUpload(page, 'identity_document');
    await expect(dniSlot.locator('[data-state="uploaded"]')).toBeVisible({ timeout: 10000 });

    // resume_cv error must still be visible.
    await expect(resumeSlot.locator('.text-red-500')).toBeVisible();
    // identity_document must NOT have an error.
    await expect(dniSlot.locator('.text-red-500')).not.toBeVisible();
  });

  // ── Deleção ───────────────────────────────────────────────

  test('delete: removes document and resets card to empty state', async ({ page }) => {
    const email = `e2e.delete.${Date.now()}@test.com`;
    await registerAndNavigateToDocuments(page, email);

    await mockUploadFlow(page, { resumeCvUrl: 'workers/test/resume.pdf' });
    await triggerUpload(page, 'resume_cv');

    const slot = page.locator('[data-testid="doc-slot-resume_cv"]');
    // Wait for the delete button — it only renders when isUploaded=true.
    await expect(slot.locator('[aria-label="Quitar documento"]')).toBeVisible({ timeout: 10000 });

    let deleteCalled = false;
    await page.route('**/api/workers/me/documents/**', async (route) => {
      if (route.request().method() === 'DELETE') {
        deleteCalled = true;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true }),
        });
      } else {
        await route.continue();
      }
    });

    await slot.locator('[aria-label="Quitar documento"]').click();

    // Card must return to empty/clickable state.
    await expect(slot.locator('[role="button"]')).toBeVisible({ timeout: 10000 });
    expect(deleteCalled).toBe(true);
    await expect(slot.locator('[data-state="uploaded"]')).not.toBeVisible();
  });

  // ── Persistência ──────────────────────────────────────────

  test('persist: uploaded documents survive a full page reload', async ({ page }) => {
    const email = `e2e.persist.${Date.now()}@test.com`;
    await registerAndNavigateToDocuments(page, email);

    await mockUploadFlow(page, { resumeCvUrl: 'workers/test/resume.pdf' });
    await triggerUpload(page, 'resume_cv');

    const slot = page.locator('[data-testid="doc-slot-resume_cv"]');
    await expect(slot.locator('[data-state="uploaded"]')).toBeVisible({ timeout: 10000 });

    // After reload the GET must return the persisted document.
    await page.route('**/api/workers/me/documents', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { ...BASE_DOCS, resumeCvUrl: 'workers/test/resume.pdf' } }),
        });
      } else {
        await route.continue();
      }
    });

    await page.reload();
    await page.getByRole('button', { name: /documentos|documents/i }).click();
    await expect(page.locator('.animate-pulse')).not.toBeVisible({ timeout: 10000 });

    await expect(
      page.locator('[data-testid="doc-slot-resume_cv"] [data-state="uploaded"]'),
    ).toBeVisible({ timeout: 10000 });
  });

  // ── Visualização ──────────────────────────────────────────

  test('view: clicking view button calls view-url API and opens signed URL', async ({ page }) => {
    const email = `e2e.view.${Date.now()}@test.com`;
    await registerAndNavigateToDocuments(page, email);

    await mockUploadFlow(page, { resumeCvUrl: 'workers/test/resume.pdf' });
    await triggerUpload(page, 'resume_cv');

    const slot = page.locator('[data-testid="doc-slot-resume_cv"]');
    await expect(slot.locator('[data-state="uploaded"]')).toBeVisible({ timeout: 10000 });

    let viewUrlCalled = false;
    await page.route('**/api/workers/me/documents/view-url', async (route) => {
      viewUrlCalled = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { signedUrl: 'https://storage.googleapis.com/view' } }),
      });
    });

    await slot.locator('[aria-label="Ver documento"]').click();
    await page.waitForTimeout(500);
    expect(viewUrlCalled).toBe(true);
  });
});
