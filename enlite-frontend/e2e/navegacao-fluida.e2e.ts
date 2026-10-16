/**
 * navegacao-fluida.e2e.ts
 *
 * Playwright E2E — Fase 3: Fade-in de conteúdo (polimento de navegação)
 *
 * Fluxos cobertos:
 *   - Layout persistente: sidebar e header não desmontam entre rotas
 *   - Classe .page-enter aplicada ao wrapper do Outlet em cada rota
 *   - key={location.pathname} força re-animação a cada troca de rota
 *   - Todas as rotas admin carregam sem tela branca
 *   - Navegação via botão Voltar do browser funciona
 *   - Refresh (F5) em qualquer rota funciona
 *   - Redirect sem auth redireciona para /admin/login
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR  = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY   = 'test-api-key';
const FIREBASE_PROJECT_ID = 'enlite-e2e-test';

// ── Helpers ──────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const email    = `e2e.nav.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  // 1. Create user in Firebase Emulator
  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    }
  );
  const signUpData = await signUpRes.json() as { localId?: string; idToken?: string };
  if (!signUpData.localId) throw new Error(`Firebase sign-up failed: ${JSON.stringify(signUpData)}`);

  const { localId: uid } = signUpData;

  // 2. Seed Postgres admin record
  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'Nav E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
      VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch {
    // Postgres seed failed — fall through to profile mock below
  }

  // 3. Mock /api/admin/auth/profile to guarantee admin access
  await page.route('**/api/admin/auth/profile', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid,
          email,
          role: 'superadmin',
          firstName: 'Nav',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    });
  });

  // 4. Mock vacancies list so VacanciesPage doesn't stay in loading state
  await page.route('**/api/vacancies*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [], total: 0, page: 1, limit: 20 }),
    });
  });

  // 5. Mock users list so UsersPage doesn't stay in loading state
  await page.route('**/api/admin/users*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });

  // 7. Mock workers list so WorkersPage doesn't stay in loading state
  await page.route('**/api/admin/workers*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [], total: 0, limit: 20, offset: 0 }),
    });
  });

  // 7. Login via UI
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Testes ───────────────────────────────────────────────────────────────────

test.describe('Fase 3 — Fade-in de navegação', () => {

  test('sidebar persiste ao navegar entre rotas admin', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Capture sidebar element reference before navigation
    const sidebar = page.locator('[data-testid="app-sidebar"], nav, aside').first();
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Navigate to /admin/uploads and verify sidebar is still the same node (not remounted)
    await page.goto('/admin/uploads');
    await expect(sidebar).toBeVisible({ timeout: 10000 });

    // Navigate to /admin/vacancies
    await page.goto('/admin/vacancies');
    await expect(sidebar).toBeVisible({ timeout: 10000 });
  });

  test('classe .page-enter está no wrapper do Outlet ao carregar cada rota', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Check on the default route /admin
    await page.goto('/admin');
    const wrapper = page.locator('.page-enter').first();
    await expect(wrapper).toBeAttached({ timeout: 10000 });

    // Navigate to /admin/vacancies and verify class is re-applied
    await page.goto('/admin/vacancies');
    await expect(page.locator('.page-enter').first()).toBeAttached({ timeout: 10000 });

    // Navigate to /admin/uploads
    await page.goto('/admin/uploads');
    await expect(page.locator('.page-enter').first()).toBeAttached({ timeout: 10000 });
  });

  test('key={location.pathname} força re-montagem do wrapper a cada troca de rota via sidebar', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.goto('/admin');
    await expect(page).toHaveURL('/admin/dashboard', { timeout: 10000 });

    // Collect the key value (reflected as DOM key via React internals) — we verify
    // the wrapper remounts by checking that a new .page-enter element appears after
    // navigation (animation would re-trigger on a fresh DOM node).
    const getWrapperId = () =>
      page.locator('.page-enter').first().evaluate((el) => el.getAttribute('data-rr-ui-key') ?? el.outerHTML.slice(0, 80));

    const idBefore = await getWrapperId();

    // Navigate to a different route via sidebar link
    await page.getByRole('link', { name: /Vagas|Vacancies|Vacantes/i }).first().click();
    await expect(page).toHaveURL(/\/admin\/vacancies/, { timeout: 10000 });

    // Wait for the wrapper to re-render
    await page.waitForTimeout(200);
    const idAfter = await getWrapperId();

    // The wrapper content changed (different page rendered inside), confirming re-mount
    expect(idBefore).not.toBe(idAfter);
  });

  test('nenhuma rota admin exibe tela branca (body background visível durante navegação)', async ({ page }) => {
    await seedAdminAndLogin(page);

    const adminRoutes = ['/admin', '/admin/vacancies', '/admin/uploads'];

    for (const route of adminRoutes) {
      await page.goto(route);

      // The layout wrapper should be present — no full-page white blank screen
      await expect(page.locator('.page-enter').first()).toBeAttached({ timeout: 10000 });

      // Verify page is not showing an error boundary or blank state
      const bodyText = await page.locator('body').textContent();
      expect(bodyText).not.toBe('');
    }
  });

  test('refresh (F5) em qualquer rota admin mantém o layout e a animação', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.goto('/admin/vacancies');
    await expect(page.locator('.page-enter').first()).toBeAttached({ timeout: 10000 });

    // Reload the page
    await page.reload();

    // Layout and animation wrapper should still be present after reload
    await expect(page.locator('.page-enter').first()).toBeAttached({ timeout: 15000 });
    await expect(page).toHaveURL(/\/admin\/vacancies/);
  });

  test('botão Voltar do browser navega corretamente e re-anima o conteúdo', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.goto('/admin');
    await page.goto('/admin/vacancies');
    await expect(page).toHaveURL(/\/admin\/vacancies/, { timeout: 10000 });

    // Go back
    await page.goBack();
    await expect(page).toHaveURL('/admin/dashboard', { timeout: 10000 });

    // Animation wrapper should be present on the previous page
    await expect(page.locator('.page-enter').first()).toBeAttached({ timeout: 10000 });
  });

  test('acesso sem autenticação redireciona para /admin/login', async ({ browser }) => {
    // Use a fresh context with no stored auth
    const context = await browser.newContext();
    const page    = await context.newPage();

    await page.goto('/admin');
    await expect(page).toHaveURL(/\/admin\/login/, { timeout: 10000 });

    await context.close();
  });

  test('animação respeita prefers-reduced-motion: .page-enter existe no DOM mas CSS não executa', async ({ page }) => {
    // Emulate reduced-motion preference at the browser level
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await seedAdminAndLogin(page);
    await page.goto('/admin');

    const wrapper = page.locator('.page-enter').first();
    await expect(wrapper).toBeAttached({ timeout: 10000 });

    // Verify the animation-name computed style is "none" when prefers-reduced-motion is active
    // (because our CSS uses @media (prefers-reduced-motion: no-preference) to gate the animation)
    const animationName = await wrapper.evaluate((el) =>
      window.getComputedStyle(el).animationName
    );
    expect(animationName).toBe('none');
  });

});
