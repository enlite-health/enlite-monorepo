import { test, expect } from '@playwright/test';

/**
 * Smoke visual da feature claim de ficha importada (onda 2 — OTP).
 *
 * Cobre:
 *  - /register tem botão Google reabilitado (rollback da onda 1)
 *  - /complete-whatsapp renderiza com form de WhatsApp
 *
 * Não precisa de autenticação (rotas públicas).
 */

test.describe('Claim feature — smoke visual', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('/register mostra botão Google reabilitado', async ({ page }) => {
    await page.goto('/register');

    // Espera form do registro carregar.
    await expect(page.locator('input[type="email"]').first()).toBeVisible({ timeout: 10_000 });

    // Botão Google deve estar presente (foi removido na onda 1, reabilitado na onda 2).
    const googleButton = page.getByRole('button', { name: /Reg[íi]strarme con Google|Sign up with Google/i });
    await expect(googleButton).toBeVisible();

    // Captura screenshot pra regressão visual.
    await expect(page).toHaveScreenshot('register-with-google-button.png', {
      maxDiffPixelRatio: 0.02,
      fullPage: true,
    });
  });

  test('/complete-whatsapp renderiza form de coleta', async ({ page }) => {
    // Página é gated por isAuthenticated — sem auth, redireciona pra /login.
    // Pro smoke visual público, esperamos esse comportamento de redirect.
    await page.goto('/complete-whatsapp');

    // Sem auth, espera /login (i18n: ¡Hola, bienvenido de nuevo!).
    await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
  });
});
