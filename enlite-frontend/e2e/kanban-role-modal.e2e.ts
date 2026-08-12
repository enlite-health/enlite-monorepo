/**
 * kanban-role-modal.e2e.ts  (projeto chromium-admin)
 *
 * Feature "Equipe Armada = quadro completo".
 *
 * Ao mover um card para SELECTED (selecionar o candidato), o Kanban abre um modal
 * perguntando se ele é TITULAR ou SUBSTITUTO (RAPID_RESPONSE). Essa classificação
 * alimenta a métrica de equipe armada do dashboard de gestão.
 *
 * Login: Firebase Auth REAL (enlite-prd) via UI. Backend mockado via page.route
 * (padrão chromium-admin) — nenhuma chamada real ao backend.
 *
 * Screenshot obrigatório via toHaveScreenshot() (requisito hard do CLAUDE.md).
 *
 * Run (1ª vez, gera baseline):
 *   pnpm exec playwright test --project=chromium-admin kanban-role-modal --update-snapshots
 */

import { test, expect, type Page, type Route } from '@playwright/test';
import {
  VACANCY_ID,
  emptyStages,
  loginAsAdmin,
  mockAdminBaseRoutes,
  ok,
} from './helpers/kanban-notes-e2e-helper';

const WJA_ID = 'wja-role-1';
const WORKER_ID = 'worker-role-1';
const ENCUADRE_ID = 'enc-role-1';

const funnelCard = {
  id: WJA_ID,
  encuadreId: ENCUADRE_ID,
  workerId: WORKER_ID,
  workerName: 'Lucía Benítez',
  workerPhone: '+5491144445555',
  occupation: 'AT',
  interviewDate: null,
  interviewTime: null,
  meetLink: null,
  interviewResponse: null,
  resultado: null,
  attended: null,
  rejectionReasonCategory: null,
  rejectionReason: null,
  matchScore: 9.1,
  talentumStatus: 'QUALIFIED',
  workZone: 'Belgrano',
  redireccionamiento: null,
  acquisitionChannel: null,
  internalStage: 'QUALIFIED',
  contactNotesCount: 0,
};

async function loginAndMock(page: Page): Promise<{ moved: unknown[] }> {
  const captured: unknown[] = [];
  await mockAdminBaseRoutes(page);

  // Funil com 1 card em COMPLETED (mostra o menu "Mover a…" com destino SELECTED).
  await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel`, (route: Route) => {
    const stages = emptyStages();
    stages.COMPLETED = [funnelCard];
    return route.fulfill(ok({ stages, totalEncuadres: 1 }));
  });

  // PUT move — captura o body (com role) e responde sucesso.
  await page.route(`**/api/admin/encuadres/${ENCUADRE_ID}/move`, (route: Route) => {
    if (route.request().method() === 'PUT') {
      captured.push(route.request().postDataJSON());
      return route.fulfill(ok({ encuadreId: ENCUADRE_ID, targetStage: 'SELECTED' }));
    }
    return route.continue();
  });

  await loginAsAdmin(page);
  return { moved: captured };
}

test.describe('Kanban — modal de papel ao selecionar (auth real)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('abrir "Mover a… → Seleccionados" pede Titular/Substituto e envia role', async ({ page }) => {
    const store = await loginAndMock(page);

    await page.addInitScript(
      ([key]) => window.localStorage.setItem(key, 'kanban'),
      [`vacancy-funnel-view-${VACANCY_ID}`],
    );

    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 20_000 });

    const card = page.locator(`[data-testid="kanban-card-${WJA_ID}"][data-stage]`).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Abre o menu "Mover a…" e escolhe Seleccionados.
    await card.locator('[data-testid="move-to-button"]').click();
    await card.locator('[data-testid="move-to-option-SELECTED"]').click();

    // Modal de papel aparece antes de mover.
    const roleModal = page.getByTestId('role-modal');
    await expect(roleModal).toBeVisible({ timeout: 10_000 });
    await expect(roleModal).toContainText(/Titular/i);

    // Screenshot de regressão do modal de papel.
    await expect(roleModal).toHaveScreenshot('kanban-role-modal.png', {
      maxDiffPixelRatio: 0.05,
    });

    // Confirma como Titular → PUT com role='TITULAR'.
    await page.getByTestId('role-option-titular').getByRole('radio').click();
    await page.getByTestId('role-confirm').click();

    await expect.poll(() => store.moved.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(store.moved[0]).toMatchObject({ targetStage: 'SELECTED', role: 'TITULAR' });
  });
});
