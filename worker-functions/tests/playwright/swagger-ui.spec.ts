/**
 * Testes da UI Swagger — garante que /api/docs/ é navegável e intuitiva.
 *
 * "Intuitiva" aqui significa:
 *   - Tags agrupadas e visíveis na sidebar (operação por categoria)
 *   - Cada operação mostra summary + descrição visível ao expandir
 *   - Botão Authorize disponível
 *   - Filtro de busca funciona
 *   - Cadeado/indicador visual em rotas autenticadas
 *
 * Tem também um screenshot lock-in pra detectar regressões visuais.
 */

import { test, expect } from '@playwright/test';

test.describe('Swagger UI', () => {
  test('carrega e mostra o título da API', async ({ page }) => {
    await page.goto('/api/docs/');
    await expect(page).toHaveTitle(/Enlite worker-functions/i);

    const title = page.locator('.swagger-ui .info .title').first();
    await expect(title).toContainText(/Enlite worker-functions API/i);
  });

  test('mostra múltiplos grupos de tags na sidebar', async ({ page }) => {
    await page.goto('/api/docs/');
    await page.waitForSelector('.swagger-ui .opblock-tag', { timeout: 30000 });

    const tagBlocks = page.locator('.swagger-ui .opblock-tag');
    const count = await tagBlocks.count();

    // Esperamos pelo menos 20 grupos de tags renderizados
    expect(count).toBeGreaterThanOrEqual(20);
  });

  test('renderiza operações com summary e descrição visíveis', async ({ page }) => {
    await page.goto('/api/docs/');
    await page.waitForSelector('.swagger-ui .opblock', { timeout: 30000 });

    // Pega o primeiro opblock e checa summary
    const firstOp = page.locator('.swagger-ui .opblock').first();
    await expect(firstOp).toBeVisible();
    const summary = firstOp.locator('.opblock-summary-description, .opblock-summary-path__deprecated, .opblock-summary-path');
    await expect(summary.first()).toBeVisible();
  });

  test('botão Authorize está disponível', async ({ page }) => {
    await page.goto('/api/docs/');
    const authBtn = page.locator('.swagger-ui button.authorize').first();
    await expect(authBtn).toBeVisible({ timeout: 30000 });
  });

  test('filtro de busca por tag está visível', async ({ page }) => {
    await page.goto('/api/docs/');
    const filter = page.locator('.swagger-ui input.operation-filter-input');
    await expect(filter).toBeVisible({ timeout: 30000 });
    await expect(filter).toHaveAttribute('placeholder', /filter by tag/i);
  });

  test('rotas autenticadas mostram cadeado', async ({ page }) => {
    await page.goto('/api/docs/');
    await page.waitForSelector('.swagger-ui .opblock', { timeout: 30000 });

    // Swagger UI mostra um ícone de cadeado em operações com security
    const lockedOps = page.locator('.swagger-ui .opblock .authorization__btn');
    const count = await lockedOps.count();

    // A maior parte das rotas é autenticada; esperamos pelo menos 50 cadeados
    expect(count).toBeGreaterThanOrEqual(50);
  });

  test('expandir operação mostra description longa', async ({ page }) => {
    await page.goto('/api/docs/');
    await page.waitForSelector('.swagger-ui .opblock', { timeout: 30000 });

    const firstOp = page.locator('.swagger-ui .opblock').first();
    await firstOp.locator('.opblock-summary').first().click();

    const desc = firstOp.locator('.opblock-description, .opblock-description-wrapper').first();
    await expect(desc).toBeVisible({ timeout: 5000 });
    const text = await desc.innerText();
    expect(text.trim().length).toBeGreaterThan(20);
  });

  test('snapshot visual da página inicial', async ({ page }) => {
    await page.goto('/api/docs/');
    await page.waitForSelector('.swagger-ui .opblock-tag', { timeout: 30000 });

    // Aguarda fontes e CSS aplicarem
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Esconde elementos voláteis (timestamps no description, etc.)
    await page.addStyleTag({
      content: `
        .swagger-ui .info .info__contact { visibility: hidden !important; }
      `,
    });

    await expect(page).toHaveScreenshot('swagger-ui-home.png', {
      fullPage: false,
      animations: 'disabled',
    });
  });
});
