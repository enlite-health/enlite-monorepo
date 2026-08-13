/** Render admin — /admin/tags (Etiquetas). Read-only. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/tags @depth:smoke] catálogo de etiquetas renderiza heading', async ({ page }) => {
  await page.goto('/admin/tags');
  await expect(page.getByRole('heading', { name: 'Etiquetas', exact: true })).toBeVisible();
});
