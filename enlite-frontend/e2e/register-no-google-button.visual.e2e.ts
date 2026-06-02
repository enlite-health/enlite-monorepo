/**
 * register-no-google-button.visual.e2e.ts
 *
 * Playwright E2E — Testes visuais Onda 2:
 *   1. /register exibe o botão Google (reabilitado na Onda 2 com fluxo /complete-whatsapp)
 *   2. /register ainda renderiza o formulário de email+senha normalmente
 *   3. /login continua exibindo o botão Google (regressão)
 *
 * Contexto: Onda 1 removeu o botão Google temporariamente para evitar duplicados.
 * Onda 2 reabilita com redirecionamento para /complete-whatsapp após Google login,
 * onde o usuário fornece WhatsApp para claim reconciliation via OTP.
 */

import { test, expect, Page } from '@playwright/test';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function gotoPage(page: Page, path: string, awaitSelector: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator(awaitSelector)).toBeVisible({ timeout: 10_000 });
  // Aguarda as fontes para evitar flakiness de texto em screenshots
  await page.evaluate(() => document.fonts.ready);
}

// ── Testes ────────────────────────────────────────────────────────────────────

test.describe('RegisterPage — Onda 2 com botao Google reabilitado', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  // ── Teste 1: /register exibe botão Google (Onda 2 reabilitou) ────────────────

  test('1. /register exibe botao Google e divisor "o registrarse con"', async ({ page }) => {
    await gotoPage(page, '/register', 'form');

    // Botão Google deve estar presente
    const googleBtn = page.locator('button', { hasText: /google/i });
    await expect(googleBtn).toBeVisible({ timeout: 5_000 });

    // Divisor "o registrarse con" deve estar presente
    const divider = page.locator('text=/registrarse con/i');
    await expect(divider).toBeVisible();

    // Screenshot de regressão: formulário com botão Google presente (Onda 2)
    const form = page.locator('form');
    await expect(form).toHaveScreenshot('register-form-no-google-button.png');
  });

  // ── Teste 2: /register ainda tem o botão "Registrarse" de email+senha ────────

  test('2. /register ainda exibe o botao de submit do formulario email+senha', async ({ page }) => {
    await gotoPage(page, '/register', 'form');

    const submitBtn = page.locator('button[type="submit"]');
    await expect(submitBtn).toBeVisible();

    await expect(page.locator('input#email')).toBeVisible();
    await expect(page.locator('input#password')).toBeVisible();
    await expect(page.locator('input#confirmPassword')).toBeVisible();
  });

  // ── Teste 3: /login ainda exibe o botão Google (regressão) ───────────────────

  test('3. /login ainda exibe o botao Google (sem regressao)', async ({ page }) => {
    await gotoPage(page, '/login', 'form');

    const googleBtn = page.locator('button', { hasText: /google/i });
    await expect(googleBtn).toBeVisible({ timeout: 5_000 });

    const form = page.locator('form');
    await expect(form).toHaveScreenshot('login-form-with-google-button.png');
  });
});
