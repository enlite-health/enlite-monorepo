/** Render admin — /admin/dashboard (Gestión a la Vista). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/dashboard @depth:smoke] dashboard de gestão renderiza heading', async ({ page }) => {
  await page.goto('/admin/dashboard');
  await expect(page.getByRole('heading', { name: 'Gestión a la Vista', exact: true })).toBeVisible();
});
