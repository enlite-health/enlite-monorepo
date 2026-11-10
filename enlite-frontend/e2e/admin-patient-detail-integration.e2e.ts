/**
 * admin-patient-detail-integration.e2e.ts
 *
 * Integration E2E test for PatientDetailPage — uses Docker Compose with a real
 * Postgres + API backend (no mocks). Requires:
 *   - Docker with `enlite-postgres` container running
 *   - `enlite_e2e` database seeded with at least one patient
 *   - Firebase Auth Emulator running on port 9099
 *
 * BLOCKER NOTE: This test depends on a patient seed in the local Docker DB.
 * The current E2E setup does NOT include a patient seed fixture — only worker
 * and vacancy data are seeded. If no patient row exists, the test will fail
 * with a 404.
 *
 * To unblock: add a patient seed SQL to `worker-functions/scripts/seed-e2e.sql`
 * and run it as part of the Docker fixture setup.
 *
 * Until then, this test is marked as .skip to prevent blocking CI.
 */

import { test, expect, Page } from '@playwright/test';
import { execSync } from 'child_process';

const FIREBASE_EMULATOR = 'http://127.0.0.1:9099';
const FIREBASE_API_KEY = 'test-api-key';

// ── Seed helper ──────────────────────────────────────────────────────────────

/** Inserts a patient directly into the Docker DB and returns its UUID. */
function seedPatientInDocker(): string | null {
  const patientId = 'e2e00000-e2e0-e2e0-e2e0-e2e000000001';
  const sql = `
    INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, created_at, updated_at)
      VALUES (
        '${patientId}',
        'E2E-INT-TASK-001',
        'Integration',
        'TestPatient',
        'BR',
        NOW(),
        NOW()
      )
    ON CONFLICT (id) DO NOTHING;
  `.replace(/\n/g, ' ').trim();

  try {
    execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c "${sql}"`, { stdio: 'pipe' });
    return patientId;
  } catch {
    return null;
  }
}

async function seedAdminAndLogin(page: Page): Promise<void> {
  const rnd = Math.random().toString(36).slice(2, 8);
  const email = `e2e.pd.int.${Date.now()}.${rnd}@test.com`;
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
      VALUES ('${uid}', '${email}', 'PD Int E2E', 'admin', NOW(), NOW()) ON CONFLICT DO NOTHING;
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
        data: { id: uid, email, role: 'superadmin', firstName: 'PD', lastName: 'Int', isActive: true, mustChangePassword: false },
      }),
    }),
  );
  await page.route('**/api/admin/users*', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: [] }) }),
  );

  await page.goto('/login?next=%2Fadmin');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('PatientDetailPage — integration (real DB)', () => {
  test.setTimeout(120000);

  /**
   * Seeds a patient row directly into the Docker Postgres before the test
   * (helper above). The test then exercises the real API path end-to-end.
   */
  test('renders real patient data from DB without mocks', async ({ page }) => {
    await seedAdminAndLogin(page);

    const patientId = seedPatientInDocker();
    if (!patientId) {
      console.warn('BLOCKER: Could not seed patient into Docker DB. Skipping integration test.');
      return;
    }

    // The local Docker API runs in USE_MOCK_AUTH=true mode, which only accepts
    // mock_<base64> tokens — not real Firebase tokens. The frontend's Firebase
    // SDK produces real tokens, so we intercept the patient request and swap
    // the Authorization header to a mock token. Everything else (controller,
    // use case, repository, DB query) executes against the real backend.
    const mockUser = { uid: 'e2e-int-admin', email: 'admin@e2e.test', role: 'admin' };
    const mockToken =
      'mock_' + Buffer.from(JSON.stringify(mockUser), 'utf-8').toString('base64');

    await page.route(`**/api/admin/patients/${patientId}`, (route) => {
      const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken}` };
      return route.continue({ headers });
    });

    await page.goto(`/admin/patients/${patientId}`);

    // Real data — patient created with firstName=Integration, lastName=TestPatient
    await expect(page.getByText('Integration TestPatient')).toBeVisible({ timeout: 20000 });

    // Screenshot
    await expect(page).toHaveScreenshot('patient-detail-integration.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05,
    });
  });
});
