/**
 * template-catalog-visual.e2e.ts
 *
 * PROVA VISUAL do catálogo de plantillas (spec 010, F1).
 *
 * COMO RODAR (os mesmos dois tropeços do fsm-picker-visual):
 *   1. precisa de `enlite-frontend/.env` — é gitignored; sem ele o app não monta
 *      e o teste morre no login, o que parece defeito da tela e não é;
 *   2. depois de rodar, APAGUE o `.env`: ele define VITE_API_WORKER_FUNCTIONS_URL
 *      e mata o ramo de fallback do ApiService, derrubando o piso de cobertura
 *      do vitest com um vermelho que não existe no CI.
 *   `npx vite --port 5173 --strictPort &` e
 *   `npx playwright test --config=playwright.mocked.config.ts e2e/template-catalog-visual.e2e.ts`
 *
 * O payload usa os SLUGS REAIS de produção lidos da WABA em 31/08/2026, para
 * fotografar os estados que a tela existe para distinguir:
 *   1. aprovada e em uso numa etapa;
 *   2. APROVADA na Meta e mesmo assim INELEGÍVEL para etapa (posicionais) —
 *      as duas perguntas são independentes, e confundi-las é o defeito;
 *   3. PAUSADA — o estado que hoje faz a linha sumir do banco (FILA B1);
 *   4. RECUSADA com motivo;
 *   5. nunca verificada, que NÃO pode parecer "pendente".
 *
 * ⚠️ Tolerância em `maxDiffPixels`, não em `maxDiffPixelRatio`. Com ratio de
 * 0.01 numa página de 1440x900, uma LINHA DE TEXTO inteira cabe dentro da
 * margem: acrescentei a mensagem traduzida no box de erro, o teste continuou
 * verde e o baseline nunca foi regravado — passei um tempo achando que o dev
 * server servia código velho. Régua de forma que não mede substância.
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

const PAYLOAD = {
  success: true,
  data: {
    templates: [
      row({
        slug: 'ar_finalize_signup_direct',
        bodyTwilio: '¡Hola {{1}}! Para terminar tu inscripción necesitamos que subas {{2}}. Entrá a app.enlite.health y completá tu perfil.',
        metaStatus: 'APPROVED', metaCheckedAt: '2026-08-31T14:32:00Z',
        eligible: true, usedInStages: ['SELECTED'],
      }),
      row({
        slug: 'ar_vacancy_match_complete',
        bodyTwilio: '¡Hola {{1}}! Se liberó una vacante en {{2}}. Mirá los detalles acá: {{3}}',
        metaStatus: 'APPROVED', metaCheckedAt: '2026-08-31T14:32:00Z',
        eligible: false, ineligibleReason: 'PLACEHOLDERS', placeholders: ['worker_name', 'case_number'],
      }),
      row({
        slug: 'ar_invite_luz_personal',
        bodyTwilio: '¡Hola {{1}}! Soy Luz, de EnLite Health. Ya formás parte de nuestra comunidad de profesionales del cuidado humano, y todos los días llegan pacientes que pueden necesitar lo que vos sabés ofrecer.',
        metaStatus: 'PAUSED', metaCheckedAt: '2026-08-31T14:32:00Z',
        eligible: false, ineligibleReason: 'CATEGORY',
      }),
      row({
        slug: 'ar_signup_pending_reminder',
        bodyTwilio: 'Recordá completar tu registro para acceder a las vacantes disponibles.',
        metaStatus: 'REJECTED', metaReason: 'INVALID_FORMAT',
        metaCheckedAt: '2026-08-31T14:32:00Z',
        eligible: false, ineligibleReason: 'DENY_LIST',
      }),
      row({ slug: 'ar_presentacion_invite', bodyTwilio: null, metaStatus: null, metaCheckedAt: null }),
    ],
  },
};

async function loginAsAdmin(page: Page): Promise<void> {
  const email = `e2e.tcvisual.${Date.now()}@test.com`;
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

test.describe('Catálogo de plantillas — qué existe y en qué estado', () => {
  test('lista com os cinco estados que importam', async ({ page }) => {
    await loginAsAdmin(page);
    await page.route('**/api/admin/template-catalog', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PAYLOAD) }));

    await page.goto('/admin/plantillas');
    await expect(page.getByTestId('tc-table')).toBeVisible({ timeout: 30_000 });

    // Aprovada e em uso.
    await expect(page.getByTestId('tc-status-ar_finalize_signup_direct')).toContainText('Aprobada');
    await expect(page.getByTestId('tc-used-ar_finalize_signup_direct')).toBeVisible();

    // As duas perguntas são independentes: aprovada na Meta E inútil para etapa.
    await expect(page.getByTestId('tc-status-ar_vacancy_match_complete')).toContainText('Aprobada');
    await expect(page.getByTestId('tc-ineligible-ar_vacancy_match_complete')).toBeVisible();

    // PAUSADA aparece — hoje esta linha sumiria do banco (FILA B1).
    await expect(page.getByTestId('tc-status-ar_invite_luz_personal')).toContainText('Pausada');

    // Recusada mostra o motivo traduzido, não a sigla sozinha.
    await expect(page.getByTestId('tc-reason-ar_signup_pending_reminder')).toContainText('Formato inválido');

    // Nunca verificada NÃO pode parecer "em revisão".
    const semVerificar = page.getByTestId('tc-status-ar_presentacion_invite');
    await expect(semVerificar).toContainText('Sin verificar');
    await expect(semVerificar).not.toContainText('revisión');

    // A faixa de filtros conta e a idade do dado aparece.
    await expect(page.getByTestId('tc-filter-all')).toContainText('5');
    await expect(page.getByTestId('tc-filter-off')).toContainText('1');
    await expect(page.getByTestId('tc-sync-age')).toBeVisible();
    // As variáveis exigidas ficam visíveis: "usa dados que o sistema não
    // completa" precisa dizer QUAIS.
    await expect(page.getByTestId('tc-vars-ar_vacancy_match_complete')).toBeVisible();

    await expect(page).toHaveScreenshot('tc-lista-estados.png', { fullPage: true, maxDiffPixels: 100 });

    // Filtrar por "desactivadas por Meta" deixa só a pausada.
    await page.getByTestId('tc-filter-off').click();
    await expect(page.getByTestId('tc-row-ar_invite_luz_personal')).toBeVisible();
    await expect(page.getByTestId('tc-row-ar_finalize_signup_direct')).toHaveCount(0);
    await expect(page).toHaveScreenshot('tc-filtro-desativadas.png', { fullPage: true, maxDiffPixels: 100 });
  });

  test('catálogo vazio e falha de carga', async ({ page }) => {
    await loginAsAdmin(page);

    await page.route('**/api/admin/template-catalog', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { templates: [] } }) }));
    await page.goto('/admin/plantillas');
    await expect(page.getByTestId('tc-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveScreenshot('tc-vazio.png', { fullPage: true, maxDiffPixels: 100 });

    await page.unroute('**/api/admin/template-catalog');
    await page.route('**/api/admin/template-catalog', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'Failed to list template catalog' }) }));
    await page.reload();
    await expect(page.getByTestId('tc-load-error')).toBeVisible({ timeout: 30_000 });
    // O erro não pode conviver com o estado vazio: seria "não há nada" e "deu errado" ao mesmo tempo.
    await expect(page.getByTestId('tc-empty')).toHaveCount(0);
    await expect(page).toHaveScreenshot('tc-erro.png', { fullPage: true, maxDiffPixels: 100 });
  });
});
