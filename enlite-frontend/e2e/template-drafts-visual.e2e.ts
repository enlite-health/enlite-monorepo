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
 * 🔒 ELE ESTAVA VERMELHO ANTES DESTA EDIÇÃO, e nada avisou. O compositor foi
 * reescrito em 01/09 (a Tela 2 do desenho): `td-input-name` colapsou com
 * `td-input-slug`, `td-slug-previsto` virou o par `td-par-slug-*`, o aviso
 * âmbar `td-aviso-perimetro` saiu, e depois a lista "Borradores guardados"
 * mudou para o detalhe da mensagem. Os cinco testes daqui apontavam para
 * elementos que já não existem — e como este arquivo NÃO roda no CI (lá só
 * correm `e2e/integration/` e o portão `plantillas-vs-desenho`), a suíte ficou
 * quebrada em silêncio. Prova visual que ninguém executa não é prova.
 *
 * O que este arquivo fotografa, em ordem de importância:
 *   1. a CONFIRMAÇÃO que enumera o que se torna irreversível — a spec pede isso
 *      com todas as letras, e um "tem certeza?" cumpriria a forma sem a
 *      substância;
 *   2. a mensagem de regra violada VISÍVEL abaixo do campo — os atoms Input e
 *      Textarea usam `error` só para a borda, e sem o texto a pessoa via
 *      vermelho sem motivo. Este é o defeito que o teste unitário achou;
 *   3. o estado SUBMETIDO, onde editar deixa de existir e sobra duplicar.
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
  // 🔒 `baseName` é o que o compositor usa para reabrir: o nome SEM o prefixo de
  // país. Ele passou a ser coluna do banco na migration 302 — antes era
  // derivado do slug em cada leitura, e o dublê que o omitia abria o formulário
  // com o campo vazio, o que parecia defeito da tela.
  baseName: 'bienvenida_nueva',
  name: 'Bienvenida nueva',
  body: 'Hola {{worker_name}}, te esperamos para el caso {{case_number}}, gracias.',
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
  test('`?draft=` abre o rascunho salvo, e a promessa de não enviar está no subtítulo', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [RASCUNHO] } }) }));

    await page.goto(`/admin/plantillas/registrar?draft=${RASCUNHO.id}`);
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });

    // O rascunho chega no formulário — é o que substituiu clicar na lista.
    await expect(page.getByTestId('td-input-slug')).toHaveValue('bienvenida_nueva');
    await expect(page.getByTestId('td-input-body')).toContainText(/te esperamos/i);

    /*
     * A promessa "guardar não envia" mora no SUBTÍTULO, e num lugar só. Ela
     * ficava também numa caixa âmbar e na modal — três lugares para uma frase,
     * e aviso repetido ensina a ignorar a cor.
     */
    await expect(page.getByText(/Recién cuando la envíes a Meta/i)).toBeVisible();
    await expect(page.getByTestId('td-aviso-perimetro')).toHaveCount(0);

    await expect(page).toHaveScreenshot('template-drafts-editando.png', { maxDiffPixels: 120 });
  });

  test('escrever mostra o slug previsto e a pré-visualização', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [] } }) }));

    await page.goto('/admin/plantillas/registrar');
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });

    // UM campo de nome, não dois: nas 27 linhas de produção `name` é idêntico
    // ao `slug`, e pedir os dois era pedir a mesma coisa duas vezes.
    await page.getByTestId('td-input-slug').fill('bienvenida_nueva');
    await page.getByTestId('td-input-body').fill('Hola {{worker_name}}, te esperamos para el caso {{case_number}}, gracias.');

    // Os dois nomes finais aparecem ANTES de gravar, um por idioma — o prefixo
    // de país é nosso, e ninguém descobre o slug depois de submeter.
    await expect(page.getByTestId('td-par-slug-es-AR')).toHaveAttribute('data-slug', 'ar_bienvenida_nueva');
    await expect(page.getByTestId('td-par-slug-pt-BR')).toHaveAttribute('data-slug', 'br_bienvenida_nueva');
    // A variável vira um valor de exemplo grifado, não chave crua.
    await expect(page.getByTestId('td-preview')).toContainText('María González');
    // E a variável entra por BOTÃO: o conjunto é fechado por construção.
    await expect(page.getByTestId('td-inserir-worker_name')).toBeVisible();

    await expect(page).toHaveScreenshot('template-drafts-escrevendo.png', { maxDiffPixels: 120 });
  });

  test('a confirmação ENUMERA o que se torna irreversível', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-drafts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [RASCUNHO] } }) }));

    await page.goto(`/admin/plantillas/registrar?draft=${RASCUNHO.id}`);
    await expect(page.getByTestId('td-form')).toBeVisible({ timeout: 30_000 });

    // Só um rascunho JÁ GRAVADO pode ser submetido: o envio precisa de um `id`.
    await page.getByTestId('td-revisar-enviar').click();

    // As consequências enumeradas em espanhol claro — não "tem certeza?".
    await expect(page.getByTestId('td-confirmar')).toBeVisible();
    await expect(page.getByTestId('td-confirmar-lista')).toContainText(/nombre queda ocupado/i);
    await expect(page.getByTestId('td-confirmar-lista')).toContainText(/no vas a poder editar el texto/i);
    await expect(page.getByTestId('td-confirmar-lista')).toContainText(/un día hábil/i);
    // 🔒 CINCO consequências, não três. O idioma que fica fixo e "estás enviando
    // só um dos dois" entraram em 01/09 — as duas são irreversíveis do mesmo
    // jeito, e a modal existe justamente para enumerar o que não tem volta.
    await expect(page.getByTestId('td-confirmar-lista').locator('li')).toHaveCount(5);

    await expect(page).toHaveScreenshot('template-drafts-confirmar.png', { maxDiffPixels: 120 });
  });

  /*
   * ⚠️ ESTE TESTE MUDOU DE TELA, não de intenção. "Submetido não se edita" era
   * uma propriedade da lista no pé do compositor; a lista saiu, e as quatro
   * ações do rascunho vivem agora no DETALHE da mensagem. A regra continua
   * sendo a mesma, e continua fotografada — no lugar onde ela mora.
   */
  test('submetido: no detalhe, editar some e sobra duplicar', async ({ page }) => {
    await loginAsAdmin(page);
    const submetido = { ...RASCUNHO, contentSid: 'HXja', submittedAt: '2026-08-31T20:00:00Z', status: 'submitted' };
    await page.route('**/api/admin/template-drafts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { drafts: [submetido] } }) }));
    await page.route('**/api/admin/template-catalog', (route) =>
      route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { templates: [{
          slug: 'ar_bienvenida_nueva', name: 'ar_bienvenida_nueva', baseName: 'bienvenida_nueva',
          bodyTwilio: RASCUNHO.body, language: 'es-AR', category: 'UTILITY', isActive: true,
          contentSid: 'HXja', metaStatus: 'PENDING', metaReason: null, metaDetail: null,
          metaCheckedAt: null, eligible: false, ineligibleReason: 'no_aprobada',
          placeholders: [], usedInStages: [], isDraft: true,
        }] } }),
      }));

    await page.goto('/admin/plantillas/ar_bienvenida_nueva');
    await expect(page.getByTestId('tc-detalhe-rascunho')).toBeVisible({ timeout: 30_000 });

    await expect(page.getByTestId('tc-rascunho-duplicar')).toBeVisible();
    await expect(page.getByTestId('tc-rascunho-editar')).toHaveCount(0);
    await expect(page.getByTestId('tc-rascunho-enviar')).toHaveCount(0);
    await expect(page.getByTestId('tc-rascunho-estado')).toContainText(/esperando autorización/i);

    await expect(page).toHaveScreenshot('template-drafts-submetido.png', { maxDiffPixels: 120 });
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
              { campo: 'body', regra: 'placeholder_posicional' },
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

    await page.getByTestId('td-input-slug').fill('mala');
    await page.getByTestId('td-input-body').fill('{{1}}{{2}} hola');
    await page.getByTestId('td-salvar').click();

    // O TEXTO do motivo, não só a borda: era exatamente isto que faltava.
    await expect(page.getByTestId('td-problemas-body')).toBeVisible();
    await expect(page.getByTestId('td-problemas-body')).toContainText(/variables con nombre/i);
    await expect(page.getByTestId('td-problemas-body')).toContainText(/no pueden ir pegadas/i);

    await expect(page).toHaveScreenshot('template-drafts-regra-violada.png', { maxDiffPixels: 120 });
  });
});
