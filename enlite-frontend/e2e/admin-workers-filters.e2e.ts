/**
 * admin-workers-filters.e2e.ts
 *
 * Playwright E2E — Filtros da página de Prestadores (/admin/workers)
 *
 * Fluxos cobertos:
 *   1. Visual: Filtros renderizados corretamente (Caso, Buscar, Documentación)
 *   2. Visual: SearchableSelect de Caso com dropdown aberto
 *   3. Visual: SearchableSelect de Caso com filtro de texto aplicado
 *   4. Visual: SearchableSelect de Caso com opção selecionada
 *   5. Visual: Input de busca com placeholder "Nombre, email o teléfono"
 *   6. Filtro de Caso envia parâmetro case_id na URL da requisição
 *   7. Busca por telefone envia parâmetro search na URL da requisição
 *   8. Limpar seleção do Caso remove o parâmetro case_id da requisição
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

// ── Mock data ──────────────────────────────────────────────────────────────────

const MOCK_CASE_OPTIONS = [
  { value: 'uuid-1', label: 'CASO 101 - Juan García' },
  { value: 'uuid-2', label: 'CASO 102 - María López' },
  { value: 'uuid-3', label: 'CASO 103' },
];

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
  data: { today: 2, yesterday: 1, sevenDaysAgo: 5 },
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

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd      = Math.random().toString(36).slice(2, 8);
  const email    = `e2e.filters.${Date.now()}.${rnd}@test.com`;
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
      VALUES ('${uid}', '${email}', 'Filters E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
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
          firstName: 'Filters',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  // 4. Mock auxiliary endpoints
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

async function mockWorkersApis(page: Page, workers = MOCK_WORKERS): Promise<void> {
  await page.route('**/api/admin/workers/case-options', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_CASE_OPTIONS }),
    }),
  );

  await page.route('**/api/admin/workers/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_STATS),
    }),
  );

  await page.route('**/api/admin/workers*', (route) => {
    const url = route.request().url();
    // stats endpoint is already handled above (LIFO — registered after = higher priority)
    if (url.includes('/stats') || url.includes('/case-options')) {
      return route.continue();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: mockWorkersList(workers),
    });
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('AdminWorkersPage — Filtros', () => {
  test.setTimeout(60000);
  test.use({ viewport: { width: 1280, height: 900 } });

  // ── 1. Visual: Filtros renderizados corretamente ─────────────────────────────

  test('filtros Caso, Buscar e Documentación são exibidos corretamente', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkersApis(page);

    await page.goto('/admin/workers');

    // Aguarda a seção de filtros carregar
    const filtersSection = page.locator(
      '.bg-white.rounded-b-\\[20px\\]',
    );
    await expect(filtersSection).toBeVisible({ timeout: 15000 });

    // Verifica labels dos três filtros
    await expect(page.getByText('Caso').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Buscar').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Documentación').first()).toBeVisible({ timeout: 5000 });

    // Screenshot visual da seção de filtros
    await expect(filtersSection).toHaveScreenshot('workers-filters-default.png');
  });

  // ── 2. Visual: SearchableSelect de Caso com dropdown aberto ─────────────────

  test('SearchableSelect de Caso abre dropdown com input de busca e opções', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkersApis(page);

    await page.goto('/admin/workers');

    // Aguarda filtros visíveis
    await expect(page.getByText('Caso').first()).toBeVisible({ timeout: 15000 });

    // Clica no botão do SearchableSelect de Caso (primeiro button dentro do filtro)
    const caseSelectButton = page.locator('[aria-haspopup="listbox"]').first();
    await expect(caseSelectButton).toBeVisible({ timeout: 10000 });
    await caseSelectButton.click();

    // Aguarda dropdown aberto
    const dropdown = page.locator('[role="listbox"]').first();
    await expect(dropdown).toBeVisible({ timeout: 5000 });

    // Verifica input de busca dentro do dropdown
    const searchInput = page.locator('input[placeholder*="Buscar"]').first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Verifica que as opções de caso são exibidas
    await expect(page.getByText('CASO 101 - Juan García').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('CASO 102 - María López').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('CASO 103').first()).toBeVisible({ timeout: 5000 });

    // Screenshot visual do dropdown aberto
    const dropdownContainer = page.locator('[aria-haspopup="listbox"]').first().locator('..');
    await expect(dropdownContainer).toHaveScreenshot('workers-case-select-open.png');
  });

  // ── 3. Visual: SearchableSelect com filtro de texto ──────────────────────────

  test('SearchableSelect de Caso filtra opções ao digitar no input de busca', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkersApis(page);

    await page.goto('/admin/workers');

    await expect(page.getByText('Caso').first()).toBeVisible({ timeout: 15000 });

    const caseSelectButton = page.locator('[aria-haspopup="listbox"]').first();
    await caseSelectButton.click();

    // Digita "García" no input de busca do dropdown
    const searchInput = page.locator('input[placeholder*="Buscar"]').first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await page.keyboard.type('García'); // o foco já está na busca do painel aberto

    // Apenas "CASO 101 - Juan García" deve aparecer
    await expect(page.getByText('CASO 101 - Juan García').first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('CASO 102 - María López')).not.toBeVisible({ timeout: 3000 });
    await expect(page.getByText('CASO 103')).not.toBeVisible({ timeout: 3000 });

    // Screenshot visual com opções filtradas
    const dropdownContainer = page.locator('[aria-haspopup="listbox"]').first().locator('..');
    await expect(dropdownContainer).toHaveScreenshot('workers-case-select-filtered.png');
  });

  // ── 4. Visual: SearchableSelect com opção selecionada ───────────────────────

  test('SearchableSelect de Caso exibe label da opção selecionada no botão fechado', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkersApis(page);

    await page.goto('/admin/workers');

    await expect(page.getByText('Caso').first()).toBeVisible({ timeout: 15000 });

    // Abre o dropdown
    const caseSelectButton = page.locator('[aria-haspopup="listbox"]').first();
    await caseSelectButton.click();

    // Seleciona "CASO 102 - María López"
    await page.getByText('CASO 102 - María López').first().click();

    // Dropdown deve fechar
    await expect(page.locator('[role="listbox"]')).not.toBeVisible({ timeout: 3000 });

    // Botão deve exibir o label da opção selecionada
    await expect(caseSelectButton).toContainText('CASO 102 - María López', { timeout: 5000 });

    // Screenshot visual do select fechado com opção selecionada
    const caseSelectContainer = caseSelectButton.locator('..');
    await expect(caseSelectContainer).toHaveScreenshot('workers-case-select-selected.png');
  });

  // ── 5. Visual: Input de busca com placeholder atualizado ────────────────────

  test('input de busca exibe placeholder "Nombre, email o teléfono"', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkersApis(page);

    await page.goto('/admin/workers');

    await expect(page.getByText('Buscar').first()).toBeVisible({ timeout: 15000 });

    // Localiza o input de busca pelo placeholder
    const searchInput = page.locator('input[placeholder="Nombre, email o teléfono"]');
    await expect(searchInput).toBeVisible({ timeout: 10000 });

    // Screenshot visual do input de busca (estado vazio com placeholder)
    await expect(searchInput).toHaveScreenshot('workers-search-input-placeholder.png');
  });

  // ── 6. Filtro de Caso envia parâmetro case_id na requisição ─────────────────

  test('filtro de Caso envia parâmetro case_id na URL da requisição', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers/case-options', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_CASE_OPTIONS }),
      }),
    );
    await page.route('**/api/admin/workers/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_STATS),
      }),
    );

    let capturedUrl = '';
    await page.route('**/api/admin/workers*', (route) => {
      const url = route.request().url();
      if (!url.includes('/stats') && !url.includes('/case-options')) {
        capturedUrl = url;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockWorkersList(),
      });
    });

    await page.goto('/admin/workers');
    await expect(page.getByText('CASO 101 - Juan García')).not.toBeVisible({ timeout: 3000 }).catch(() => {});
    await expect(page.getByText('Caso').first()).toBeVisible({ timeout: 15000 });

    // Abre e seleciona opção no SearchableSelect de Caso
    const caseSelectButton = page.locator('[aria-haspopup="listbox"]').first();
    await caseSelectButton.click();
    await page.getByText('CASO 101 - Juan García').first().click();

    // Aguarda requisição com o filtro
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        resp.url().includes('case_id=uuid-1'),
    );

    expect(capturedUrl).toContain('case_id=uuid-1');
  });

  // ── 7. Busca por telefone envia parâmetro search na requisição ───────────────

  test('busca por telefone envia parâmetro search na URL da requisição', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers/case-options', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_CASE_OPTIONS }),
      }),
    );
    await page.route('**/api/admin/workers/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_STATS),
      }),
    );

    let capturedUrl = '';
    await page.route('**/api/admin/workers*', (route) => {
      const url = route.request().url();
      if (!url.includes('/stats') && !url.includes('/case-options')) {
        capturedUrl = url;
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockWorkersList(),
      });
    });

    await page.goto('/admin/workers');
    await expect(page.getByText('Buscar').first()).toBeVisible({ timeout: 15000 });

    // Digita um número de telefone no campo de busca
    const searchInput = page.locator('input[placeholder="Nombre, email o teléfono"]');
    await expect(searchInput).toBeVisible({ timeout: 10000 });
    await searchInput.fill('+5491155550000');

    // Aguarda debounce (400ms) + requisição
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        resp.url().includes('search='),
      { timeout: 10000 },
    );

    expect(capturedUrl).toContain('search=');
    expect(decodeURIComponent(capturedUrl)).toContain('+5491155550000');
  });

  // ── 8. Limpar seleção do Caso remove case_id da requisição ──────────────────

  test('selecionar "Todos" no filtro de Caso remove o parâmetro case_id da requisição', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route('**/api/admin/workers/case-options', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_CASE_OPTIONS }),
      }),
    );
    await page.route('**/api/admin/workers/stats', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_STATS),
      }),
    );

    const capturedUrls: string[] = [];
    await page.route('**/api/admin/workers*', (route) => {
      const url = route.request().url();
      if (!url.includes('/stats') && !url.includes('/case-options')) {
        capturedUrls.push(url);
      }
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockWorkersList(),
      });
    });

    await page.goto('/admin/workers');
    await expect(page.getByText('Caso').first()).toBeVisible({ timeout: 15000 });

    const caseSelectButton = page.locator('[aria-haspopup="listbox"]').first();

    // Seleciona um caso específico
    await caseSelectButton.click();
    await page.getByText('CASO 101 - Juan García').first().click();
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        resp.url().includes('case_id=uuid-1'),
    );

    // Seleciona "Todos" para limpar o filtro
    await caseSelectButton.click();
    // "Todos" é a primeira opção (allPlaceholder) no dropdown
    await page.locator('[role="option"]').first().click();

    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        !resp.url().includes('case_id='),
    );

    const lastUrl = capturedUrls[capturedUrls.length - 1];
    expect(lastUrl).not.toContain('case_id=');
  });
});
