/**
 * Render admin — /admin (Usuarios Administradores). Read-only: navega e assere o heading.
 * Reusa a sessão de admin.setup (storageState). Se a conta não estiver promovida a admin,
 * o AdminProtectedRoute redireciona pra /admin/login e o heading não aparece (falha esperada
 * até promoção).
 */
import { test, expect } from '@playwright/test';

test('[@route:/admin @depth:smoke] página de usuários renderiza heading', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Usuarios Administradores', exact: true })).toBeVisible();
});
