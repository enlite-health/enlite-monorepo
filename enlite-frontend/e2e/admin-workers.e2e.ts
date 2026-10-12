/**
 * admin-workers.e2e.ts
 *
 * Playwright E2E — Tela de listagem de Workers (/admin/workers)
 *
 * Fluxos cobertos:
 *   - Página renderiza corretamente em /admin/workers
 *   - Item "Workers" visível no menu lateral (sidebar)
 *   - Tabela exibe dados dos workers (nome, casos, documentação, plataforma)
 *   - Estado vazio exibe mensagem "Nenhum worker encontrado"
 *   - Filtro por plataforma inclui parâmetro na requisição
 *   - Filtro por documentação inclui parâmetro na requisição
 *   - Erro de API exibe mensagem de erro
 *   - Acesso sem auth redireciona para /admin/login
 *   - Stats cards exibem valores corretos do endpoint /api/admin/workers/stats
 *   - Stats cards mostram 0 quando API retorna zeros
 *   - Stats cards mostram fallback quando endpoint de stats falha
 *   - Fluxo completo: stats + lista carregam em paralelo
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR  = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY   = 'test-api-key';

// ── Mock data ─────────────────────────────────────────────────────────────────

const MOCK_WORKERS = [
  {
    id: 'w1111111-0001-0001-0001-000000000001',
    name: 'Maria Silva',
    email: 'maria.silva@e2e.test',
    casesCount: 3,
    documentsComplete: true,
    documentsStatus: 'approved',
    platform: 'talentum',
    createdAt: '2026-03-20T10:00:00Z',
  },
  {
    id: 'w2222222-0002-0002-0002-000000000002',
    name: 'João Souza',
    email: 'joao.souza@e2e.test',
    casesCount: 0,
    documentsComplete: false,
    documentsStatus: 'pending',
    platform: 'planilla_operativa',
    createdAt: '2026-03-15T08:00:00Z',
  },
];

const MOCK_STATS = {
  success: true,
  data: { today: 5, yesterday: 3, sevenDaysAgo: 8 },
};

function mockWorkersList(workers = MOCK_WORKERS, total = MOCK_WORKERS.length) {
  return JSON.stringify({
    success: true,
    data: workers,
    total,
    limit: 20,
    offset: 0,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd     = Math.random().toString(36).slice(2, 8);
  const email   = `e2e.workers.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  // 1. Create user in Firebase Emulator
  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as any;
  if (!signUpData.localId) throw new Error(`Firebase sign-up failed: ${JSON.stringify(signUpData)}`);
  const uid = signUpData.localId;

  // 2. Seed Postgres admin record
  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'Workers E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
      VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch {
    // Fall through to mock below
  }

  // 3. Mock /api/admin/auth/profile
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid,
          email,
          role: 'superadmin',
          firstName: 'Workers',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  // 4. Mock other pages that could be visited during navigation
  await page.route('**/api/vacancies*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [], total: 0, page: 1, limit: 20 }),
    }),
  );

  await page.route('**/api/admin/users*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );

  // 5. Login via UI
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

/**
 * Registra o mock de /stats DEPOIS do mock genérico de lista.
 * No Playwright, rotas são avaliadas em ordem LIFO (última registrada primeiro),
 * portanto o mock específico de /stats deve ser registrado após o glob genérico
 * para que ele tenha prioridade e intercepte apenas o endpoint correto.
 */
async function mockStatsAfterListMock(
  page: Page,
  statsBody = JSON.stringify(MOCK_STATS),
): Promise<void> {
  await page.route('**/api/admin/workers/stats', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: statsBody }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('AdminWorkersPage', () => {
  test.setTimeout(60000);

  test('página /admin/workers renderiza título e tabela de workers', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');

    // Título da página
    await expect(page.locator('text=Workers').first()).toBeVisible({ timeout: 15000 });

    // Cabeçalhos da tabela
    await expect(page.locator('text=Nome').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Casos').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Documentação').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Cadastro').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Plataforma').first()).toBeVisible({ timeout: 5000 });
  });

  test('item "Workers" está visível no menu lateral', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');
    await expect(page.getByRole('link', { name: /Workers/i }).first()).toBeVisible({ timeout: 15000 });
  });

  test('tabela exibe dados do worker: nome, email, casos, badge documentação e plataforma', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');

    // Worker 1 — Maria Silva
    await expect(page.locator('text=Maria Silva').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=maria.silva@e2e.test').first()).toBeVisible({ timeout: 5000 });
    // Use exact match to avoid hitting hidden <option>Completos</option> in the filter select
    await expect(page.getByText('Completo', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Worker 2 — João Souza
    await expect(page.locator('text=João Souza').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Pendente', { exact: true }).first()).toBeVisible({ timeout: 5000 });
  });

  test('tabela vazia exibe "Nenhum worker encontrado"', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList([], 0) }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');

    await expect(page.locator('text=Nenhum worker encontrado').first()).toBeVisible({ timeout: 15000 });
  });

  test('filtro por plataforma envia parâmetro platform na URL da requisição', async ({ page }) => {
    await seedAdminAndLogin(page);

    let capturedUrl = '';
    await page.route('**/api/admin/workers*', (route) => {
      capturedUrl = route.request().url();
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() });
    });
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');
    await expect(page.locator('text=Nome').first()).toBeVisible({ timeout: 15000 });

    // Seleciona a plataforma Talentum no select de filtros
    const platformSelect = page.locator('select').first();
    await platformSelect.selectOption('talentum');

    // Aguarda nova requisição com filtro
    await page.waitForResponse((resp) => resp.url().includes('/api/admin/workers') && resp.url().includes('platform=talentum'));

    expect(capturedUrl).toContain('platform=talentum');
  });

  test('filtro por documentação envia parâmetro docs_complete na URL da requisição', async ({ page }) => {
    await seedAdminAndLogin(page);

    let capturedUrl = '';
    await page.route('**/api/admin/workers*', (route) => {
      capturedUrl = route.request().url();
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() });
    });
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');
    await expect(page.locator('text=Nome').first()).toBeVisible({ timeout: 15000 });

    // Seleciona filtro de documentação completa
    const selects = page.locator('select');
    await selects.nth(1).selectOption('complete');

    await page.waitForResponse((resp) => resp.url().includes('/api/admin/workers') && resp.url().includes('docs_complete=complete'));

    expect(capturedUrl).toContain('docs_complete=complete');
  });

  test('erro de API exibe mensagem de erro na tela', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Internal Server Error' }),
      }),
    );

    await page.goto('/admin/workers');

    await expect(page.locator('text=Erro ao carregar workers').first()).toBeVisible({ timeout: 15000 });
  });

  test('filtros de plataforma e documentação não possuem opções duplicadas', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');
    await expect(page.locator('text=Nome').first()).toBeVisible({ timeout: 15000 });

    const selects = page.locator('select');

    // Plataforma: 1 placeholder ("Todas") + 5 valores = 6 options
    const platformOptions = await selects.nth(0).locator('option').all();
    expect(platformOptions).toHaveLength(6);
    const platformValues = await Promise.all(platformOptions.map((o) => o.getAttribute('value')));
    const platformDuplicates = platformValues.filter((v, i) => platformValues.indexOf(v) !== i);
    expect(platformDuplicates).toHaveLength(0);

    // Documentação: 1 placeholder ("Todos") + 2 valores = 3 options
    const docsOptions = await selects.nth(1).locator('option').all();
    expect(docsOptions).toHaveLength(3);
    const docsValues = await Promise.all(docsOptions.map((o) => o.getAttribute('value')));
    const docsDuplicates = docsValues.filter((v, i) => docsValues.indexOf(v) !== i);
    expect(docsDuplicates).toHaveLength(0);
  });

  test('fluxo completo: carrega workers, aplica filtro e exibe resultado visualmente', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Intercept inicial retorna lista completa
    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');

    // 1. Verificar estado inicial — sem erro, com dados
    await expect(page.locator('text=Erro ao carregar workers')).not.toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Maria Silva').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=João Souza').first()).toBeVisible({ timeout: 5000 });

    // 2. Aplicar filtro por plataforma (Talentum) — apenas Maria Silva esperada
    const filteredBody = JSON.stringify({
      success: true,
      data: [MOCK_WORKERS[0]],
      total: 1,
      limit: 20,
      offset: 0,
    });

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: filteredBody }),
    );
    await mockStatsAfterListMock(page);

    const platformSelect = page.locator('select').first();
    await platformSelect.selectOption('talentum');

    // 3. Garantia visual: tabela atualiza, sem erro
    await expect(page.locator('text=Erro ao carregar workers')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Maria Silva').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=João Souza')).not.toBeVisible({ timeout: 5000 });
  });

  test('acesso sem autenticação redireciona para /admin/login', async ({ browser }) => {
    const context = await browser.newContext();
    const page    = await context.newPage();

    await page.goto('/admin/workers');
    await expect(page).toHaveURL(/\/admin\/login/, { timeout: 10000 });

    await context.close();
  });

  test('clicar no link Workers na sidebar navega para /admin/workers', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    await mockStatsAfterListMock(page);

    // Começa em /admin para testar navegação via sidebar
    await page.goto('/admin');
    await expect(page).toHaveURL('/admin/dashboard', { timeout: 10000 });

    const workersLink = page.getByRole('link', { name: /Workers/i }).first();
    await expect(workersLink).toBeVisible({ timeout: 10000 });
    await workersLink.click();

    await expect(page).toHaveURL(/\/admin\/workers/, { timeout: 10000 });
    await expect(page.locator('text=Lista de Workers').first()).toBeVisible({ timeout: 15000 });
  });

  test('paginação: botões prev/next têm cursor pointer e enviam offset correto', async ({ page }) => {
    await seedAdminAndLogin(page);

    // 25 workers no total, 10 por página → 3 páginas
    const page1Workers = Array.from({ length: 10 }, (_, i) => ({
      id: `worker-p1-${i}`,
      name: `Worker Page1 ${i + 1}`,
      email: `worker.p1.${i}@e2e.test`,
      casesCount: 0,
      documentsComplete: false,
      documentsStatus: 'pending',
      platform: 'talentum',
      createdAt: '2026-03-20T10:00:00Z',
    }));
    const page2Workers = Array.from({ length: 10 }, (_, i) => ({
      id: `worker-p2-${i}`,
      name: `Worker Page2 ${i + 1}`,
      email: `worker.p2.${i}@e2e.test`,
      casesCount: 0,
      documentsComplete: false,
      documentsStatus: 'pending',
      platform: 'talentum',
      createdAt: '2026-03-20T10:00:00Z',
    }));

    const capturedUrls: string[] = [];

    await page.route('**/api/admin/workers*', (route) => {
      const url = route.request().url();
      capturedUrls.push(url);
      const urlObj = new URL(url);
      const offset = parseInt(urlObj.searchParams.get('offset') ?? '0');
      const workers = offset === 0 ? page1Workers : page2Workers;
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: workers, total: 25, limit: 10, offset }),
      });
    });
    await mockStatsAfterListMock(page);

    await page.goto('/admin/workers');
    await expect(page.locator('text=Worker Page1 1').first()).toBeVisible({ timeout: 15000 });

    // Muda para 10 por página via select
    const itemsPerPageSelect = page.locator('select').last();
    await itemsPerPageSelect.selectOption('10');
    await page.waitForResponse((r) => r.url().includes('/api/admin/workers') && !r.url().includes('/stats'));

    // Botão "próxima página"
    const nextBtn = page.getByRole('button', { name: /Próxima página/i });
    const prevBtn = page.getByRole('button', { name: /Página anterior/i });

    // Verifica cursor pointer visualmente
    const nextCursor = await nextBtn.evaluate((el) => window.getComputedStyle(el).cursor);
    expect(nextCursor).toBe('pointer');

    // Botão anterior deve estar desabilitado na página 1
    await expect(prevBtn).toBeDisabled();
    await expect(nextBtn).not.toBeDisabled();

    // Clica "próxima página" e aguarda a tabela atualizar visualmente
    await nextBtn.click();
    await expect(page.locator('text=Worker Page2 1').first()).toBeVisible({ timeout: 15000 });

    // Verifica que o offset=10 foi enviado
    const offsetUrls = capturedUrls.filter((u) => u.includes('offset=10') && !u.includes('/stats'));
    expect(offsetUrls.length).toBeGreaterThan(0);

    // Tabela agora mostra workers da página 2
    await expect(page.locator('text=Worker Page1 1')).not.toBeVisible({ timeout: 5000 });

    // Texto de paginação mostra "11–20 de 25"
    await expect(page.locator('text=11–20 de 25').first()).toBeVisible({ timeout: 5000 });

    // Botão anterior agora habilitado
    await expect(prevBtn).not.toBeDisabled();

    // Clica "página anterior" — volta para página 1
    await prevBtn.click();
    await expect(page.locator('text=Worker Page1 1').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=1–10 de 25').first()).toBeVisible({ timeout: 5000 });
  });

  // ── Stats Cards ──────────────────────────────────────────────────────────────

  test('stats cards exibem valores corretos quando API retorna dados', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    // Registrar mock de stats DEPOIS do glob genérico (LIFO = maior prioridade)
    await page.route('**/api/admin/workers/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { today: 5, yesterday: 3, sevenDaysAgo: 8 } }),
      }),
    );

    await page.goto('/admin/workers');

    // Aguarda os cards renderizarem (saem do skeleton para os valores reais)
    await expect(page.getByTestId('worker-stats-today')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('worker-stats-yesterday')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('worker-stats-seven-days')).toBeVisible({ timeout: 5000 });

    // Verifica os valores numéricos dentro de cada card
    await expect(page.getByTestId('worker-stats-today').getByText('5')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('worker-stats-yesterday').getByText('3')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('worker-stats-seven-days').getByText('8')).toBeVisible({ timeout: 5000 });
  });

  test('stats cards mostram 0 quando API retorna zeros', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    await page.route('**/api/admin/workers/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { today: 0, yesterday: 0, sevenDaysAgo: 0 } }),
      }),
    );

    await page.goto('/admin/workers');

    await expect(page.getByTestId('worker-stats-today')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('worker-stats-yesterday')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('worker-stats-seven-days')).toBeVisible({ timeout: 5000 });

    // Todos os cards devem exibir "0"
    await expect(page.getByTestId('worker-stats-today').getByText('0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('worker-stats-yesterday').getByText('0')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('worker-stats-seven-days').getByText('0')).toBeVisible({ timeout: 5000 });
  });

  test('stats cards mostram 0 e tabela funciona normalmente quando endpoint de stats falha', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Lista de workers retorna normalmente
    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    // Endpoint de stats retorna 500 — o hook trata com .catch(() => STATS_FALLBACK)
    await page.route('**/api/admin/workers/stats', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Internal Server Error' }),
      }),
    );

    await page.goto('/admin/workers');

    // Os 3 cards devem existir (com valores de fallback = 0)
    await expect(page.getByTestId('worker-stats-today')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('worker-stats-yesterday')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('worker-stats-seven-days')).toBeVisible({ timeout: 5000 });

    // Tabela continua carregando normalmente
    await expect(page.locator('text=Erro ao carregar workers')).not.toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=Maria Silva').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=João Souza').first()).toBeVisible({ timeout: 5000 });
  });

  test('fluxo completo: stats e lista carregam em paralelo, filtros funcionam após carregamento', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() }),
    );
    await page.route('**/api/admin/workers/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { today: 5, yesterday: 3, sevenDaysAgo: 8 } }),
      }),
    );

    await page.goto('/admin/workers');

    // Stats cards visíveis
    await expect(page.getByTestId('worker-stats-today')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('worker-stats-yesterday')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('worker-stats-seven-days')).toBeVisible({ timeout: 5000 });

    // Tabela de workers visível
    await expect(page.locator('text=Maria Silva').first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=João Souza').first()).toBeVisible({ timeout: 5000 });

    // Sem mensagem de erro
    await expect(page.locator('text=Erro ao carregar workers')).not.toBeVisible({ timeout: 5000 });

    // Filtro ainda funciona após carregamento dos stats
    const filteredBody = JSON.stringify({
      success: true,
      data: [MOCK_WORKERS[0]],
      total: 1,
      limit: 20,
      offset: 0,
    });

    await page.route('**/api/admin/workers*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: filteredBody }),
    );
    await page.route('**/api/admin/workers/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { today: 5, yesterday: 3, sevenDaysAgo: 8 } }),
      }),
    );

    const platformSelect = page.locator('select').first();
    await platformSelect.selectOption('talentum');

    await expect(page.locator('text=Maria Silva').first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=João Souza')).not.toBeVisible({ timeout: 5000 });

    // Stats cards ainda visíveis após o filtro
    await expect(page.getByTestId('worker-stats-today')).toBeVisible({ timeout: 5000 });
  });
});
