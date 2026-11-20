/**
 * unified-login-esqueci-senha @integration — "¿Olvidó su contraseña?" no /login.
 *
 * O nome do arquivo começa por `unified-login` DE PROPÓSITO: é o token que o `grep:` do `pr-gate.yml` já inclui
 * (job padrão do CI, com o emulador do Firebase de pé em :9099). Renomear tira o spec do CI.
 *
 * Sem mock de DADO e sem Auth forjado: o Vite do CI roda com config Firebase falsa e NÃO conecta o navegador ao emulador,
 * então a rede do navegador para `identitytoolkit.googleapis.com` é REDIRECIONADA ao emulador real (`route.fetch` com a URL do
 * emulador; a resposta devolvida à página é a do emulador, sem corpo fabricado). Conta, e-mail de recuperação e `oobCode` são
 * do emulador; o `oobCode` sai do endpoint REST dele (`/emulator/v1/projects/<id>/oobCodes`), como o link do e-mail.
 * Limite declarado: `auth/too-many-requests` o emulador não produz — esse ramo é coberto só por teste de componente.
 *
 * Casos:
 *   feliz   conta com senha → link no login → e-mail digitado → mensagem neutra → oobCode do emulador → `/auth/action` define a
 *           senha nova → a senha NOVA entra no emulador e a ANTIGA não
 *   alt 1   e-mail sem conta → a MESMA mensagem neutra, e o emulador não gerou código nenhum
 *   alt 2   e-mail mal formatado → erro de formato, sem nenhum pedido de recuperação ao emulador
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR ?? 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = process.env.E2E_FIREBASE_EMULATOR_PROJECT ?? 'demo-no-project';
const STAMP = Date.now();
const SENHA_ANTIGA = 'SenhaAntiga123!';
const SENHA_NOVA = 'SenhaNova456!';

const NEUTRA = /Si existe una cuenta con ese correo electrónico/;
const FORMATO = /Por favor, ingrese un correo electrónico válido/;

const json = { 'Content-Type': 'application/json' };

/** Redireciona o Identity Toolkit do navegador ao emulador real; a resposta é a dele. */
async function apontarAoEmulador(page: Page): Promise<{ sendOobCode: () => number }> {
  let sendOobCode = 0;
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const original = new URL(route.request().url());
    if (original.pathname.includes('sendOobCode')) sendOobCode += 1;
    const response = await route.fetch({ url: `${EMULATOR}${original.pathname}${original.search}` });
    await route.fulfill({ response });
  });
  return { sendOobCode: () => sendOobCode };
}

async function criarConta(email: string, senha: string): Promise<void> {
  const res = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: json, body: JSON.stringify({ email, password: senha, returnSecureToken: true }),
  });
  expect(res.ok, `conta ${email} não criada no emulador`).toBe(true);
}

async function entraNoEmulador(email: string, senha: string): Promise<boolean> {
  const res = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: json, body: JSON.stringify({ email, password: senha, returnSecureToken: true }),
  });
  return res.ok;
}

/** Os códigos de recuperação que o emulador gerou para este e-mail (o que o link do e-mail carregaria). */
async function codigosDeRecuperacao(email: string): Promise<string[]> {
  const res = await fetch(`${EMULATOR}/emulator/v1/projects/${EMULATOR_PROJECT}/oobCodes`);
  expect(res.ok, 'endpoint oobCodes do emulador indisponível').toBe(true);
  const { oobCodes } = (await res.json()) as { oobCodes: { email: string; requestType: string; oobCode: string }[] };
  return oobCodes.filter((c) => c.email === email && c.requestType === 'PASSWORD_RESET').map((c) => c.oobCode);
}

/** Como uma pessoa: clica no campo, confere o foco, digita. */
async function digitar(page: Page, seletor: string, texto: string): Promise<void> {
  const campo = page.locator(seletor);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  await expect(campo).toHaveValue(texto);
}

async function abrirRecuperacaoPeloLogin(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/login');
  await page.getByRole('link', { name: /Olvidó su contraseña/ }).click();
  await expect(page).toHaveURL(/\/forgot-password$/);
}

test.describe('@integration login único: ¿Olvidó su contraseña?', () => {
  test.setTimeout(120_000);

  test('feliz: pede o link, abre o código do emulador, define a senha nova e a antiga deixa de valer', async ({ page }) => {
    const email = `esqueci.${STAMP}@login-unico-${STAMP}.e2e.local`;
    await criarConta(email, SENHA_ANTIGA);
    await apontarAoEmulador(page);

    await abrirRecuperacaoPeloLogin(page);
    await digitar(page, '#forgot-email', email);
    await page.getByRole('button', { name: /Enviar enlace/ }).click();
    await expect(page.getByTestId('forgot-password-sent')).toContainText(NEUTRA);

    await expect.poll(() => codigosDeRecuperacao(email), { timeout: 15_000 }).toHaveLength(1);
    const [oobCode] = await codigosDeRecuperacao(email);

    await page.goto(`/auth/action?mode=resetPassword&oobCode=${encodeURIComponent(oobCode)}`);
    await digitar(page, '#new-password', SENHA_NOVA);
    await digitar(page, '#confirm-password', SENHA_NOVA);
    await page.getByRole('button', { name: /Definir contraseña/ }).click();
    await expect(page).not.toHaveURL(/\/auth\/action/, { timeout: 30_000 });

    expect(await entraNoEmulador(email, SENHA_NOVA), 'a senha nova não entra').toBe(true);
    expect(await entraNoEmulador(email, SENHA_ANTIGA), 'a senha antiga continuou valendo').toBe(false);
  });

  test('alt 1: e-mail sem conta recebe a MESMA mensagem neutra e o emulador não gera código', async ({ page }) => {
    const email = `ninguem.${STAMP}@login-unico-${STAMP}.e2e.local`;
    const rede = await apontarAoEmulador(page);

    await abrirRecuperacaoPeloLogin(page);
    await digitar(page, '#forgot-email', email);
    await page.getByRole('button', { name: /Enviar enlace/ }).click();

    await expect(page.getByTestId('forgot-password-sent')).toContainText(NEUTRA);
    await expect(page.getByTestId('forgot-password-error')).toHaveCount(0);
    expect(rede.sendOobCode(), 'o pedido de recuperação não chegou ao emulador').toBe(1);
    expect(await codigosDeRecuperacao(email)).toHaveLength(0);
  });

  test('alt 2: e-mail mal formatado mostra erro de formato e nada é pedido ao emulador', async ({ page }) => {
    const rede = await apontarAoEmulador(page);

    await abrirRecuperacaoPeloLogin(page);
    await digitar(page, '#forgot-email', 'isso-nao-e-email');
    await page.getByRole('button', { name: /Enviar enlace/ }).click();

    await expect(page.getByTestId('forgot-password-error')).toContainText(FORMATO);
    await expect(page.getByTestId('forgot-password-sent')).toHaveCount(0);
    expect(rede.sendOobCode()).toBe(0);
  });
});
