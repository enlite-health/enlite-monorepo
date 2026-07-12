/**
 * Smoke — CAMINHO DE ERRO da tela de login: /login (validação client-side).
 *
 * Dirige o formulário REAL de login como um usuário que erra o preenchimento. A validação
 * Zod (loginSchema em LoginPage.tsx) barra ANTES de chamar `login()` (Firebase) — o
 * `safeParse` falho faz `setError` e retorna, sem nenhuma tentativa de auth. 100% SEGURO:
 * nenhuma credencial enviada, nenhum efeito colateral. Zero mock.
 *
 * O box de erro mostra SEMPRE `errors[0]` (LoginPage: `setError(t(errors[0].message))`).
 * Como o schema é `{ email, password }` nessa ordem, o 1º erro é do email quando ele é
 * inválido, e só cai no de senha quando o email é válido.
 *
 * Mensagens batidas contra o source em 2026-07-11 (loginSchema + es.json):
 *   email vazio    → login.emailRequired    = "El correo electrónico es obligatorio"
 *   email inválido → register.invalidEmail  = "Por favor, ingrese un correo electrónico válido"
 *   senha vazia    → login.passwordRequired = "La contraseña es obligatoria"
 *
 * Front é i18n ES (es-AR). getByLabel exact pra não casar o toggle "Mostrar contraseña".
 */
import { test, expect } from '@playwright/test';

const EMAIL = 'Correo electrónico';
const PASSWORD = 'Contraseña';
const SUBMIT = 'Iniciar sesión';

test.beforeEach(async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('button', { name: SUBMIT })).toBeVisible();
});

test('[@route:/login @depth:error] email vazio é barrado com mensagem obrigatória', async ({ page }) => {
  // Form vazio: errors[0] é o do email (min(1)).
  await page.getByRole('button', { name: SUBMIT }).click();
  await expect(page.getByText('El correo electrónico es obligatorio')).toBeVisible();
});

test('[@route:/login @depth:error] email inválido é barrado com mensagem de formato', async ({ page }) => {
  // ACHADO (2026-07-11): <input type="email"> sem noValidate → a validação nativa do browser
  // intercepta "no-es-un-email" antes do zod do app. Usamos "a@b" (HTML5 aceita domínio sem
  // TLD, mas o `.email()` do zod rejeita) pra exercitar a mensagem DO APP (register.invalidEmail).
  await page.getByLabel(EMAIL, { exact: true }).fill('a@b');
  await page.getByLabel(PASSWORD, { exact: true }).fill('cualquier-cosa');
  await page.getByRole('button', { name: SUBMIT }).click();
  await expect(
    page.getByText('Por favor, ingrese un correo electrónico válido'),
  ).toBeVisible();
});

test('[@route:/login @depth:error] senha vazia é barrada com mensagem obrigatória', async ({ page }) => {
  // email válido → errors[0] passa a ser o da senha (min(1)).
  await page.getByLabel(EMAIL, { exact: true }).fill('gabriel+e2e@enlite.health');
  await page.getByRole('button', { name: SUBMIT }).click();
  await expect(page.getByText('La contraseña es obligatoria')).toBeVisible();
});
