/**
 * at-documents-clarity.integration.e2e.ts @integration
 *
 * Real-stack proof that the worker is told CLEARLY which AT documents they must
 * upload — including the ~68% of ATs whose profession=NULL (which the SQL gate
 * treats as AT, but the old UI hid the AT slots/warning from).
 *
 * Frontend real + backend real (USE_MOCK_AUTH=true) + Postgres real. The worker
 * state is DB-injected (we only assert what the Documents tab renders), then we
 * log in via the pass-through helper so /api/workers/me returns the real
 * profession and the store hydrates it.
 *
 * Pré-condições: docker (postgres + api) + pnpm dev. Run: pnpm test:e2e:integration
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.use({ video: 'on' }); // definição de pronto exige vídeo do fluxo real

test.describe('@integration AT documents clarity — worker-facing', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  async function openDocumentsTab(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
    await page.goto('/worker/profile?tab=documents', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.locator('[data-testid="tab-btn-documents"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="tab-btn-documents"]').click();
    await page.waitForTimeout(1_500);
  }

  test('profession=NULL → vê slots, aviso e marca de AT (gate trata NULL como AT)', async ({ page }) => {
    // No documents uploaded → every required doc is pending.
    const w = insertEligibilityWorker({
      occupation: null,
      docResumeCv: false, docIdentityDocument: false,
      docCriminalRecord: false, docAtCertificate: false,
    });
    await openDocumentsTab(page, w);

    // The AT-only slot renders even though profession is NULL.
    await expect(page.locator('[data-testid="doc-slot-at_certificate"]')).toBeVisible({ timeout: 15_000 });

    // Prominent, specific notice listing the pending AT documents.
    const notice = page.locator('[data-testid="at-required-notice"]');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Certificado de Acompañante Terapéutico');
    await expect(notice).toContainText('Antecedentes penales');

    // At least one required-empty slot is marked "Obligatorio".
    await expect(page.locator('[data-testid="doc-required-badge"]').first()).toBeVisible();

    await expect(notice).toHaveScreenshot('at-docs-null-notice.png', { maxDiffPixels: 150 });
  });

  test('CAREGIVER → SEM slot de AT, mas docs base marcados obrigatórios', async ({ page }) => {
    const w = insertEligibilityWorker({
      occupation: 'CAREGIVER',
      docIdentityDocument: false, docCriminalRecord: false,
    });
    await openDocumentsTab(page, w);

    // No AT-specific slot for a Cuidador (atOnly).
    await expect(page.locator('[data-testid="doc-slot-at_certificate"]')).toHaveCount(0);

    // Base required docs (identity/criminal) are still flagged as mandatory.
    const identitySlot = page.locator('[data-testid="doc-slot-identity_document"]');
    await expect(identitySlot).toBeVisible({ timeout: 15_000 });
    await expect(identitySlot.locator('[data-testid="doc-required-badge"]')).toBeVisible();

    await expect(identitySlot).toHaveScreenshot('at-docs-caregiver-identity-slot.png', { maxDiffPixels: 150 });
  });

  // CAMADA 0 — bug #3: o aviso "necesitás subir: ..." só aparecia pra isAT.
  // Cuidador/enfermeiro/psicólogo TAMBÉM têm DNI + antecedentes obrigatórios
  // (workerDocumentPolicy.ts) e nunca viam o que faltava pra postular — sem
  // nenhum aviso, só o texto sumia. Regressão: o teste acima, ANTES deste
  // conserto, afirmava `at-required-notice` com count 0 para CAREGIVER — essa
  // asserção codificava o próprio bug.
  test('CAREGIVER sem antecedentes → vê o MESMO aviso, nomeando "Antecedentes penales", sem citar AT', async ({ page }) => {
    const w = insertEligibilityWorker({
      occupation: 'CAREGIVER',
      docIdentityDocument: true, docCriminalRecord: false,
    });
    await openDocumentsTab(page, w);

    const notice = page.locator('[data-testid="at-required-notice"]');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('Antecedentes penales');
    await expect(notice).not.toContainText('Acompañante Terapéutico');

    await expect(notice).toHaveScreenshot('at-docs-caregiver-pending-notice.png', { maxDiffPixels: 150 });
  });

  test('CAREGIVER com identity_document + criminal_record → aviso VERDE de tudo enviado', async ({ page }) => {
    const w = insertEligibilityWorker({
      occupation: 'CAREGIVER',
      docIdentityDocument: true, docCriminalRecord: true,
    });
    await openDocumentsTab(page, w);

    const done = page.locator('[data-testid="at-required-done"]');
    await expect(done).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="at-required-notice"]')).toHaveCount(0);

    await expect(done).toHaveScreenshot('at-docs-caregiver-done-notice.png', { maxDiffPixels: 150 });
  });
});
