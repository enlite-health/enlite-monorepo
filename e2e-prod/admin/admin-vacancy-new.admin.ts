/** Render admin — /admin/vacancies/new (Nueva Vacante). Read-only: só renderiza o form, não submete. */
import { test, expect } from '@playwright/test';

test('[@route:/admin/vacancies/new @depth:smoke] criação de vaga renderiza heading', async ({ page }) => {
  await page.goto('/admin/vacancies/new');
  await expect(page.getByRole('heading', { name: 'Nueva Vacante', exact: true })).toBeVisible();
});
