/**
 * admin-patient-detail-not-found.e2e.ts
 *
 * E2E test for the PatientDetailPage 404 / not-found state.
 *
 * Covers:
 *   - Backend returns 404 → page shows "Paciente não encontrado" / "Paciente no encontrado"
 *   - "Voltar à lista" / "Volver a la lista" button is present
 *   - Clicking the button navigates back to /admin/patients
 *   - Screenshot assertion
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

const NON_EXISTENT_ID = '00000000-0000-0000-0000-000000000000';

// ── Helper ───────────────────────────────────────────────────────────────────

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.pd.404.${Date.now()}.${rnd}@test.com`;
  const password = 'TestAdmin123!';

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

  const sql = `
    INSERT INTO users (firebase_uid, email, display_name, role, created_at, updated_at)
      VALUES ('${uid}', '${email}', 'PD 404 E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
    INSERT INTO admins_extension (user_id, must_change_password, created_at, updated_at)
      VALUES ('${uid}', false, NOW(), NOW()) ON CONFLICT DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
  } catch { /* fall through */ }

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { id: uid, email, role: 'superadmin', firstName: 'PD', lastName: '404', isActive: true, mustChangePassword: false },
      }),
    }),
  );
  await page.route('**/api/admin/users*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
  );
  await page.route('**/api/admin/patients/stats*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { total: 0, complete: 0, needsAttention: 0, createdToday: 0, createdYesterday: 0, createdLast7Days: 0 } }),
    }),
  );
  await page.route('**/api/admin/patients*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [], total: 0 }) }),
  );

  await page.goto('/login?next=%2Fadmin');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('PatientDetailPage — 404 not found', () => {
  test.setTimeout(90000);

  test('shows not-found message when backend returns 404', async ({ page }) => {
    await seedAdminAndLogin(page);

    // Mock 404 response
    await page.route(`**/api/admin/patients/${NON_EXISTENT_ID}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Patient not found' }),
      }),
    );

    await page.goto(`/admin/patients/${NON_EXISTENT_ID}`);

    await expect(
      page.getByText(/Paciente não encontrado|Paciente no encontrado/i).first(),
    ).toBeVisible({ timeout: 15000 });
  });

  test('back-to-list button is present', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${NON_EXISTENT_ID}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Patient not found' }),
      }),
    );

    await page.goto(`/admin/patients/${NON_EXISTENT_ID}`);
    await expect(
      page.getByText(/Paciente não encontrado|Paciente no encontrado/i).first(),
    ).toBeVisible({ timeout: 15000 });

    const backButton = page.getByRole('button', { name: /Voltar à lista|Volver a la lista/i });
    await expect(backButton.first()).toBeVisible({ timeout: 5000 });
  });

  test('clicking back-to-list navigates to /admin/patients', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${NON_EXISTENT_ID}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Patient not found' }),
      }),
    );

    await page.goto(`/admin/patients/${NON_EXISTENT_ID}`);
    await expect(
      page.getByText(/Paciente não encontrado|Paciente no encontrado/i).first(),
    ).toBeVisible({ timeout: 15000 });

    const backButton = page.getByRole('button', { name: /Voltar à lista|Volver a la lista/i });
    await backButton.first().click();

    await expect(page).toHaveURL(/\/admin\/patients$/, { timeout: 10000 });
  });

  test('screenshot — 404 state', async ({ page }) => {
    await seedAdminAndLogin(page);

    await page.route(`**/api/admin/patients/${NON_EXISTENT_ID}`, (route) =>
      route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Patient not found' }),
      }),
    );

    await page.goto(`/admin/patients/${NON_EXISTENT_ID}`);
    await expect(
      page.getByText(/Paciente não encontrado|Paciente no encontrado/i).first(),
    ).toBeVisible({ timeout: 15000 });

    await expect(page).toHaveScreenshot('patient-detail-not-found.png', {
      maxDiffPixelRatio: 0.05,
    });
  });
});
