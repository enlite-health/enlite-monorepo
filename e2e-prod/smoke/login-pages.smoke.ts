/**
 * Smoke — telas de login renderizam (sem submeter — não há credenciais na Camada 1).
 *
 * Front é i18n ES: labels em espanhol ("Correo electrónico", "Contraseña",
 * "Iniciar sesión"). READ-ONLY: só valida que os campos e o botão estão visíveis;
 * NÃO digita, NÃO submete (evita qualquer efeito colateral em prod).
 */
import { test, expect } from '@playwright/test';

test('[@route:/login] tela de login do worker mostra email, senha e submit', async ({ page }) => {
  await page.goto('/login');

  // getByLabel usa a associação FormField(label) ↔ input#id (htmlFor).
  await expect(page.getByLabel('Correo electrónico', { exact: true })).toBeVisible();
  // exact: senão casa também o botão "Mostrar contraseña" (aria-label contém "contraseña").
  await expect(page.getByLabel('Contraseña', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
});

test('[@route:/admin/login] tela de login admin renderiza campos e botão', async ({ page }) => {
  await page.goto('/admin/login');

  // Admin login reusa FormField com os mesmos labels ES (id admin-email/admin-password).
  await expect(page.getByLabel('Correo electrónico', { exact: true })).toBeVisible();
  // exact: senão casa também o botão "Mostrar contraseña" (aria-label contém "contraseña").
  await expect(page.getByLabel('Contraseña', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Iniciar sesión' })).toBeVisible();
});
