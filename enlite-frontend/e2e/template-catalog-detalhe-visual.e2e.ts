/**
 * PROVA VISUAL do detalhe da mensagem e do botão de registrar (spec 010).
 *
 * ⚠️ Existe por causa de três coisas que o Gabriel viu na TELA DE PRODUÇÃO em
 * 01/09/2026, e que nenhum teste pegava:
 *   1. a listagem mostrava "1 2 3 4 5" — números nus, sem rótulo;
 *   2. não havia caminho do catálogo para a tela de criar;
 *   3. (na outra tela) o estado ficava "esperando autorización" para sempre.
 *
 * Aqui fotografo as duas primeiras. Rodar: ver o cabeçalho do
 * template-drafts-visual.e2e.ts — mesmos dois tropeços do `.env`.
 */
import { test, expect, Page } from '@playwright/test';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const row = (over: Record<string, unknown>) => ({
  slug: 'x', name: 'x', bodyTwilio: null, category: 'UTILITY', isActive: true,
  contentSid: 'HXaaa', metaStatus: null, metaReason: null, metaDetail: null,
  metaCheckedAt: null, eligible: true, ineligibleReason: null,
  placeholders: [], usedInStages: [],
  ...over,
  // 🔒 O BACKEND SEMPRE MANDA `baseName` (`COALESCE(base_name, slug)`), e o mock
  // precisa mandar também. Sem ele a tela agrupa TODAS as linhas sob `undefined`
  // e desenha UMA linha só — medido: 5 entram, 1 sai. O screenshot viraria a
  // foto de um bug do mock, não da tela.
  baseName: (over.baseName as string | undefined) ?? (over.slug as string | undefined) ?? 'x',
  // `language` pode ser null de verdade (linha vinda do Console da Twilio), mas
  // o padrão do catálogo real é es-AR: 26 das 28 linhas de produção.
  language: 'language' in over ? over.language : 'es-AR',
});

const PAYLOAD = { success: true, data: { templates: [
  row({
    slug: 'admission_confirmation_es', name: 'Confirmación de admisión',
    bodyTwilio: 'Hola {{1}}, confirmamos tu entrevista para el {{2}} a las {{3}} en {{4}}. Referencia {{5}}.',
    metaStatus: 'APPROVED', metaCheckedAt: '2026-09-01T02:19:00Z',
    eligible: false, ineligibleReason: 'PLACEHOLDERS',
    placeholders: ['1', '2', '3', '4', '5'],
  }),
  row({
    slug: 'ar_recusada_exemplo', name: 'Ejemplo rechazado',
    bodyTwilio: 'Hola {{1}}, promoción especial para vos.',
    metaStatus: 'REJECTED', metaReason: 'INCORRECT_CATEGORY',
    metaDetail: 'El contenido es promocional pero la categoría declarada es UTILITY.',
    metaCheckedAt: '2026-09-01T02:19:00Z', placeholders: ['1'],
  }),
]}};

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.tcdet.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';
  const signUp = await fetch(`${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const { localId: uid } = (await signUp.json()) as { localId: string };
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

test.describe('Catálogo — o detalhe e o caminho para criar', () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-catalog', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAYLOAD) }));
    await page.goto('/admin/plantillas');
    await expect(page.getByTestId('tc-table')).toBeVisible({ timeout: 30_000 });
  });

  /*
   * ⚠️ ESTE TESTE MEDIA A AUSÊNCIA DO ELEMENTO, e a ausência deixou de ser a
   * resposta certa. O defeito original era o número NU — "1 2 3 4 5" solto na
   * célula, que não se lê como nada. A correção não foi apagar a informação: foi
   * mostrá-la como `{{1}}`, que se lê como marcador de posição, com o custo
   * explicado no detalhe. Afirmar `toHaveCount(0)` passou a proibir o conserto.
   */
  test('a listagem mostra a variável como marcador, nunca como número nu', async ({ page }) => {
    const vars = page.getByTestId('tc-vars-admission_confirmation_es');
    await expect(vars).toBeVisible();
    await expect(vars).toContainText('{{1}}');
    // O que continua proibido: um dígito sozinho, sem as chaves que o explicam.
    expect((await vars.textContent() ?? '').replace(/\{\{\d+\}\}/g, '').trim()).toBe('');
    // 🔒 O caminho que não existia.
    await expect(page.getByTestId('tc-nova-mensagem')).toBeVisible();
    await expect(page).toHaveScreenshot('catalogo-sem-numeros.png', { maxDiffPixels: 120 });
  });

  /*
   * ⚠️ O DETALHE VIROU ROTA. `tc-detalhe` era o invólucro do drawer, que deixou
   * de existir em 01/09 — o desenho pede endereço próprio, porque quem chega
   * aqui vai ler e depois agir, e um drawer some ao clicar fora no meio da
   * leitura. O teste mudou de porta, não de asserção.
   */
  test('o detalhe explica as variáveis posicionais', async ({ page }) => {
    await page.getByTestId('tc-row-admission_confirmation_es').click();
    await expect(page).toHaveURL(/plantillas\/[^/]+$/);
    await expect(page.getByTestId('tc-detalhe-texto')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tc-detalhe-vars')).toContainText('{{1}}');
    await expect(page.getByTestId('tc-detalhe-vars-posicionais')).toContainText(/no sabe qué poner/i);
    await expect(page).toHaveScreenshot('detalhe-posicionais.png', { maxDiffPixels: 120 });
  });

  test('o detalhe de uma recusada mostra motivo E explicação da Meta', async ({ page }) => {
    await page.getByTestId('tc-row-ar_recusada_exemplo').click();
    await expect(page.getByTestId('tc-detalhe-motivo')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tc-detalhe-explicacao')).toContainText(/promocional/i);
    await expect(page).toHaveScreenshot('detalhe-recusada.png', { maxDiffPixels: 120 });
  });

  test('o botão leva mesmo para a tela de registrar', async ({ page }) => {
    await page.getByTestId('tc-nova-mensagem').click();
    await expect(page).toHaveURL(/plantillas\/registrar/);
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });
  });
});
