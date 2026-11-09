/**
 * logout.e2e.ts
 *
 * Playwright E2E — Fluxo de logout (worker e admin)
 *
 * Fluxos cobertos:
 *   - Worker clica em logout e é redirecionado visualmente para /login
 *   - Admin clica em logout e é redirecionado visualmente para /login?next=%2Fadmin
 *   - Após logout, acessar / sem auth redireciona para /login
 *   - Após logout, o formulário de login está visível (verificação visual)
 *
 * Regressão coberta:
 *   - Bug: navigate('/') após logout deixava tela branca porque
 *     React Router não forçava reavaliação da rota quando já estava em '/'.
 *   - Fix: navigate('/login') direto no handleLogout.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR  = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY   = 'test-api-key';

// ── Mock responses ─────────────────────────────────────────────────────────────

const WORKER_PROGRESS_EMPTY = {
  success: true,
  data: {
    id: 'worker-id',
    userId: 'worker-id',
    email: 'worker@e2e.test',
    name: 'Worker E2E',
    completionPercentage: 0,
    isComplete: false,
    steps: [],
  },
};

const WORKER_DOCUMENTS_EMPTY = {
  success: true,
  data: { documents: [] },
};

const JOBS_EMPTY = {
  success: true,
  data: [],
  total: 0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createFirebaseUser(email: string, password: string): Promise<string> {
  const res = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const data = (await res.json()) as { localId?: string };
  if (!data.localId) throw new Error(`Firebase sign-up failed: ${JSON.stringify(data)}`);
  return data.localId;
}

async function mockWorkerApis(page: Page): Promise<void> {
  await page.route('**/api/workers/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(WORKER_PROGRESS_EMPTY),
    }),
  );

  await page.route('**/api/workers/me/documents', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(WORKER_DOCUMENTS_EMPTY),
    }),
  );

  await page.route('**/api/jobs**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(JOBS_EMPTY),
    }),
  );

  await page.route('**/api/workers/init', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(WORKER_PROGRESS_EMPTY),
    }),
  );
}

async function loginWorker(page: Page, email: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar|Login/i }).click();
  await expect(page).toHaveURL('/', { timeout: 20_000 });
}

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd      = Math.random().toString(36).slice(2, 8);
  const email    = `e2e.logout.admin.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

  const uid = await createFirebaseUser(email, password);

  // Seed Postgres admin record
  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'Logout E2E Admin', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
      VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch {
    // Fall through — mock will cover the profile check
  }

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
          firstName: 'Logout',
          lastName: 'E2E Admin',
          displayName: 'Logout E2E Admin',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.route('**/api/admin/users**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );

  await page.goto('/login?next=%2Fadmin');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Tests — Worker ────────────────────────────────────────────────────────────

test.describe('Logout — Worker', () => {
  // Use viewport grande para que a sidebar desktop fique visível
  test.use({ viewport: { width: 1280, height: 800 } });

  test('clica em logout e vê a tela de login', async ({ page }) => {
    const rnd      = Math.random().toString(36).slice(2, 8);
    const email    = `e2e.logout.worker.${Date.now()}.${rnd}@test.com`;
    const password = 'TestWorker123!';

    await createFirebaseUser(email, password);
    await mockWorkerApis(page);
    await loginWorker(page, email, password);

    // ── Confirma que está no dashboard ──────────────────────────────────────
    await expect(page).toHaveURL('/');

    // ── Aguarda o botão de logout ficar visível na sidebar ──────────────────
    const logoutBtn = page.getByRole('button', { name: /logout/i });
    await expect(logoutBtn).toBeVisible({ timeout: 10_000 });

    // Screenshot antes do logout (prova visual do estado autenticado)
    await page.screenshot({ path: 'e2e/screenshots/worker-before-logout.png', fullPage: false });

    // ── Clica em logout ──────────────────────────────────────────────────────
    await logoutBtn.click();

    // ── Verifica redirecionamento para /login ────────────────────────────────
    await expect(page).toHaveURL('/login', { timeout: 10_000 });

    // Screenshot depois do logout (prova visual da tela de login)
    await page.screenshot({ path: 'e2e/screenshots/worker-after-logout.png', fullPage: false });

    // ── Verifica visualmente que a tela de login está presente ───────────────
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Iniciar|Entrar|Login/i })).toBeVisible();
  });

  test('após logout, acessar / sem auth redireciona para /login', async ({ page }) => {
    const rnd      = Math.random().toString(36).slice(2, 8);
    const email    = `e2e.logout.redirect.${Date.now()}.${rnd}@test.com`;
    const password = 'TestWorker123!';

    await createFirebaseUser(email, password);
    await mockWorkerApis(page);
    await loginWorker(page, email, password);

    await expect(page).toHaveURL('/');

    // Logout via sidebar
    await page.getByRole('button', { name: /logout/i }).click();
    await expect(page).toHaveURL('/login', { timeout: 10_000 });

    // Tenta navegar para / novamente após logout
    await mockWorkerApis(page); // garante que as APIs ainda estão mockadas
    await page.goto('/');

    // Deve ser redirecionado de volta para /login
    await expect(page).toHaveURL('/login', { timeout: 10_000 });
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });
});

// ── Tests — Admin ─────────────────────────────────────────────────────────────

test.describe('Logout — Admin', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('admin clica em logout e vê a tela de login do admin', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Confirma que está no painel admin
    await expect(page).toHaveURL(/\/admin/, { timeout: 10_000 });

    // Aguarda o botão de logout na sidebar admin
    const logoutBtn = page.getByRole('button', { name: /logout/i });
    await expect(logoutBtn).toBeVisible({ timeout: 10_000 });

    // Screenshot antes do logout
    await page.screenshot({ path: 'e2e/screenshots/admin-before-logout.png', fullPage: false });

    // Clica em logout
    await logoutBtn.click();

    // Verifica redirecionamento para /login?next=%2Fadmin (login único)
    await expect(page).toHaveURL('/login?next=%2Fadmin', { timeout: 10_000 });

    // Screenshot depois do logout
    await page.screenshot({ path: 'e2e/screenshots/admin-after-logout.png', fullPage: false });

    // Verifica visualmente que a tela de login admin está presente
    await expect(page.locator('input[type="email"]')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.getByRole('button', { name: /Iniciar|Entrar/i })).toBeVisible();
  });
});
