/** Render admin — /admin/recruitment (Dashboard de Reclutamiento). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/recruitment @depth:smoke] dashboard de recrutamento renderiza heading', async ({ page }) => {
  await page.goto('/admin/recruitment');
  await expect(page.getByRole('heading', { name: 'Dashboard de Reclutamiento', exact: true })).toBeVisible();
});
