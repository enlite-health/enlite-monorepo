/** Render admin — /admin/vacancies/pending-address-review (Revisión de domicilios pendientes). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/vacancies/pending-address-review @depth:smoke] revisão de domicílios renderiza heading', async ({ page }) => {
  await page.goto('/admin/vacancies/pending-address-review');
  await expect(page.getByRole('heading', { name: 'Revisión de domicilios pendientes', exact: true })).toBeVisible();
});
