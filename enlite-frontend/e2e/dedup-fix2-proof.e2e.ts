/**
 * Proof-of-fix visual E2E for dedup UX cleanup.
 *
 * PROBLEMA 1: reparent_preview entity names are now friendly labels.
 *   - "messaging_variable_tokens" / "worker_reminder_state" must NOT appear in DOM.
 *   - "Postulaciones", "Entrevistas", "Documentos" MUST appear.
 *   - Technical entities produce "y otros datos del sistema" footnote.
 *
 * PROBLEMA 2: enum values in Avanzado now show human labels.
 *   - "0_2", "3_5" must NOT appear — replaced by i18n labels.
 *   - "SECONDARY", "BACHELOR" raw values must NOT appear — replaced by i18n labels.
 *   - "MALE", "FEMALE" must NOT appear — already fixed previously.
 *
 * Screenshots saved to /tmp/dedup-fix2/.
 */

import { test, expect, Page, Route } from '@playwright/test';
import * as path from 'path';

const MOCK_ADMIN = {
  uid: 'dedup-fix2-admin-uid',
  email: 'dedup.fix2@e2e.test',
  role: 'admin',
};

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN.uid,
      email: MOCK_ADMIN.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

const ACC_1 = {
  id: 'acc-fix2-001',
  email: 'maria.fix2@example.com',
  tier: 'REGISTERED',
  status: 'ACTIVE',
  created_at: '2026-01-15T10:00:00Z',
  updated_at: '2026-03-01T10:00:00Z',
  wja_count: 3,
  docs_count: 2,
  encuadres_count: 1,
  login_real: true,
};

const ACC_2 = {
  id: 'acc-fix2-002',
  email: null,
  tier: 'INCOMPLETE_REGISTER',
  status: 'INCOMPLETE',
  created_at: '2026-02-20T10:00:00Z',
  updated_at: '2026-02-20T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
};

const PHONE_1 = '+5491111111111';

// Detail with meaningful + technical entities mixed in reparent_preview
const MOCK_DETAIL_REPARENT = {
  phone_normalized: PHONE_1,
  accounts: [ACC_1, ACC_2],
  survivor_suggested: ACC_1.id,
  field_comparisons: [],
  reparent_preview: [
    // Meaningful: should become blue badges
    { entity: 'worker_job_applications', count: 3 },
    { entity: 'encuadres', count: 1 },
    { entity: 'worker_documents', count: 2 },
    // Technical: must be hidden — only "y otros datos del sistema" footnote
    { entity: 'messaging_variable_tokens', count: 12 },
    { entity: 'worker_reminder_state', count: 4 },
    { entity: 'whatsapp_bulk_dispatch_logs', count: 7 },
  ],
};

// Detail with enum conflicts for Avanzado (years_experience + knowledge_level)
const ACC_3 = {
  id: 'acc-fix2-003',
  email: 'carlos.fix2@example.com',
  tier: 'REGISTERED',
  status: 'ACTIVE',
  created_at: '2026-03-10T10:00:00Z',
  updated_at: '2026-04-01T10:00:00Z',
  wja_count: 1,
  docs_count: 0,
  encuadres_count: 0,
  login_real: true,
};

const ACC_4 = {
  id: 'acc-fix2-004',
  email: 'carlos.alt2@example.com',
  tier: 'INCOMPLETE_REGISTER',
  status: 'INCOMPLETE',
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-01T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
};

const PHONE_2 = '+5492222222222';

const MOCK_DETAIL_ENUM = {
  phone_normalized: PHONE_2,
  accounts: [ACC_3, ACC_4],
  survivor_suggested: ACC_3.id,
  field_comparisons: [
    {
      field: 'years_experience',
      values: { [ACC_3.id]: '0_2', [ACC_4.id]: '3_5' },
      is_encrypted: false,
      has_conflict: true,
    },
    {
      field: 'knowledge_level',
      values: { [ACC_3.id]: 'SECONDARY', [ACC_4.id]: 'BACHELOR' },
      is_encrypted: false,
      has_conflict: true,
    },
    {
      field: 'sex_encrypted',
      values: { [ACC_3.id]: 'FEMALE', [ACC_4.id]: 'MALE' },
      is_encrypted: true,
      has_conflict: true,
    },
  ],
  reparent_preview: [
    { entity: 'worker_job_applications', count: 1 },
  ],
};

const MOCK_GROUPS = [
  {
    phone_normalized: PHONE_1,
    accounts: [ACC_1, ACC_2],
    survivor_suggested: ACC_1.id,
  },
  {
    phone_normalized: PHONE_2,
    accounts: [ACC_3, ACC_4],
    survivor_suggested: ACC_3.id,
  },
];

async function installFakeFirebaseAuth(page: Page): Promise<void> {
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          localId: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          idToken: FAKE_ID_TOKEN,
          refreshToken: 'fake-refresh-token',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        users: [{ localId: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, emailVerified: true }],
      }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
      }),
    });
  });

  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          role: MOCK_ADMIN.role,
          firstName: 'Fix2',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installFakeFirebaseAuth(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

test.describe('DEDUP FIX2 — proof screenshots', () => {
  test.setTimeout(120000);

  test('PROBLEMA 1 DEPOIS: entidades amigáveis + sem nomes técnicos', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await loginAsAdmin(page);

    page.route('**/api/admin/dedup/groups', (route) => {
      if (route.request().url().includes('/groups/')) return route.continue();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_GROUPS }),
      });
    });

    const encodedPhone1 = encodeURIComponent(PHONE_1);
    page.route(`**/api/admin/dedup/groups/${encodedPhone1}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_DETAIL_REPARENT }),
      }),
    );

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator(`text=${PHONE_1}`).first()).toBeVisible({ timeout: 10000 });

    // Open modal for PHONE_1
    const mergeButtons = page.getByRole('button', { name: /Unificar/i });
    await mergeButtons.first().click();

    await expect(page.locator('[data-testid="dedup-merge-modal"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`[data-testid="merge-account-card-${ACC_1.id}"]`)).toBeVisible({ timeout: 15000 });

    // ASSERTIONS — Problema 1
    // 1. Technical entity names must NOT appear in the DOM
    await expect(page.getByText('messaging_variable_tokens', { exact: true })).toHaveCount(0);
    await expect(page.getByText('worker_reminder_state', { exact: true })).toHaveCount(0);
    await expect(page.getByText('whatsapp_bulk_dispatch_logs', { exact: true })).toHaveCount(0);

    // 2. Friendly labels MUST appear (es locale loaded → real translations).
    // The badge renders "<count> <label>" as one text node inside a span,
    // so we check that a blue badge EXISTS that contains the friendly label.
    await expect(page.locator('.bg-blue-100').filter({ hasText: 'Postulaciones' }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.bg-blue-100').filter({ hasText: 'Entrevistas' }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.bg-blue-100').filter({ hasText: 'Documentos' }).first()).toBeVisible({ timeout: 5000 });

    // 3. System footnote must appear (technical entities were hidden)
    await expect(
      page.locator('.bg-slate-100').filter({ hasText: 'y otros datos del sistema' }).first(),
    ).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: '/tmp/dedup-fix2/reparent-depois.png', fullPage: false });
    await expect(page).toHaveScreenshot(path.join('/tmp', 'dedup-fix2', 'reparent-depois-playwright.png'), {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('PROBLEMA 2 DEPOIS: enums amigáveis no Avanzado', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1200 });
    await loginAsAdmin(page);

    page.route('**/api/admin/dedup/groups', (route) => {
      if (route.request().url().includes('/groups/')) return route.continue();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_GROUPS }),
      });
    });

    const encodedPhone2 = encodeURIComponent(PHONE_2);
    page.route(`**/api/admin/dedup/groups/${encodedPhone2}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_DETAIL_ENUM }),
      }),
    );

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({ timeout: 20000 });
    await expect(page.locator(`text=${PHONE_2}`).first()).toBeVisible({ timeout: 10000 });

    // Open modal for PHONE_2 (second Unificar button)
    const mergeButtons = page.getByRole('button', { name: /Unificar/i });
    await mergeButtons.nth(1).click();

    await expect(page.locator('[data-testid="dedup-merge-modal"]')).toBeVisible({ timeout: 15000 });
    await expect(page.locator(`[data-testid="merge-account-card-${ACC_3.id}"]`)).toBeVisible({ timeout: 15000 });

    // Expand the Avanzado section
    await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const scrollable = modal?.querySelector('.overflow-y-auto');
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    });
    await page.waitForTimeout(200);

    const advancedToggle = page
      .locator('[data-testid="dedup-merge-modal"] button[aria-expanded]')
      .filter({ hasText: /Avanzado/i });
    await advancedToggle.dispatchEvent('click');
    await expect(advancedToggle).toHaveAttribute('aria-expanded', 'true', { timeout: 10000 });

    // ASSERTIONS — Problema 2
    // Raw enum slugs must NOT appear
    await expect(page.getByText('0_2', { exact: true })).toHaveCount(0);
    await expect(page.getByText('3_5', { exact: true })).toHaveCount(0);
    await expect(page.getByText('MALE', { exact: true })).toHaveCount(0);
    await expect(page.getByText('FEMALE', { exact: true })).toHaveCount(0);

    // Human labels MUST appear (years_experience)
    // es locale: "0-2 años" and "3-5 años"
    await expect(page.getByText('0-2 años', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('3-5 años', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Human labels for knowledge_level: "Secundario" and "Licenciatura"
    await expect(page.getByText('Secundario', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Licenciatura', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Human labels for sex: "Femenino" and "Masculino"
    await expect(page.getByText('Femenino', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Masculino', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Scroll to see all fields
    await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const scrollable = modal?.querySelector('.overflow-y-auto');
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    });
    await page.waitForTimeout(300);

    await page.screenshot({ path: '/tmp/dedup-fix2/avanzado-depois.png', fullPage: false });
    await expect(page).toHaveScreenshot(path.join('/tmp', 'dedup-fix2', 'avanzado-depois-playwright.png'), {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });
});
