/**
 * worker-home-progress-cta.integration.e2e.ts @integration
 *
 * CAMADA 0 — bug #1: o CTA "Enviar Documentos" do card de progresso na home
 * gerava `nextAction.route = '/worker/documents'`, uma rota que NÃO existe em
 * App.tsx — o catch-all devolvia pra '/', e a prestadora nunca chegava no
 * documento que faltava (useWorkerProfileProgress.ts:107-118, versão antiga).
 *
 * Prova de fluxo REAL: frontend real + backend real (USE_MOCK_AUTH=true) +
 * Postgres real. O worker é semeado no banco (fn_worker_missing_fields decide
 * a completude — SSOT), login via helper pass-through, e o clique navega de
 * verdade (sem page.route de dado).
 *
 * Pré-condições: docker (postgres + api desta worktree) + pnpm dev na porta
 * 5199. Run: PW_BASE_URL=http://localhost:5199 E2E_PG_CONTAINER=postulacao0-postgres
 * pnpm test:e2e:integration --grep "worker-home-progress-cta"
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.use({ video: 'on' }); // definição de pronto exige vídeo do fluxo real

test.describe('@integration Home — CTA do card de progresso', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  async function loginAndGoHome(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  }

  test('feliz — só falta documento: CTA leva direto a /worker/profile?tab=documents&focus=<docType> com o slot em destaque', async ({ page }) => {
    // Cadastro (etapas 1-3) completo, mas falta o DNI (identity_document).
    const w = insertEligibilityWorker({
      occupation: 'CAREGIVER',
      docIdentityDocument: false,
      docCriminalRecord: true,
    });
    await loginAndGoHome(page, w);

    const card = page.locator('[data-testid="profile-completion-card"]');
    await expect(card).toBeVisible({ timeout: 20_000 });

    const cta = card.getByRole('button', { name: 'Enviar Documentos' });
    await expect(cta).toBeVisible();
    await cta.click();

    await expect(page).toHaveURL(/\/worker\/profile\?tab=documents&focus=identity_document/, {
      timeout: 15_000,
    });

    const slot = page.locator('[data-testid="doc-slot-identity_document"]');
    await expect(slot).toBeVisible({ timeout: 15_000 });
    // Highlight transitório aplicado pelo WorkerProfilePage ao alvo do focus.
    await expect(slot).toHaveClass(/ring-2/, { timeout: 5_000 });

    await expect(slot).toHaveScreenshot('home-cta-doc-slot-highlighted.png', { maxDiffPixels: 200 });
  });

  test('alt — falta dado geral (telefone): CTA leva ao cadastro (rota existente /worker-registration → /worker/profile)', async ({ page }) => {
    const w = insertEligibilityWorker({
      occupation: 'CAREGIVER',
      phone: false,
    });
    await loginAndGoHome(page, w);

    const card = page.locator('[data-testid="profile-completion-card"]');
    await expect(card).toBeVisible({ timeout: 20_000 });

    const cta = card.getByRole('button', { name: 'Completar Registro' });
    await expect(cta).toBeVisible();
    await cta.click();

    // '/worker-registration' é hoje um alias (<Navigate to="/worker/profile" replace />)
    // — a prova é que a prestadora chega no cadastro, não numa rota morta.
    await expect(page).toHaveURL(/\/worker\/profile/, { timeout: 15_000 });
    await expect(page.locator('[data-testid="tab-btn-general"]')).toBeVisible({ timeout: 15_000 });
  });

  test('cadastro + documentos completos: card de progresso não aparece', async ({ page }) => {
    const w = insertEligibilityWorker({ occupation: 'CAREGIVER' }); // todos os campos/docs default=true
    await loginAndGoHome(page, w);

    await expect(page.locator('[data-testid="jobs-section"], #jobs-section')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="profile-completion-card"]')).toHaveCount(0);
  });
});
