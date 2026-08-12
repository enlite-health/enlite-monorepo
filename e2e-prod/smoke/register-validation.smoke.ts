/**
 * Smoke — CAMINHO DE ERRO da tela de cadastro: /register (validação client-side).
 *
 * Dirige o formulário REAL de cadastro como um candidato que erra o preenchimento e
 * prova que a validação Zod client-side barra ANTES de qualquer chamada de escrita
 * (register()/initWorker() só rodam se `safeParse` passa — ver RegisterPage.handleSubmit).
 * 100% SEGURO: nenhuma conta criada, nenhum OTP/Twilio disparado — o submit retorna
 * cedo com a mensagem de erro. Zero mock (regra da suíte).
 *
 * Mensagens batidas contra o source em 2026-07-11:
 *  - registerSchema (RegisterPage.tsx) + es.json:
 *      email vazio      → login.emailRequired      = "El correo electrónico es obligatorio"
 *      email inválido   → register.invalidEmail    = "Por favor, ingrese un correo electrónico válido"
 *      senha <6         → register.passwordTooShort= "La contraseña debe tener al menos 6 caracteres"
 *      senhas ≠         → register.passwordMismatch= "Las contraseñas no coinciden"
 *      LGPD não marcado → register.lgpdRequired    = "Debe aceptar los términos para registrarse"
 *
 * DETALHE do fluxo (handleSubmit): o PRIMEIRO erro NÃO-LGPD vai pro box vermelho do topo
 * (`setError`); o erro de LGPD vai pro próprio checkbox (`setLgpdError`). Por isso cada
 * teste monta um input onde o alvo é o primeiro erro não-lgpd — exceto o teste de LGPD,
 * que preenche o resto válido pra isolar a mensagem no checkbox.
 *
 * Front é i18n ES (es-AR). Labels via FormField(label) ↔ input#id (getByLabel exact
 * pra não casar "Repita su contraseña" nem o toggle "Mostrar contraseña").
 */
import { test, expect, type Page } from '@playwright/test';

const EMAIL = 'Correo electrónico';
const PASSWORD = 'Contraseña';
const CONFIRM = 'Repita su contraseña';
const SUBMIT = 'Registrarse';

/** Preenche os campos de texto do form (o que for passado) e submete. LGPD nunca é
 *  marcado (o checkbox é sr-only; nenhum teste aqui precisa marcá-lo). */
async function fillAndSubmit(
  page: Page,
  fields: { email?: string; password?: string; confirm?: string },
): Promise<void> {
  if (fields.email !== undefined) {
    await page.getByLabel(EMAIL, { exact: true }).fill(fields.email);
  }
  if (fields.password !== undefined) {
    await page.getByLabel(PASSWORD, { exact: true }).fill(fields.password);
  }
  if (fields.confirm !== undefined) {
    await page.getByLabel(CONFIRM, { exact: true }).fill(fields.confirm);
  }
  await page.getByRole('button', { name: SUBMIT }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/register');
  // Sanidade: o form montou (não é tela branca/erro de SPA).
  await expect(page.getByRole('button', { name: SUBMIT })).toBeVisible();
});

test('[@route:/register @depth:error] email vazio é barrado com mensagem obrigatória', async ({ page }) => {
  // Form todo vazio: o 1º erro não-lgpd é o do email (min(1)) → box do topo.
  await fillAndSubmit(page, {});
  await expect(page.getByText('El correo electrónico es obligatorio')).toBeVisible();
});

test('[@route:/register @depth:error] email inválido é barrado com mensagem de formato', async ({ page }) => {
  // ACHADO (2026-07-11): o input é <input type="email"> e o form NÃO tem noValidate, então
  // a validação nativa do browser intercepta valores grosseiramente malformados (ex.:
  // "no-es-un-email") ANTES do handleSubmit/zod rodar — o tooltip nativo aparece e a
  // mensagem ES do app nunca renderiza. Pra exercitar a validação DO APP (register.invalidEmail),
  // usamos "a@b": o HTML5 aceita (domínio sem TLD é válido pro browser) mas o `.email()` do
  // zod rejeita (exige TLD) → cai no branch de erro do app. senha/confirm válidas → 1º erro = email.
  await fillAndSubmit(page, { email: 'a@b', password: '123456', confirm: '123456' });
  await expect(
    page.getByText('Por favor, ingrese un correo electrónico válido'),
  ).toBeVisible();
});

test('[@route:/register @depth:error] senha com menos de 6 caracteres é barrada', async ({ page }) => {
  // email válido; senha curta e confirm igual (sem mismatch) → 1º erro = tamanho da senha.
  await fillAndSubmit(page, { email: 'gabriel+e2e@enlite.health', password: '123', confirm: '123' });
  await expect(
    page.getByText('La contraseña debe tener al menos 6 caracteres'),
  ).toBeVisible();
});

test('[@route:/register @depth:error] senhas que não coincidem são barradas', async ({ page }) => {
  // email válido; senhas ≥6 mas diferentes → refine passwordMismatch (path confirmPassword).
  await fillAndSubmit(page, {
    email: 'gabriel+e2e@enlite.health',
    password: '123456',
    confirm: '654321',
  });
  await expect(page.getByText('Las contraseñas no coinciden')).toBeVisible();
});

test('[@route:/register @depth:error] termos LGPD não aceitos são barrados', async ({ page }) => {
  // Tudo válido, só o LGPD desmarcado → erro renderiza no próprio checkbox (setLgpdError).
  await fillAndSubmit(page, {
    email: 'gabriel+e2e@enlite.health',
    password: '123456',
    confirm: '123456',
  });
  await expect(
    page.getByText('Debe aceptar los términos para registrarse'),
  ).toBeVisible();
});
