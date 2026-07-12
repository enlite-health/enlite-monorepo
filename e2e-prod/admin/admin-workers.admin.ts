/** Render admin — /admin/workers (Prestadores). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/workers @depth:smoke] página de prestadores renderiza heading', async ({ page }) => {
  await page.goto('/admin/workers');
  await expect(page.getByRole('heading', { name: 'Prestadores', exact: true })).toBeVisible();
});
