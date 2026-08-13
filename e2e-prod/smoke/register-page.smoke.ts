/**
 * Smoke — tela pública de cadastro: /register.
 *
 * Porta de entrada do funil de candidatos (RegisterPage). READ-ONLY: só valida que
 * o SPA carregou e pintou o formulário — heading + campos + botão visíveis. NÃO digita,
 * NÃO submete (zero efeito colateral em prod: nenhuma conta é criada).
 *
 * Front é i18n ES. Seletores reais (de RegisterPage.tsx + es.json):
 *  - Heading nível 1 = register.title  → "¡Hola, vamos a crear su cuenta!"
 *  - FormField label common.email      → "Correo electrónico" (htmlFor="email")
 *  - FormField label common.password   → "Contraseña" (htmlFor="password"); exact p/ não
 *    casar o toggle "Mostrar contraseña" nem o 2º campo "Repita su contraseña".
 *  - Button register.registerButton    → "Registrarse"
 */
import { test, expect } from '@playwright/test';

test('[@route:/register] tela de cadastro renderiza heading, email, senha e submit', async ({ page }) => {
  await page.goto('/register');

  // Heading nível 1 prova que o SPA montou a página certa (não tela branca/erro).
  const heading = page.getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  await expect(heading).toContainText(/crear su cuenta/i);

  // Campos do formulário via associação FormField(label) ↔ input#id.
  await expect(page.getByLabel('Correo electrónico', { exact: true })).toBeVisible();
  // exact: senão casa "Mostrar contraseña" (toggle) e "Repita su contraseña" (confirmação).
  await expect(page.getByLabel('Contraseña', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Registrarse' })).toBeVisible();
});
