/**
 * kanban-column-collapse.e2e.ts  (projeto chromium-admin)
 *
 * Feature: colunas do Kanban colapsáveis num trilho fino (estilo ClickUp), com
 * a largura animada (transition-all/duration-300) e estado persistido por vaga
 * no localStorage (`kanban-collapsed-${vacancyId}`).
 *
 * Login: Firebase Auth REAL (enlite-prd) via UI. Backend mockado via page.route
 * (padrão do projeto chromium-admin).
 *
 * Screenshot obrigatório via toHaveScreenshot() — requisito hard de CLAUDE.md.
 * Prova: (1) board expandido, (2) coluna colapsada vira trilho vertical com
 * contagem + título, (3) reexpande clicando no trilho.
 */
import { test, expect, type Route } from '@playwright/test';
import {
  VACANCY_ID,
  emptyStages,
  loginAsAdmin,
  mockAdminBaseRoutes,
  ok,
  type ContactNote,
} from './helpers/kanban-notes-e2e-helper';

function card(over: Record<string, unknown>) {
  return {
    id: 'x', encuadreId: null, workerId: null, workerName: 'María García',
    workerPhone: '+5491122223333', occupation: 'AT', interviewDate: null, interviewTime: null,
    meetLink: null, interviewResponse: null, resultado: null, attended: null,
    rejectionReasonCategory: null, rejectionReason: null, matchScore: 90, talentumStatus: null,
    workZone: 'Palermo', redireccionamiento: null, acquisitionChannel: null, internalStage: null,
    isBlocked: false, contactNotesCount: 0, ...over,
  };
}

test.describe('Kanban — colunas colapsáveis (trilho estilo ClickUp, auth real)', () => {
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1680, height: 1000 } });

  test('colapsa uma coluna em trilho, persiste, e reexpande clicando', async ({ page }) => {
    await mockAdminBaseRoutes(page);

    const stages = emptyStages();
    stages.INVITED = [card({ id: 'a', encuadreId: 'ea', workerId: 'wa', workerName: 'María García' })];
    stages.COMPLETED = [card({ id: 'b', encuadreId: 'eb', workerId: 'wb', workerName: 'Carlos Díaz' })];
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/funnel`, (r: Route) =>
      r.fulfill(ok({ stages, totalEncuadres: 2 })));
    await page.route(`**/api/admin/vacancies/${VACANCY_ID}/workers/*/contact-notes`, (r: Route) =>
      r.fulfill(ok([] as ContactNote[])));

    await loginAsAdmin(page);
    await page.addInitScript(
      ([k]) => window.localStorage.setItem(k, 'kanban'),
      [`vacancy-funnel-view-${VACANCY_ID}`],
    );
    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 20_000 });

    const board = page.locator('[data-testid="kanban-board"]').first();
    await board.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);

    // Estado expandido — todas as colunas com o botão de colapsar disponível.
    const invited = page.locator('[data-testid="kanban-column-INVITED"]');
    await expect(invited).not.toHaveAttribute('data-collapsed', 'true');
    await expect(board).toHaveScreenshot('kanban-columns-expanded.png', { maxDiffPixelRatio: 0.02 });

    // Colapsa "Invitados" → vira trilho fino (data-collapsed) mantendo a contagem.
    await page.getByTestId('kanban-column-INVITED-collapse').click();
    await page.waitForTimeout(500); // deixa a transição de largura (300ms) assentar
    await expect(invited).toHaveAttribute('data-collapsed', 'true');
    await expect(page.getByTestId('kanban-column-INVITED-count')).toBeVisible();
    await expect(board).toHaveScreenshot('kanban-column-collapsed.png', { maxDiffPixelRatio: 0.02 });

    // Persistência por vaga no localStorage.
    const persisted = await page.evaluate((id) => window.localStorage.getItem(`kanban-collapsed-${id}`), VACANCY_ID);
    expect(persisted).toContain('INVITED');

    // Reexpande clicando no próprio trilho.
    await invited.click();
    await page.waitForTimeout(500);
    await expect(invited).not.toHaveAttribute('data-collapsed', 'true');
    await expect(board).toHaveScreenshot('kanban-columns-expanded.png', { maxDiffPixelRatio: 0.02 });
  });
});
