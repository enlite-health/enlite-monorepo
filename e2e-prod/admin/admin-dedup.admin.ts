/** Render admin — /admin/dedup (Centro de Duplicados). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/dedup @depth:smoke] centro de duplicados renderiza heading', async ({ page }) => {
  await page.goto('/admin/dedup');
  await expect(page.getByRole('heading', { name: 'Centro de Duplicados', exact: true })).toBeVisible();
});
