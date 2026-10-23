/**
 * admin-workers-docs-validated-filter.e2e.ts
 *
 * Playwright E2E — Filtros "Documentación" e "Validación" na página /admin/workers
 *
 * Fluxos cobertos:
 *   1. Visual: 2 dropdowns independentes (Documentación + Validación) são exibidos
 *   2. Dropdown Validación exibe "Todos validados" (all_validated) e "Falta validación" (pending_validation)
 *   3. Selecionar "Todos validados" em Validación envia docs_validated=all_validated (sem docs_complete)
 *   4. Voltar para "Todos" remove docs_validated da próxima request
 *   5. Combinação: Documentación=Completos + Validación=Falta validación → docs_complete=complete&docs_validated=pending_validation
 *   6. Screenshot com ambos dropdowns ativos juntos
 */

import { test, expect, Page } from '@playwright/test';
import { escolherNoCombo } from './helpers/combobox';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

// ── Mock data ──────────────────────────────────────────────────────────────────

const MOCK_CASE_OPTIONS = [
  { value: 'uuid-1', label: 'CASO 101 - Juan García' },
  { value: 'uuid-2', label: 'CASO 102 - María López' },
];

const MOCK_WORKERS_VALIDATED = [
  {
    id: 'w3333333-0003-0003-0003-000000000003',
    name: 'Ana Validada',
    email: 'ana.validada@e2e.test',
    casesCount: 2,
    documentsComplete: true,
    documentsStatus: 'approved',
    platform: 'talentum',
    createdAt: '2026-03-10T09:00:00Z',
  },
];

const MOCK_STATS = {
  success: true,
  data: { today: 1, yesterday: 0, sevenDaysAgo: 3 },
};

function mockWorkersList(workers = MOCK_WORKERS_VALIDATED, total = workers.length) {
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
  const email    = `e2e.docsvalidated.${Date.now()}.${rnd}@test.com`;
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
      VALUES ('${uid}', '${email}', 'DocsValidated E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
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
          firstName: 'DocsValidated',
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
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

async function mockWorkersApis(page: Page, workers = MOCK_WORKERS_VALIDATED): Promise<void> {
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

/** Returns the Documentación filter wrapper (o gatilho do Combobox mora dentro dele). */
function getDocsSelect(page: Page) {
  return page.locator('[data-testid="filter-docs-status"]');
}

/** Returns the Validación filter wrapper (o gatilho do Combobox mora dentro dele). */
function getValidationSelect(page: Page) {
  return page.locator('[data-testid="filter-validation-status"]');
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('AdminWorkersPage — Filtros docs_complete e docs_validated independentes', () => {
  test.setTimeout(60000);
  test.use({ viewport: { width: 1280, height: 900 } });

  // ── 1. Visual: 2 dropdowns exibidos (Documentación + Validación) ───────────

  test('exibe dropdowns Documentación e Validación independentes', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkersApis(page);

    await page.goto('/admin/workers');

    const filtersSection = page.locator('.bg-white.rounded-b-\\[20px\\]');
    await expect(filtersSection).toBeVisible({ timeout: 15000 });

    // Ambos labels devem estar visíveis
    await expect(page.getByText('Documentación').first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Validación').first()).toBeVisible({ timeout: 10000 });

    const docsSelect = getDocsSelect(page);
    const validationSelect = getValidationSelect(page);
    await expect(docsSelect).toBeVisible({ timeout: 5000 });
    await expect(validationSelect).toBeVisible({ timeout: 5000 });

    // Documentación NÃO deve ter a opção "validated" (foi removida)
    await expect(docsSelect.locator('option[value="validated"]')).toHaveCount(0);

    // Documentación deve ter complete e incomplete
    await expect(docsSelect.locator('option[value="complete"]')).toHaveCount(1);
    await expect(docsSelect.locator('option[value="incomplete"]')).toHaveCount(1);

    // Validación deve ter all_validated e pending_validation
    await expect(validationSelect.locator('option[value="all_validated"]')).toHaveCount(1);
    await expect(validationSelect.locator('option[value="pending_validation"]')).toHaveCount(1);

    // Screenshot visual dos 2 dropdowns
    await expect(filtersSection).toHaveScreenshot('workers-docs-validated-filter-initial.png');
  });

  // ── 2. Selecionar "Todos validados" envia docs_validated=all_validated ──────

  test('selecionar "Todos validados" em Validación envia docs_validated=all_validated', async ({ page }) => {
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
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockWorkersList(),
      });
    });

    await page.goto('/admin/workers');
    await expect(page.locator('[data-testid="filter-validation-status"]')).toBeVisible({ timeout: 15000 });

    const validationSelect = getValidationSelect(page);
    await expect(validationSelect).toBeVisible({ timeout: 5000 });
    await escolherNoCombo(page, validationSelect, 'Todos validados'); // all_validated = Todos validados

    // Aguarda requisição com o filtro correto
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        resp.url().includes('docs_validated=all_validated'),
      { timeout: 10000 },
    );

    const lastUrl = capturedUrls[capturedUrls.length - 1];
    expect(lastUrl).toContain('docs_validated=all_validated');
    expect(lastUrl).not.toContain('docs_complete=');
  });

  // ── 3. Screenshot com filtro "Todos validados" selecionado ──────────────────

  test('screenshot da página com filtro "Todos validados" selecionado em Validación', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockWorkersApis(page);

    await page.goto('/admin/workers');

    const filtersSection = page.locator('.bg-white.rounded-b-\\[20px\\]');
    await expect(filtersSection).toBeVisible({ timeout: 15000 });

    const validationSelect = getValidationSelect(page);
    await expect(validationSelect).toBeVisible({ timeout: 5000 });

    // Seleciona "Todos validados"
    await escolherNoCombo(page, validationSelect, 'Todos validados'); // all_validated = Todos validados

    // Aguarda que a lista seja atualizada
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options'),
      { timeout: 10000 },
    );

    // Aguarda a tabela estar visível
    await expect(page.getByText('Ana Validada')).toBeVisible({ timeout: 10000 });

    // Screenshot: filtros com "Todos validados" selecionado + lista renderizada
    await expect(page).toHaveScreenshot('workers-docs-validated-filter.png');
  });

  // ── 4. Voltar para "Todos" remove docs_validated da request ─────────────────

  test('voltar para "Todos" remove docs_validated da próxima request', async ({ page }) => {
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
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockWorkersList(),
      });
    });

    await page.goto('/admin/workers');
    await expect(page.locator('[data-testid="filter-validation-status"]')).toBeVisible({ timeout: 15000 });

    const validationSelect = getValidationSelect(page);
    await expect(validationSelect).toBeVisible({ timeout: 5000 });

    // Seleciona "Todos validados"
    await escolherNoCombo(page, validationSelect, 'Todos validados'); // all_validated = Todos validados
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        resp.url().includes('docs_validated=all_validated'),
      { timeout: 10000 },
    );

    // Volta para "Todos": o Combobox não tem linha de limpar (o placeholder não é opção); quem limpa é o botão "Limpiar"
    await page.getByRole('button', { name: 'Limpiar', exact: true }).click();

    // Aguarda a próxima request sem docs_validated
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        !resp.url().includes('docs_validated='),
      { timeout: 10000 },
    );

    const lastUrl = capturedUrls[capturedUrls.length - 1];
    expect(lastUrl).not.toContain('docs_validated=');
    expect(lastUrl).not.toContain('docs_complete=');
  });

  // ── 5. Combinação: Documentación=Completos + Validación=Falta validación ────

  test('combinação docs_complete=complete + docs_validated=pending_validation na request', async ({ page }) => {
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
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: mockWorkersList(),
      });
    });

    await page.goto('/admin/workers');
    await expect(page.locator('[data-testid="filter-docs-status"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="filter-validation-status"]')).toBeVisible({ timeout: 10000 });

    const docsSelect = getDocsSelect(page);
    const validationSelect = getValidationSelect(page);
    await expect(docsSelect).toBeVisible({ timeout: 5000 });
    await expect(validationSelect).toBeVisible({ timeout: 5000 });

    // Seleciona "Completos" em Documentación
    await escolherNoCombo(page, docsSelect, 'Completos'); // complete = Completos
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        resp.url().includes('docs_complete=complete'),
      { timeout: 10000 },
    );

    // Seleciona "Falta validación" em Validación
    await escolherNoCombo(page, validationSelect, 'Falta validación'); // pending_validation = Falta validación
    await page.waitForResponse(
      (resp) =>
        resp.url().includes('/api/admin/workers') &&
        !resp.url().includes('/stats') &&
        !resp.url().includes('/case-options') &&
        resp.url().includes('docs_complete=complete') &&
        resp.url().includes('docs_validated=pending_validation'),
      { timeout: 10000 },
    );

    const lastUrl = capturedUrls[capturedUrls.length - 1];
    expect(lastUrl).toContain('docs_complete=complete');
    expect(lastUrl).toContain('docs_validated=pending_validation');

    // Screenshot dos 2 dropdowns ativos juntos
    const filtersSection = page.locator('.bg-white.rounded-b-\\[20px\\]');
    await expect(filtersSection).toHaveScreenshot('workers-docs-validated-filter-both-active.png');
  });
});
