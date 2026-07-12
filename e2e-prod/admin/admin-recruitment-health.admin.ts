/** Render admin — /admin/recruitment/health (Salud del reclutamiento). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/recruitment/health @depth:smoke] saúde do recrutamento renderiza heading', async ({ page }) => {
  await page.goto('/admin/recruitment/health');
  await expect(page.getByRole('heading', { name: 'Salud del reclutamiento', exact: true })).toBeVisible();
});
