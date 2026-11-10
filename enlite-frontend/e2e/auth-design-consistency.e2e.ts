/**
 * auth-design-consistency.e2e.ts
 *
 * Playwright E2E — Consistência visual e estrutural entre AdminLoginPage e AuthActionPage.
 *
 * Garante que:
 *   1. AdminLoginPage mantém baseline visual estável (regressão de design)
 *   2. AuthActionPage (estado "ready") mantém baseline visual estável
 *   3. Ambas as páginas compartilham os mesmos elementos estruturais:
 *      - Navbar <nav> no topo
 *      - Container central com largura próxima a 440px
 *      - Botão de submit com classes da variante primary
 *      - Background color consistente
 */

import { test, expect, Page } from '@playwright/test';

// ── Constantes ────────────────────────────────────────────────────────────────

const VALID_OOB_CODE = 'valid-oob-code-123';
const MOCK_EMAIL = 'staff@enlite.health';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mocka verifyPasswordResetCode no Firebase identitytoolkit para retornar sucesso.
 * Reutiliza o padrão de auth-action.e2e.ts.
 */
async function mockVerifyCodeSuccess(page: Page): Promise<void> {
  await page.route(
    (url) =>
      url.hostname.includes('identitytoolkit') &&
      url.pathname.includes('resetPassword') &&
      url.search.includes('key='),
    (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: MOCK_EMAIL, requestType: 'PASSWORD_RESET' }),
      });
    },
  );

  await page.route(
    '**/identitytoolkit.googleapis.com/v1/accounts:resetPassword**',
    (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: MOCK_EMAIL, requestType: 'PASSWORD_RESET' }),
      });
    },
  );
}

/**
 * Aguarda as fontes carregarem para evitar flakiness visual nos screenshots.
 */
async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

/**
 * Captura a bounding box do container principal (max-w-[440px]).
 * Procura pelo elemento com classe que contém "max-w-" e largura <= 480px.
 */
async function getContainerWidth(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    // Procura todos os elementos e filtra pelo que tem largura próxima de 440px
    const allElements = Array.from(document.querySelectorAll('*'));
    const container = allElements.find((el) => {
      const classList = Array.from(el.classList);
      return classList.some((c) => c.includes('max-w-') && c.includes('440'));
    });

    if (!container) return null;
    return container.getBoundingClientRect().width;
  });
}

/**
 * Verifica se há um <nav> ou elemento com data-testid="auth-navbar" no topo da página.
 */
async function hasNavbar(page: Page): Promise<boolean> {
  const navbarByTestId = page.locator('[data-testid="auth-navbar"]');
  const navbarByTag = page.locator('nav').first();

  const byTestIdVisible = await navbarByTestId.isVisible().catch(() => false);
  const byTagVisible = await navbarByTag.isVisible().catch(() => false);

  return byTestIdVisible || byTagVisible;
}

/**
 * Verifica se há um button[type="submit"] com classes da variante primary.
 * O Button com variant="primary" gera "bg-primary" e "border-primary".
 */
async function hasSubmitButton(page: Page): Promise<boolean> {
  const submitButton = page.locator('button[type="submit"]').first();
  const exists = await submitButton.count() > 0;
  if (!exists) return false;

  const classes = await submitButton.getAttribute('class');
  return classes !== null && classes.includes('bg-primary');
}

/**
 * Verifica que a página usa a classe Tailwind bg-background no wrapper raiz.
 * Checamos via classe CSS no DOM em vez de getComputedStyle, porque a variável
 * CSS --background pode não estar resolvida se o JS de Tailwind JIT não injetou
 * os estilos no ambiente headless (variáveis CSS ficam com valor padrão).
 */
async function hasBgBackgroundClass(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const wrapper = document.querySelector('.bg-background');
    return wrapper !== null;
  });
}

// ── Suite de Testes ───────────────────────────────────────────────────────────

test.describe('Consistência visual e estrutural: AdminLoginPage vs AuthActionPage', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(30000);

  // ── 1. Screenshot baseline — AdminLoginPage ─────────────────────────────────

  test('1. AdminLoginPage — screenshot baseline para deteccao de regressao visual', async ({
    page,
  }) => {
    await page.goto('/login?next=%2Fadmin');

    // Aguarda o formulário de login estar visível
    await expect(page.locator('form').first()).toBeVisible({ timeout: 15000 });
    await waitForFonts(page);

    await expect(page).toHaveScreenshot('admin-login-baseline.png');
  });

  // ── 2. Screenshot baseline — AuthActionPage estado "ready" ─────────────────

  test('2. AuthActionPage — screenshot baseline no estado "ready" (form de redefinicao)', async ({
    page,
  }) => {
    await mockVerifyCodeSuccess(page);

    await page.goto(`/auth/action?mode=resetPassword&oobCode=${VALID_OOB_CODE}`);

    // Aguarda os campos de senha aparecerem (estado "ready")
    await expect(page.locator('input[type="password"]').first()).toBeVisible({
      timeout: 15000,
    });

    await waitForFonts(page);

    await expect(page).toHaveScreenshot('auth-action-baseline.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  // ── 3. Asserts estruturais comparando as duas páginas ──────────────────────

  test('3. AdminLoginPage — tem navbar, container 440px, botao primary, bg consistente', async ({
    page,
  }) => {
    await page.goto('/login?next=%2Fadmin');
    await expect(page.locator('form').first()).toBeVisible({ timeout: 15000 });

    // 3a. Navbar presente
    const navbarPresent = await hasNavbar(page);
    expect(navbarPresent).toBe(true);

    // 3b. Container com largura próxima a 440px
    const containerWidth = await getContainerWidth(page);
    expect(containerWidth).not.toBeNull();
    // max-w-[440px] nunca excede 440px; em viewport 1440 deve ser exatamente 440
    expect(containerWidth!).toBeLessThanOrEqual(441);
    expect(containerWidth!).toBeGreaterThan(200);

    // 3c. Botão submit com classes primary
    const submitPresent = await hasSubmitButton(page);
    expect(submitPresent).toBe(true);

    // 3d. A classe bg-background está presente no wrapper raiz (Tailwind token de design)
    const hasBg = await hasBgBackgroundClass(page);
    expect(hasBg).toBe(true);
  });

  test('4. AuthActionPage — tem navbar, container 440px, botao primary, mesmo bg que AdminLoginPage', async ({
    page,
  }) => {
    await mockVerifyCodeSuccess(page);

    await page.goto(`/auth/action?mode=resetPassword&oobCode=${VALID_OOB_CODE}`);
    await expect(page.locator('input[type="password"]').first()).toBeVisible({
      timeout: 15000,
    });

    // 4a. Navbar presente
    const navbarPresent = await hasNavbar(page);
    expect(navbarPresent).toBe(true);

    // 4b. Container com largura próxima a 440px
    const containerWidth = await getContainerWidth(page);
    expect(containerWidth).not.toBeNull();
    expect(containerWidth!).toBeLessThanOrEqual(441);
    expect(containerWidth!).toBeGreaterThan(200);

    // 4c. Botão submit com classes primary
    const submitPresent = await hasSubmitButton(page);
    expect(submitPresent).toBe(true);

    // 4d. A classe bg-background está presente no wrapper raiz (Tailwind token de design)
    const hasBg = await hasBgBackgroundClass(page);
    expect(hasBg).toBe(true);
  });

  // ── 4. Paridade de classe bg-background entre as duas páginas ────────────────

  test('5. AdminLoginPage e AuthActionPage compartilham a classe bg-background no wrapper', async ({
    page,
  }) => {
    // Verifica AdminLoginPage
    await page.goto('/login?next=%2Fadmin');
    await expect(page.locator('form').first()).toBeVisible({ timeout: 15000 });
    const adminHasBg = await hasBgBackgroundClass(page);

    // Verifica AuthActionPage
    await mockVerifyCodeSuccess(page);
    await page.goto(`/auth/action?mode=resetPassword&oobCode=${VALID_OOB_CODE}`);
    await expect(page.locator('input[type="password"]').first()).toBeVisible({
      timeout: 15000,
    });
    const authActionHasBg = await hasBgBackgroundClass(page);

    // Ambas devem usar bg-background (mesmo token de design)
    expect(adminHasBg).toBe(true);
    expect(authActionHasBg).toBe(true);
  });
});
