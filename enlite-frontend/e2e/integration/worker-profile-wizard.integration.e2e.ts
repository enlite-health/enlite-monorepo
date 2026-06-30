/**
 * worker-profile-wizard.integration.e2e.ts @integration
 *
 * Real-stack proof for the central P0 of the UX review
 * (docs/features/worker-registration-ux/ux-review-2026-06-28.md):
 *
 *   "Guardar não conduz: após salvar o app não avança de etapa e não há botão
 *    visível de continuar."
 *
 * Fix under test: a footer Atrás/Siguiente conduz o fluxo entre as 4 abas e, na
 * última, "Finalizar" abre um resumo do que ainda falta (com link direto pra
 * cada aba pendente). O autosave por aba continua persistindo — o footer só
 * navega.
 *
 * Frontend real + backend real (USE_MOCK_AUTH=true) + Postgres real. O worker é
 * injetado no banco; logamos via helper pass-through pra hidratar a store.
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

test.describe('@integration Worker profile wizard — navegação Atrás/Siguiente + finalização', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  async function openProfile(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
    await page.goto('/worker/profile?tab=general', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.locator('[data-testid="profile-wizard-footer"]')).toBeVisible({ timeout: 20_000 });
  }

  test('footer conduz o fluxo: Atrás desabilitado na 1ª aba, Siguiente avança', async ({ page }) => {
    const w = insertEligibilityWorker({ occupation: 'AT' });
    await openProfile(page, w);

    // Na primeira aba: Atrás desabilitado, Siguiente visível (sem Finalizar).
    await expect(page.locator('[data-testid="wizard-back"]')).toBeDisabled();
    await expect(page.locator('[data-testid="wizard-next"]')).toBeVisible();
    await expect(page.locator('[data-testid="wizard-finish"]')).toHaveCount(0);

    // Prova visual do footer na primeira etapa.
    await expect(page.locator('[data-testid="profile-wizard-footer"]')).toHaveScreenshot(
      'wizard-footer-first-tab.png',
      { maxDiffPixels: 150 },
    );

    // Siguiente avança para "Dirección de Atención".
    await page.locator('[data-testid="wizard-next"]').click();
    await expect(page.locator('[data-testid="tab-btn-address"]')).toHaveAttribute('aria-current', 'page');

    // Avança até a última aba (documents) → o CTA vira "Finalizar".
    await page.locator('[data-testid="wizard-next"]').click(); // availability
    await page.locator('[data-testid="wizard-next"]').click(); // documents
    await expect(page.locator('[data-testid="wizard-finish"]')).toBeVisible();
    await expect(page.locator('[data-testid="wizard-next"]')).toHaveCount(0);
  });

  test('Finalizar abre o resumo do que falta (worker incompleto) com link à aba pendente', async ({ page }) => {
    // Worker sem documentos obrigatórios → a seção de documentos fica pendente.
    const w = insertEligibilityWorker({
      occupation: 'AT',
      docResumeCv: false,
      docIdentityDocument: false,
      docCriminalRecord: false,
      docAtCertificate: false,
    });
    await openProfile(page, w);

    // Vai à última aba e finaliza.
    await page.goto('/worker/profile?tab=documents', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.locator('[data-testid="wizard-finish"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="wizard-finish"]').click();

    // Resumo aparece listando o que falta (documentos pendentes).
    const summary = page.locator('[data-testid="profile-completion-summary"]');
    await expect(summary).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="summary-pending"]')).toBeVisible();
    await expect(page.locator('[data-testid="summary-pending-documents"]')).toBeVisible();

    // Prova visual do resumo de finalização.
    await expect(summary.locator('div').first()).toHaveScreenshot('wizard-summary-pending.png', {
      maxDiffPixels: 300,
    });

    // Clicar no item pendente leva direto à aba de documentos e fecha o resumo.
    await page.locator('[data-testid="summary-pending-documents"]').click();
    await expect(summary).toHaveCount(0);
    await expect(page.locator('[data-testid="tab-btn-documents"]')).toHaveAttribute('aria-current', 'page');
  });
});
