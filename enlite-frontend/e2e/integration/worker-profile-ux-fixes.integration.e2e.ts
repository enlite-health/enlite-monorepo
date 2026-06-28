/**
 * worker-profile-ux-fixes.integration.e2e.ts @integration
 *
 * Prova real-stack das reclamações FALADAS na narração do vídeo
 * `docs/adr/Registro de prestador UX.webm` (review em
 * docs/features/worker-registration-ux/ux-review-2026-06-28.md) que não são o
 * P0 (esse está em worker-profile-wizard.integration.e2e.ts):
 *
 *   - transcript:13-16 "profesión / nivel de estudios seleccionado por defecto
 *     → mejor sin selección"  → selects começam vazios (placeholder).
 *   - transcript:30-33 "horarios cada 5 min es muy largo → cada 30 minutos"
 *     → o seletor de horário oferece só :00 e :30.
 *
 * Frontend real + backend real + Postgres real. Run: pnpm test:e2e:integration
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.describe('@integration Worker profile — correções faladas no UX review', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  async function login(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
  }

  test('transcript:30-33 — seletor de horário em incrementos de 30 min (não 5)', async ({ page }) => {
    const w = insertEligibilityWorker({ occupation: 'AT' });
    await login(page, w);
    await page.goto('/worker/profile?tab=availability', { waitUntil: 'networkidle', timeout: 30_000 });

    // Habilita um dia e abre o dropdown do horário inicial.
    await expect(page.locator('[data-testid="day-schedule-add-monday"]')).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid="day-schedule-add-monday"]').click();
    const startBtn = page.locator('[data-testid="day-schedule-row-monday"] button:has-text(":")').first();
    await startBtn.click();

    // O dropdown deve conter 09:30 (passo 30) e NÃO 09:05 (passo 5 antigo).
    const list = page.locator('ul li button');
    await expect(page.locator('ul:has(li button:has-text("09:30"))')).toBeVisible({ timeout: 10_000 });
    await expect(list.filter({ hasText: /^09:05$/ })).toHaveCount(0);
    await expect(list.filter({ hasText: /^09:30$/ })).toHaveCount(1);

    // Prova visual: as opções saltam de 30 em 30.
    await expect(page.locator('ul:has(li button:has-text("09:30"))')).toHaveScreenshot(
      'time-picker-30min.png',
      { maxDiffPixels: 200 },
    );
  });

  test('transcript:13-16 — Profesión/Nivel de Estudios começam SEM seleção + Sexo/Género com hint', async ({ page }) => {
    // Worker sem profession/knowledge no banco → selects devem mostrar placeholder.
    const w = insertEligibilityWorker({ occupation: null });
    await login(page, w);
    await page.goto('/worker/profile?tab=general', { waitUntil: 'networkidle', timeout: 30_000 });

    const profession = page.locator('#profession');
    const knowledge = page.locator('#knowledgeLevel');
    await expect(profession).toBeVisible({ timeout: 20_000 });

    // Nenhum default pré-selecionado: o valor é '' (placeholder).
    await expect(profession).toHaveValue('');
    await expect(knowledge).toHaveValue('');

    // Hints diferenciam Sexo de Género.
    await expect(page.getByText('El sexo que figura en tu documento.')).toBeVisible();
    await expect(page.getByText('El género con el que te identificás.')).toBeVisible();

    // Prova visual: campo Sexo com hint (label + hint + select), sem default.
    // [2] = wrapper do FormField (o [1] é o div interno do próprio SelectField).
    const sexField = page.locator('#sex').locator('xpath=ancestor::div[contains(@class,"flex-col")][2]');
    await expect(sexField.getByText('El sexo que figura en tu documento.')).toBeVisible();
    await expect(sexField).toHaveScreenshot('sex-field-with-hint.png', { maxDiffPixels: 200 });
  });

  test('transcript:42-43 — adicionar "otra documentación" não quebra layout (mobile 360px)', async ({ page }) => {
    const w = insertEligibilityWorker({ occupation: 'AT' });
    await login(page, w);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto('/worker/profile?tab=documents', { waitUntil: 'networkidle', timeout: 30_000 });

    const section = page.locator('[data-testid="additional-documents-section"]');
    await expect(section).toBeVisible({ timeout: 20_000 });
    await section.scrollIntoViewIfNeeded();

    // Abre o formulário de "Otros Documentos" (botão +/Agregar).
    await page.locator('[data-testid="additional-doc-add"]').click();
    await expect(page.getByPlaceholder(/Nombre del documento/)).toBeVisible();

    // Prova visual: form de adicionar documento extra cabe no viewport estreito
    // sem o botão "+"/Subir estourar a linha (transcript:42-43 "aquí quebra").
    await expect(section).toHaveScreenshot('additional-docs-mobile.png', { maxDiffPixels: 300 });
  });
});
