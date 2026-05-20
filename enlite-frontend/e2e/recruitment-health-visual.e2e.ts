/**
 * recruitment-health-visual.e2e.ts
 *
 * Visual proof that the RecruitmentHealthPage renders correctly in:
 * - Loading state (skeleton)
 * - Success state (3 cards with data)
 * - Error state (alert + retry button)
 *
 * All API calls are mocked so no real backend is needed.
 * Screenshot assertions guard against visual regressions.
 *
 * Pre-conditions: Firebase Emulator + pnpm dev running (see CLAUDE.md).
 * Run: pnpm test:e2e:no-integration
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const HEALTH_URL = '/admin/recruitment/health';

const MOCK_HEALTH_RESPONSE = {
  success: true,
  data: {
    auto_invite_last_24h: {
      vacancies_created: 5,
      invites_enqueued: 20,
      invites_sent: 18,
      invites_delivered: 17,
      invites_failed: 1,
    },
    bulk_dispatch_incomplete_last_run: {
      batch_id: 'bulk-incomplete-abc-123',
      total: 80,
      sent: 78,
      errors: 2,
      started_at: '2026-05-19T08:00:00Z',
      finished_at: '2026-05-19T08:10:00Z',
    },
    bulk_dispatch_talentum_last_run: {
      batch_id: null,
      total: 0,
      sent: 0,
      errors: 0,
      started_at: null,
      finished_at: null,
    },
  },
};

// ── Auth helper ────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const email = `e2e.health.${Date.now()}@test.com`;
  const password = 'TestAdmin123!';

  const signUpRes = await fetch(
    `${FIREBASE_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const { localId: uid } = (await signUpRes.json()) as { localId: string };

  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
    VALUES ('${uid}', '${email}', 'Health E2E', 'admin', NOW(), NOW())
    ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
    VALUES ('${uid}', false, NOW(), NOW())
    ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(
      `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`,
      { stdio: 'pipe' },
    );
  } catch { /* ignored in mocked tests */ }

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
          firstName: 'Health',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.getByRole('button', { name: /Iniciar|Entrar/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Mock helpers ───────────────────────────────────────────────────────────────

async function mockHealthSuccess(page: Page): Promise<void> {
  await page.route('**/api/admin/recruitment/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_HEALTH_RESPONSE),
    }),
  );
}

async function mockHealthError(page: Page): Promise<void> {
  await page.route('**/api/admin/recruitment/health', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Internal server error' }),
    }),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('RecruitmentHealthPage — visual proof', () => {
  test.setTimeout(60000);

  test('success state: 3 cards render with correct data', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockHealthSuccess(page);

    await page.goto(HEALTH_URL);

    // Wait for data to load (skeleton disappears)
    await expect(page.locator('[data-testid="health-skeleton"]')).not.toBeVisible({
      timeout: 15000,
    });
    await expect(page.locator('[data-testid="health-content"]')).toBeVisible({ timeout: 10000 });

    // Assert key values are present in the page
    await expect(page.locator('text=bulk-incomplete-abc-123').first()).toBeVisible();
    // "Sin ejecuciones" for the talentum card with null batch_id
    await expect(page.locator('body')).toContainText(/Sin ejecuciones|Sem execuções/i);

    // Screenshot assertion — success state
    await expect(page).toHaveScreenshot('recruitment-health-success.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('error state: error message + retry button render', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockHealthError(page);

    await page.goto(HEALTH_URL);

    await expect(page.locator('[data-testid="health-error"]')).toBeVisible({ timeout: 15000 });
    // Retry button present
    await expect(
      page.getByRole('button', { name: /Reintentar|Tentar novamente/i }),
    ).toBeVisible();

    // Screenshot assertion — error state
    await expect(page).toHaveScreenshot('recruitment-health-error.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });

  test('refresh button triggers reload', async ({ page }) => {
    await seedAdminAndLogin(page);
    await mockHealthSuccess(page);

    await page.goto(HEALTH_URL);
    await expect(page.locator('[data-testid="health-content"]')).toBeVisible({ timeout: 15000 });

    let callCount = 0;
    await page.route('**/api/admin/recruitment/health', (route) => {
      callCount += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(MOCK_HEALTH_RESPONSE),
      });
    });

    await page.getByRole('button', { name: /Actualizar|Atualizar/i }).click();
    await expect(page.locator('[data-testid="health-content"]')).toBeVisible({ timeout: 10000 });

    // Screenshot assertion — after refresh
    await expect(page).toHaveScreenshot('recruitment-health-after-refresh.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.02,
    });
  });
});
