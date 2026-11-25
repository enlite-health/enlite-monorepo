/**
 * auth-action.e2e.ts
 *
 * Playwright E2E — Testes visuais para a página /auth/action (Set Password / Password Reset).
 *
 * Mockeia as chamadas ao Firebase identitytoolkit para simular os estados:
 *   1. Verificando (spinner)                → screenshot
 *   2. Form pronto (link válido)            → screenshot
 *   3. Erro de link expirado/inválido       → screenshot
 *   4. Modo não suportado                   → screenshot
 */

import { test, expect, Page } from '@playwright/test';

// ── Constantes ────────────────────────────────────────────────────────────────

const VALID_OOB_CODE = 'valid-oob-code-123';
const EXPIRED_OOB_CODE = 'expired-oob-code-456';
const MOCK_EMAIL = 'staff@enlite.health';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mock de verifyPasswordResetCode: retorna email ou erro.
 */
async function mockVerifyCode(
  page: Page,
  oobCode: string,
  result: 'success' | 'expired',
): Promise<void> {
  await page.route(
    (url) =>
      url.hostname.includes('identitytoolkit') &&
      url.pathname.includes('resetPassword') &&
      url.search.includes('key='),
    (route) => {
      if (result === 'success') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: MOCK_EMAIL, requestType: 'PASSWORD_RESET' }),
        });
      } else {
        route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'EXPIRED_OOB_CODE' } }),
        });
      }
    },
  );

  // Alternativa: mock via fetch POST genérico ao identitytoolkit
  await page.route(
    '**/identitytoolkit.googleapis.com/v1/accounts:resetPassword**',
    (route) => {
      const postData = route.request().postDataJSON() as { oobCode?: string } | null;
      const code = postData?.oobCode ?? '';

      if (code === oobCode && result === 'success') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: MOCK_EMAIL, requestType: 'PASSWORD_RESET' }),
        });
      } else {
        route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'EXPIRED_OOB_CODE' } }),
        });
      }
    },
  );
}

/**
 * Mock de confirmPasswordReset e signInWithEmailAndPassword para submit bem-sucedido.
 */
async function mockConfirmAndSignIn(page: Page, role: string): Promise<void> {
  // confirmPasswordReset
  await page.route(
    '**/identitytoolkit.googleapis.com/v1/accounts:resetPassword**',
    (route) => {
      const postData = route.request().postDataJSON() as { newPassword?: string } | null;
      if (postData?.newPassword) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: MOCK_EMAIL }),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ email: MOCK_EMAIL, requestType: 'PASSWORD_RESET' }),
        });
      }
    },
  );

  // signInWithEmailAndPassword
  await page.route(
    '**/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword**',
    (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          idToken: 'mock-id-token',
          email: MOCK_EMAIL,
          localId: 'mock-uid-123',
          registered: true,
        }),
      });
    },
  );

  // getIdTokenResult / token refresh
  await page.route(
    '**/identitytoolkit.googleapis.com/v1/accounts:lookup**',
    (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          users: [
            {
              localId: 'mock-uid-123',
              email: MOCK_EMAIL,
              customAttributes: JSON.stringify({ role }),
            },
          ],
        }),
      });
    },
  );
}

// ── Testes Visuais ────────────────────────────────────────────────────────────

test.describe('AuthActionPage — testes visuais', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(30000);

  // ── Estado 1: Form pronto (link válido) ────────────────────────────────────

  test('1. form de redefinição de senha exibido quando oobCode é válido', async ({ page }) => {
    await mockVerifyCode(page, VALID_OOB_CODE, 'success');

    await page.goto(`/auth/action?mode=resetPassword&oobCode=${VALID_OOB_CODE}`);

    // Aguarda o spinner sumir e o form aparecer
    await expect(page.locator('input[type="password"]').first()).toBeVisible({
      timeout: 15000,
    });

    // Aguarda fontes para evitar flakiness
    await page.evaluate(() => document.fonts.ready);

    // Screenshot do estado "form pronto"
    await expect(page).toHaveScreenshot('auth-action-form-ready.png');
  });

  // ── Estado 2: Erro de link expirado/inválido ────────────────────────────────

  test('2. card de erro exibido quando oobCode é expirado', async ({ page }) => {
    await mockVerifyCode(page, EXPIRED_OOB_CODE, 'expired');

    await page.goto(`/auth/action?mode=resetPassword&oobCode=${EXPIRED_OOB_CODE}`);

    // Aguarda card de erro aparecer
    await expect(
      page.getByText('auth.action.linkInvalid'),
    ).toBeVisible({ timeout: 15000 });

    await page.evaluate(() => document.fonts.ready);

    // Screenshot do estado "link expirado"
    await expect(page).toHaveScreenshot('auth-action-link-expired.png');
  });

  // ── Estado 3: Modo não suportado ───────────────────────────────────────────

  test('3. card de erro exibido quando mode nao é resetPassword', async ({ page }) => {
    await page.goto('/auth/action?mode=verifyEmail&oobCode=someCode');

    await expect(
      page.getByText('auth.action.unsupportedMode'),
    ).toBeVisible({ timeout: 10000 });

    await page.evaluate(() => document.fonts.ready);

    // Screenshot do estado "modo não suportado"
    await expect(page).toHaveScreenshot('auth-action-unsupported-mode.png');
  });

  // ── Validação do formulário ─────────────────────────────────────────────────

  test('4. erro de validacao quando senhas nao coincidem', async ({ page }) => {
    await mockVerifyCode(page, VALID_OOB_CODE, 'success');

    await page.goto(`/auth/action?mode=resetPassword&oobCode=${VALID_OOB_CODE}`);

    await expect(page.locator('input[type="password"]').first()).toBeVisible({
      timeout: 15000,
    });

    // Preenche com senhas diferentes
    const inputs = page.locator('input[type="password"]');
    await inputs.nth(0).fill('Password123!');
    await inputs.nth(1).fill('Different123!');

    // Submete
    await page.getByRole('button', { name: /auth\.action\.submit/i }).click();

    // Aguarda mensagem de erro
    await expect(
      page.getByText('auth.action.passwordMismatch'),
    ).toBeVisible({ timeout: 5000 });

    await page.evaluate(() => document.fonts.ready);

    // Screenshot do estado com erro de validação
    await expect(page).toHaveScreenshot('auth-action-validation-error.png');
  });
});
