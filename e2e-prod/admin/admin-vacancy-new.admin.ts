/**
 * Render admin — /admin/vacancies/new. Read-only.
 *
 * Desde 26/09 a rota "Nueva" é um redirecionamento DELIBERADO para a lista (App.tsx:251). Quando a
 * rota "Nueva" voltar, este teste fica vermelho DE PROPÓSITO e deve voltar a cobrir o wizard.
 */
import { test, expect } from '@playwright/test';

test('[@route:/admin/vacancies/new @depth:smoke] "Nueva" redireciona para a lista de vagas, e a lista carrega', async ({ page }) => {
  await page.goto('/admin/vacancies/new');
  await expect(page, 'a rota "Nueva" leva à lista de vagas').toHaveURL(/\/admin\/vacancies\/?$/);
  await expect(
    page.getByRole('heading', { name: 'Vacantes - Solicitudes', exact: true }),
    'a lista de vagas carregou (não só a URL)',
  ).toBeVisible();
});
