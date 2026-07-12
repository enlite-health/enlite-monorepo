/** Render admin — /admin/recruitment/blocked-attempts (Intentos de postulación bloqueados). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/recruitment/blocked-attempts @depth:smoke] tentativas bloqueadas renderiza heading', async ({ page }) => {
  await page.goto('/admin/recruitment/blocked-attempts');
  await expect(page.getByRole('heading', { name: 'Intentos de postulación bloqueados', exact: true })).toBeVisible();
});
