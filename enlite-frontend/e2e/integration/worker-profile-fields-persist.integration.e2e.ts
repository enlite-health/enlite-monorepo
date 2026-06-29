/**
 * worker-profile-fields-persist.integration.e2e.ts @integration
 *
 * Regressão do bug relatado: "ao entrar no perfil, os campos aparecem
 * preenchidos e depois SOMEM".
 *
 * Causa raiz (corrigida): o Firebase re-emite onAuthStateChanged → o objeto
 * `user` era recriado → getProgress (useCallback [user]) mudava de referência →
 * o useEffect do form re-rodava e dava reset() de novo, zerando os campos.
 * Fix: callbacks de useWorkerApi dependem de `user?.id`; o fetch+reset roda 1x
 * por montagem (ref guard); autosave não persiste antes da hidratação.
 *
 * Este teste prova, no stack REAL (frontend + backend + Postgres), que os
 * campos carregam preenchidos e PERMANECEM preenchidos ao longo do tempo.
 *
 * Run: pnpm test:e2e:integration
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.describe('@integration Worker profile — campos não somem', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  async function login(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
  }

  test('campos carregam e PERMANECEM preenchidos (não somem após settle)', async ({ page }) => {
    // Worker totalmente preenchido no banco (insertEligibilityWorker default):
    // first_name='TestNombre', last_name='TestApellido', document_number='12345678'.
    const w = insertEligibilityWorker({ occupation: 'AT' });
    await login(page, w);

    await page.goto('/worker/profile?tab=general', { waitUntil: 'networkidle', timeout: 30_000 });

    const fullName = page.locator('#fullName');
    const lastName = page.locator('#lastName');
    const cpf = page.locator('#cpf');

    // 1) Campos carregam preenchidos do backend.
    await expect(fullName).toHaveValue('TestNombre', { timeout: 20_000 });
    await expect(lastName).toHaveValue('TestApellido');
    await expect(cpf).toHaveValue('12345678');

    // 2) O sintoma do bug era o sumiço APÓS a primeira pintura (re-fire do
    //    Firebase / segundo fetch). Aguardamos uma janela generosa e
    //    reafirmamos — se o reset re-rodasse, aqui estaria vazio.
    await page.waitForTimeout(3_000);
    await expect(fullName).toHaveValue('TestNombre');
    await expect(lastName).toHaveValue('TestApellido');
    await expect(cpf).toHaveValue('12345678');

    // 3) Prova visual: o card de Información General com os campos preenchidos.
    const card = page.locator('form').first();
    await expect(card).toHaveScreenshot('profile-general-fields-filled.png', {
      maxDiffPixels: 400,
      mask: [page.locator('#phone')], // telefone é randômico por execução
    });
  });

  test('trocar de aba e voltar mantém os campos preenchidos', async ({ page }) => {
    const w = insertEligibilityWorker({ occupation: 'AT' });
    await login(page, w);

    await page.goto('/worker/profile?tab=general', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.locator('#fullName')).toHaveValue('TestNombre', { timeout: 20_000 });

    // Vai para Documentos e volta para Geral (remonta a aba).
    await page.locator('[data-testid="tab-btn-documents"]').click();
    await expect(page.locator('[data-testid="tab-btn-documents"]')).toBeVisible();
    await page.locator('[data-testid="tab-btn-general"]').click();

    // Após remontar, os campos voltam preenchidos (fetch 1x por montagem).
    await expect(page.locator('#fullName')).toHaveValue('TestNombre', { timeout: 20_000 });
    await expect(page.locator('#lastName')).toHaveValue('TestApellido');
    await expect(page.locator('#cpf')).toHaveValue('12345678');
  });
});
