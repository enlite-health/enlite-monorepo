/** Render admin — /admin/patients (Pacientes). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/patients @depth:smoke] página de pacientes renderiza heading', async ({ page }) => {
  await page.goto('/admin/patients');
  await expect(page.getByRole('heading', { name: 'Pacientes', exact: true })).toBeVisible();
});
