/** Render admin — /admin/vacancies (Vacantes - Solicitudes). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/vacancies @depth:smoke] página de vagas renderiza heading', async ({ page }) => {
  await page.goto('/admin/vacancies');
  await expect(page.getByRole('heading', { name: 'Vacantes - Solicitudes', exact: true })).toBeVisible();
});
