/**
 * worker-export.visual.e2e.ts
 *
 * Playwright E2E — Testes visuais e funcionais para a feature de Export de Workers.
 *
 * Cobre:
 *   1. Screenshot do botão "Exportar" visível na listagem (admin logado)
 *   2. Screenshot do modal aberto com todas as 33 colunas
 *   3. Screenshot do modal com 0 colunas selecionadas → botão Exportar disabled
 *   4. Screenshot do modal com filtro de status selecionado → botão habilitado
 *   5. Fechar modal via Escape
 *   6. Fechar modal via clique no overlay
 *   7. Teste funcional de download: clicar Exportar → blob baixado
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';
import { escolherNoCombo } from './helpers/combobox';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY  = 'test-api-key';

// ── Mock data ──────────────────────────────────────────────────────────────────

const MOCK_WORKERS = [
  {
    id: 'w-export-001',
    name: 'Ana Export',
    email: 'ana.export@e2e.test',
    casesCount: 1,
    documentsComplete: true,
    documentsStatus: 'approved',
    platform: 'talentum',
    createdAt: '2026-01-10T10:00:00Z',
  },
];

function mockWorkersList(workers = MOCK_WORKERS, total = workers.length) {
  return JSON.stringify({ success: true, data: workers, total, limit: 20, offset: 0 });
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd      = Math.random().toString(36).slice(2, 8);
  const email    = `e2e.export.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const signUpData = (await signUpRes.json()) as Record<string, unknown>;
  if (!signUpData.localId) {
    throw new Error(`Firebase sign-up failed: ${JSON.stringify(signUpData)}`);
  }
  const uid = signUpData.localId as string;

  try {
    const sql = `
      INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
        VALUES ('${uid}', '${email}', 'Export E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
      INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
        VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
    `.replace(/\n/g, ' ').trim();
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch { /* ignore if docker not running — mocks cover auth */ }

  // Mock auth profile with admin role
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: uid,
          email,
          role: 'admin',
          displayName: 'Export E2E',
          isActive: true,
          mustChangePassword: false,
          accessLevel: 10,
        },
      }),
    }),
  );

  await page.route('**/api/admin/workers/stats', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { today: 2, yesterday: 1, sevenDaysAgo: 5 } }),
    }),
  );

  await page.route('**/api/admin/workers/case-options', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );

  await page.route('**/api/admin/workers*', (route) => {
    if (route.request().url().includes('/export')) { route.continue(); return; }
    route.fulfill({ status: 200, contentType: 'application/json', body: mockWorkersList() });
  });

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

async function openWorkersPage(page: Page): Promise<void> {
  await page.goto('/admin/workers');
  await expect(page.getByTestId('worker-export-btn')).toBeVisible({ timeout: 15000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('Worker Export Feature', () => {
  test.setTimeout(60000);

  test('1 — botão Exportar visível na listagem para admin', async ({ page }) => {
    await seedAdminAndLogin(page);
    await openWorkersPage(page);

    const exportBtn = page.getByTestId('worker-export-btn');
    await expect(exportBtn).toBeVisible();

    // Visual: screenshot of the list header with the export button
    await expect(page.getByTestId('worker-export-btn')).toHaveScreenshot(
      'worker-export-button.png',
    );
  });

  test('2 — modal abre com todas as 33 colunas visíveis', async ({ page }) => {
    await seedAdminAndLogin(page);
    await openWorkersPage(page);

    await page.getByTestId('worker-export-btn').click();
    const modal = page.getByTestId('worker-export-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // All 33 checkboxes rendered
    const checkboxes = modal.getByRole('checkbox');
    await expect(checkboxes).toHaveCount(33);

    // Visual: full modal screenshot
    await expect(modal).toHaveScreenshot('worker-export-modal-open.png');
  });

  test('3 — botão Exportar desabilitado com 0 colunas selecionadas', async ({ page }) => {
    await seedAdminAndLogin(page);
    await openWorkersPage(page);

    await page.getByTestId('worker-export-btn').click();
    await expect(page.getByTestId('worker-export-modal')).toBeVisible({ timeout: 5000 });

    // Deselect all columns
    await page.getByText(/Deseleccionar todas|Desselecionar todas/i).click();

    const submitBtn = page.getByTestId('worker-export-submit-btn');
    await expect(submitBtn).toBeDisabled();
    await expect(page.getByTestId('export-no-columns-error')).toBeVisible();

    // Visual: modal with disabled export button
    await expect(page.getByTestId('worker-export-modal')).toHaveScreenshot(
      'worker-export-modal-no-columns.png',
    );
  });

  test('4 — botão Exportar habilitado com colunas + filtro de status selecionado', async ({ page }) => {
    await seedAdminAndLogin(page);
    await openWorkersPage(page);

    await page.getByTestId('worker-export-btn').click();
    await expect(page.getByTestId('worker-export-modal')).toBeVisible({ timeout: 5000 });

    // Select a status filter
    const selects = page.getByTestId('worker-export-modal').getByRole('combobox');
    await escolherNoCombo(page, selects.nth(1), 'Registrado'); // REGISTERED = Registrado

    const submitBtn = page.getByTestId('worker-export-submit-btn');
    await expect(submitBtn).not.toBeDisabled();

    // Visual: modal with status selected and export button enabled
    await expect(page.getByTestId('worker-export-modal')).toHaveScreenshot(
      'worker-export-modal-status-selected.png',
    );
  });

  test('5 — Escape fecha o modal', async ({ page }) => {
    await seedAdminAndLogin(page);
    await openWorkersPage(page);

    await page.getByTestId('worker-export-btn').click();
    await expect(page.getByTestId('worker-export-modal')).toBeVisible({ timeout: 5000 });

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('worker-export-modal')).not.toBeVisible({ timeout: 3000 });
  });

  test('6 — clique no overlay fecha o modal', async ({ page }) => {
    await seedAdminAndLogin(page);
    await openWorkersPage(page);

    await page.getByTestId('worker-export-btn').click();
    const modal = page.getByTestId('worker-export-modal');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click on the backdrop overlay element itself (not the inner dialog box)
    // The backdrop is the outermost element; dispatchEvent bypasses stopPropagation on inner box
    await modal.dispatchEvent('click');
    await expect(modal).not.toBeVisible({ timeout: 3000 });
  });

  test('7 — clicar Exportar dispara download do blob', async ({ page }) => {
    await seedAdminAndLogin(page);
    await openWorkersPage(page);

    // Mock the export endpoint to return a small CSV blob
    await page.route('**/api/admin/workers/export*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/csv',
        headers: {
          'content-disposition': 'attachment; filename="workers_ALL_2026-04-21.csv"',
        },
        body: 'first_name,last_name,email\nAna,Export,ana.export@e2e.test\n',
      }),
    );

    await page.getByTestId('worker-export-btn').click();
    await expect(page.getByTestId('worker-export-modal')).toBeVisible({ timeout: 5000 });

    // Trigger download and capture it
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('worker-export-submit-btn').click(),
    ]);

    expect(download).toBeTruthy();
    expect(download.suggestedFilename()).toMatch(/workers.*\.csv$/i);
  });
});
