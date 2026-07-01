/**
 * worker-error-boundary.e2e.ts
 *
 * Testa o visual do RouteErrorBoundary via rota /__error-test (DEV-only).
 * Verifica:
 * - data-testid="route-error-boundary" está visível
 * - Botões "Recargar" e "Ir al inicio" estão visíveis
 * - Screenshot baseline do fallback amigável
 *
 * Nota: /__error-test é renderizado apenas quando import.meta.env.DEV=true,
 * que é sempre o caso no dev server (localhost:5173) usado pelos testes E2E mockados.
 */

import { test, expect } from '@playwright/test';

test.use({ storageState: 'e2e/.auth/profile-worker.json' });

test.describe('RouteErrorBoundary — fallback visual', () => {
  test.setTimeout(30000);

  test('exibe fallback amigável em /__error-test', async ({ page }) => {
    // Suprime erros de console esperados pelo throw proposital do CrashNow
    page.on('console', (msg) => {
      if (msg.type() === 'error') return;
    });

    await page.goto('/__error-test');
    await page.waitForLoadState('networkidle');

    // O boundary deve estar visível
    const boundary = page.getByTestId('route-error-boundary');
    await expect(boundary).toBeVisible({ timeout: 10000 });

    // Botão "Recargar" deve estar visível
    const reloadBtn = boundary.getByRole('button', { name: /recargar/i });
    await expect(reloadBtn).toBeVisible();

    // Botão "Ir al inicio" deve estar visível
    const homeBtn = boundary.getByRole('button', { name: /inicio/i });
    await expect(homeBtn).toBeVisible();

    // Screenshot baseline do fallback
    await expect(page).toHaveScreenshot('error-boundary-fallback.png', {
      maxDiffPixelRatio: 0.02,
    });
  });
});
