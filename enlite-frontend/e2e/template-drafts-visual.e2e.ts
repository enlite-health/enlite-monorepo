/**
 * template-drafts-visual.e2e.ts
 *
 * PROVA VISUAL da tela de REGISTRAR mensagem (spec 010, F2 2.1/2.2).
 *
 * COMO RODAR (os mesmos dois tropeços do template-catalog-visual):
 *   1. precisa de `enlite-frontend/.env` — é gitignored; sem ele o app não monta
 *      e o teste morre no login, o que parece defeito da tela e não é;
 *   2. depois de rodar, APAGUE o `.env`: ele define VITE_API_WORKER_FUNCTIONS_URL
 *      e mata o ramo de fallback do ApiService, derrubando o piso de cobertura
 *      do vitest com um vermelho que não existe no CI.
 *   `npx vite --port 5173 --strictPort &` e
 *   `npx playwright test --config=playwright.mocked.config.ts e2e/template-drafts-visual.e2e.ts`
 *
 * O que este arquivo fotografa, em ordem de importância:
 *   1. o AVISO de que salvar NÃO envia para a Meta — o mal-entendido mais caro
 *      possível aqui é a pessoa achar que submeteu e esperar autorização;
 *   2. a ausência de qualquer botão de submeter (o portão do `lex`);
 *   3. a mensagem de regra violada VISÍVEL abaixo do campo — os atoms Input e
 *      Textarea usam `error` só para a borda, e sem o texto a pessoa via
 *      vermelho sem motivo. Este é o defeito que o teste unitário achou.
 *
 * ⚠️ Tolerância em `maxDiffPixels`, não em `maxDiffPixelRatio`: com ratio numa
 * página de 1440x900 uma LINHA DE TEXTO inteira cabe na margem, e foi assim que
 * uma mensagem acrescentada no box de erro passou despercebida na tela vizinha.
 */
import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const RASCUNHO = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'ar_bienvenida_nueva',
  name: 'Bienvenida nueva',
  body: 'Hola {{1}}, te esperamos el {{2}} en la entrevista.',
  category: 'UTILITY',
  language: 'es-AR',
  version: 3,
  createdBy: 'uid-a', updatedBy: 'uid-a',
  createdAt: '2026-08-31T12:00:00Z', updatedAt: '2026-08-31T18:00:00Z',
  status: 'draft',
};

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.tdvisual.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';
  const signUp = await fetch(`${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const { localId: uid } = (await signUp.json()) as { localId: string };
  expect(uid).toBeTruthy();

  await page.route('**/identitytoolkit.googleapis.com/**', async (route) => {
    const parsed = new URL(route.request().url());
    const url = `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com${parsed.pathname}?${parsed.searchParams.toString().replace(/key=[^&]+/, `key=${FIREBASE_API_KEY}`)}`;
    const res = await fetch(url, { method: route.request().method(), headers: { 'Content-Type': 'application/json' }, body: route.request().postData() ?? undefined });
    await route.fulfill({ status: res.status, contentType: 'application/json', body: await res.text() });
  });
  await page.route('**/securetoken.googleapis.com/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ access_token: 'mock', expires_in: '3600', token_type: 'Bearer', refresh_token: 'mock', id_token: 'mock', user_id: uid, project_id: 'enlite-prd' }) }));
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { id: uid, email, role: 'admin', displayName: 'Gabriel', isActive: true } }) }));

  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 45_000 });
}

test.use({ viewport: { width: 1440, height: 900 } });

test.describe('Registrar mensaje — escribir, ver y guardar', () => {
  test('a tela com um rascunho salvo, e o aviso de que NÃO envia à Meta', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [RASCUNHO] } }) }));

    await page.goto('/admin/plantillas/registrar');
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });

    // 1. O aviso de perímetro está VISÍVEL, não escondido num tooltip.
    await expect(page.getByTestId('td-aviso-perimetro')).toBeVisible();
    await expect(page.getByTestId('td-aviso-perimetro')).toContainText(/TODAVÍA NO se envía a Meta/i);

    // 2. 🔒 Não existe botão de submeter — o portão do `lex`, fotografado.
    const rotulos = await page.getByRole('button').allTextContents();
    expect(rotulos.some((r) => /enviar|submit|publicar|autoriza/i.test(r))).toBe(false);

    // 3. O rascunho salvo aparece na lista.
    await expect(page.getByTestId('td-item-ar_bienvenida_nueva')).toBeVisible();

    await expect(page).toHaveScreenshot('template-drafts-lista.png', { maxDiffPixels: 120 });
  });

  test('escrever mostra o slug previsto e a pré-visualização', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [] } }) }));

    await page.goto('/admin/plantillas/registrar');
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('td-input-name').fill('Bienvenida nueva');
    await page.getByTestId('td-input-slug').fill('bienvenida nueva');
    await page.getByTestId('td-input-body').fill('Hola {{1}}, te esperamos el {{2}} en la entrevista.');

    // O nome final aparece ANTES de gravar — ninguém descobre o slug depois.
    await expect(page.getByTestId('td-slug-previsto')).toContainText('ar_bienvenida_nueva');
    // A variável vira exemplo legível, não chave crua.
    await expect(page.getByTestId('td-preview')).toContainText('[valor 1]');

    await expect(page).toHaveScreenshot('template-drafts-escrevendo.png', { maxDiffPixels: 120 });
  });

  test('regra violada aparece com TEXTO abaixo do campo, não só borda vermelha', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 422, contentType: 'application/json',
          body: JSON.stringify({
            success: false, error: 'Draft rejected by platform rules',
            problemas: [
              { campo: 'body', regra: 'placeholder_no_inicio' },
              { campo: 'body', regra: 'placeholders_adjacentes' },
            ],
          }),
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [] } }) });
    });

    await page.goto('/admin/plantillas/registrar');
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });

    await page.getByTestId('td-input-name').fill('Mala');
    await page.getByTestId('td-input-slug').fill('mala');
    await page.getByTestId('td-input-body').fill('{{1}}{{2}} hola');
    await page.getByTestId('td-salvar').click();

    // O TEXTO do motivo, não só a borda: era exatamente isto que faltava.
    await expect(page.getByTestId('td-problemas-body')).toBeVisible();
    await expect(page.getByTestId('td-problemas-body')).toContainText(/no puede empezar con una variable/i);
    await expect(page.getByTestId('td-problemas-body')).toContainText(/no pueden ir pegadas/i);

    await expect(page).toHaveScreenshot('template-drafts-regra-violada.png', { maxDiffPixels: 120 });
  });
});
