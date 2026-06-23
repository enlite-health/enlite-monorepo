/**
 * dedup-manual-merge-visual.e2e.ts
 *
 * Visual E2E — Merge Manual (Onda 5) — /admin/dedup
 *
 * Tests the full operator flow:
 *   1. Opens ManualMergeModal via "Unificar manualmente" button.
 *   2. Types a search query in "Primera cuenta" autocomplete.
 *   3. Mock GET /candidates returns 2-3 candidates with name+phone+badges.
 *   4. Verifies: names and phones appear, NO raw UUIDs visible.
 *   5. Selects candidate A (Primera cuenta chip appears).
 *   6. Selects candidate B (Segunda cuenta chip appears).
 *   7. Screenshot 1: modal with both chips filled, button enabled.
 *   8. Clicks "Comparar y unificar" — mock POST /manual-group resolves.
 *   9. MergeDirectModeBody appears with account cards.
 *   10. Screenshot 2: comparison step with cards visible.
 *
 * Auth: same Firebase mock technique as dedup-center-visual.e2e.ts.
 *
 * Run: pnpm test:e2e:no-integration --update-snapshots (1ª vez)
 *      pnpm test:e2e:no-integration (runs subsequentes)
 */

import { test, expect, Page, Route } from '@playwright/test';

// ── Auth constants (mirrors dedup-center-visual.e2e.ts) ───────────────────────

const MOCK_ADMIN = {
  uid: 'manual-merge-vis-uid',
  email: 'manual.merge@e2e.test',
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

// ── Fixture data ──────────────────────────────────────────────────────────────

// Candidate ids are opaque UUIDs — must NOT appear in the UI
const CAND_A_ID = 'cand-uuid-aaaa-1111-bbbb-2222';
const CAND_B_ID = 'cand-uuid-cccc-3333-dddd-4444';
const CAND_C_ID = 'cand-uuid-eeee-5555-ffff-6666';

const CANDIDATES = [
  {
    id: CAND_A_ID,
    name: 'María González',
    phone: '+5491112345678',
    email: 'maria@example.com',
    login_real: true,
    is_imported: false,
  },
  {
    id: CAND_B_ID,
    name: 'Carlos Importado López',
    phone: '+5491199990001',
    email: null,
    login_real: false,
    is_imported: true,
  },
  {
    id: CAND_C_ID,
    name: 'Ana Rodríguez',
    phone: '+5491155558888',
    email: 'ana@example.com',
    login_real: true,
    is_imported: false,
  },
];

// Accounts returned by POST /manual-group
const MANUAL_ACC_A = {
  id: CAND_A_ID,
  name: 'María González',
  phone_normalized: '+5491112345678',
  email: 'maria@example.com',
  tier: 'REGISTERED',
  status: 'ACTIVE',
  created_at: '2026-01-15T10:00:00Z',
  updated_at: '2026-03-01T10:00:00Z',
  wja_count: 3,
  docs_count: 2,
  encuadres_count: 1,
  login_real: true,
  is_imported: false,
};

const MANUAL_ACC_B = {
  id: CAND_B_ID,
  name: 'Carlos Importado López',
  phone_normalized: '+5491199990001',
  email: null,
  tier: 'PRE_REGISTER',
  status: 'INCOMPLETE',
  created_at: '2026-02-20T10:00:00Z',
  updated_at: '2026-02-20T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
  is_imported: true,
};

const MANUAL_GROUP_RESULT = {
  accounts: [MANUAL_ACC_A, MANUAL_ACC_B],
  survivor_suggested_id: CAND_A_ID,
  survivor_reason: 'real_account_absorbs_imported',
};

// ── Auth helper (same as dedup-center-visual.e2e.ts) ─────────────────────────

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
    if (url.includes('token') || url.includes('securetoken')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id_token: FAKE_ID_TOKEN,
          access_token: FAKE_ID_TOKEN,
          expires_in: '3600',
          token_type: 'Bearer',
          refresh_token: 'fake-refresh-token',
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
          firstName: 'Visual',
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

// ── Mock helpers ──────────────────────────────────────────────────────────────

function mockDedupQueue(page: Page): void {
  page.route('**/api/admin/dedup/groups', (route) => {
    if (route.request().url().includes('/groups/')) return route.continue();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });
}

function mockDedupHistory(page: Page): void {
  page.route('**/api/admin/dedup/history', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
}

function mockDedupImported(page: Page): void {
  page.route('**/api/admin/dedup/imported-groups**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
}

function mockCandidates(page: Page, q: string): void {
  page.route(
    `**/api/admin/dedup/candidates**`,
    (route) => {
      const url = route.request().url();
      if (url.includes(encodeURIComponent(q)) || url.includes(q)) {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: CANDIDATES }),
        });
      } else {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
        });
      }
    },
  );
}

function mockManualGroup(page: Page): void {
  page.route('**/api/admin/dedup/manual-group', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MANUAL_GROUP_RESULT }),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('DedupCenterPage — Manual Merge visual proof', () => {
  test.setTimeout(90000);

  test(
    'MERGE MANUAL: abre modal, busca candidatos, mostra dropdown sem UUID, seleciona A e B, compara, MergeDirectModeBody aparece',
    async ({ page }) => {
      await loginAsAdmin(page);
      mockDedupQueue(page);
      mockDedupHistory(page);
      mockDedupImported(page);
      mockCandidates(page, 'María');
      mockManualGroup(page);

      await page.goto('/admin/dedup');
      await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
        timeout: 20000,
      });

      // ── Open manual merge modal ───────────────────────────────────────────────
      await page.locator('[data-testid="manual-merge-open-btn"]').click();
      await expect(page.locator('[data-testid="manual-merge-modal"]')).toBeVisible({
        timeout: 10000,
      });

      // ── Type in "Primera cuenta" search field ─────────────────────────────────
      const inputA = page.locator('[data-testid="manual-account-a-input"]');
      await inputA.fill('María');

      // Wait for debounce + network mock to resolve
      await page.waitForResponse('**/api/admin/dedup/candidates**', { timeout: 5000 });

      const dropdown = page.locator('[data-testid="manual-account-a-dropdown"]');
      await expect(dropdown).toBeVisible({ timeout: 5000 });

      // ── Assert (a): names and phones appear in dropdown ──────────────────────
      await expect(page.getByText('María González', { exact: true }).first()).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByText('+5491112345678', { exact: true }).first()).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByText('Carlos Importado López', { exact: true }).first()).toBeVisible({
        timeout: 5000,
      });

      // ── Assert (b): NO raw UUIDs in the DOM ──────────────────────────────────
      await expect(page.getByText(CAND_A_ID, { exact: true })).toHaveCount(0);
      await expect(page.getByText(CAND_B_ID, { exact: true })).toHaveCount(0);
      await expect(page.getByText(CAND_C_ID, { exact: true })).toHaveCount(0);

      // Badges visible
      await expect(page.getByText('Con acceso').first()).toBeVisible({ timeout: 3000 });
      await expect(page.getByText('Importado').first()).toBeVisible({ timeout: 3000 });

      // Screenshot 1: dropdown open with candidates
      await expect(page).toHaveScreenshot('manual-merge-dropdown-candidates.png', {
        fullPage: false,
        maxDiffPixelRatio: 0.03,
      });

      // ── Select candidate A (primera opcion — María González) ─────────────────
      await page.locator('[data-testid="manual-account-a-option-0"]').click();

      // Chip for A appears
      await expect(page.locator('[data-testid="manual-account-a-chip"]')).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByText('María González').first()).toBeVisible({ timeout: 3000 });

      // ── Search and select candidate B ─────────────────────────────────────────
      // Re-mock candidates for B's search (same endpoint, different candidate selection)
      await page.unroute('**/api/admin/dedup/candidates**');
      page.route('**/api/admin/dedup/candidates**', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          // Return only B and C (A is already selected → disabled, filtered by disabledIds)
          body: JSON.stringify({
            success: true,
            data: [CANDIDATES[1], CANDIDATES[2]],
          }),
        }),
      );

      const inputB = page.locator('[data-testid="manual-account-b-input"]');
      await inputB.fill('Carlos');
      await page.waitForResponse('**/api/admin/dedup/candidates**', { timeout: 5000 });

      const dropdownB = page.locator('[data-testid="manual-account-b-dropdown"]');
      await expect(dropdownB).toBeVisible({ timeout: 5000 });

      // Select Carlos Importado López as account B
      await page.locator('[data-testid="manual-account-b-option-0"]').click();

      await expect(page.locator('[data-testid="manual-account-b-chip"]')).toBeVisible({
        timeout: 5000,
      });

      // "Comparar y unificar" button must now be enabled
      const compareBtn = page.locator('[data-testid="manual-compare-btn"]');
      await expect(compareBtn).not.toBeDisabled({ timeout: 3000 });

      // Screenshot 2: both accounts selected, button enabled
      await expect(page).toHaveScreenshot('manual-merge-both-selected.png', {
        fullPage: false,
        maxDiffPixelRatio: 0.03,
      });

      // ── Click "Comparar y unificar" ───────────────────────────────────────────
      await compareBtn.click();

      // Wait for POST /manual-group
      await page.waitForResponse('**/api/admin/dedup/manual-group', { timeout: 5000 });

      // MergeDirectModeBody appears with account cards
      await expect(
        page.locator(`[data-testid="merge-account-card-${CAND_A_ID}"]`),
      ).toBeVisible({ timeout: 10000 });
      await expect(
        page.locator(`[data-testid="merge-account-card-${CAND_B_ID}"]`),
      ).toBeVisible({ timeout: 5000 });

      // No conflict banner (reason is 'real_account_absorbs_imported')
      await expect(
        page.locator('[data-testid="imported-conflict-banner"]'),
      ).not.toBeVisible();

      // Screenshot 3: comparison step (MergeDirectModeBody)
      await expect(page).toHaveScreenshot('manual-merge-compare-step.png', {
        fullPage: false,
        maxDiffPixelRatio: 0.03,
      });
    },
  );

  test(
    'MERGE MANUAL: botão "Unificar manualmente" visível no header da página',
    async ({ page }) => {
      await loginAsAdmin(page);
      mockDedupQueue(page);
      mockDedupHistory(page);
      mockDedupImported(page);

      await page.goto('/admin/dedup');
      await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
        timeout: 20000,
      });

      const manualBtn = page.locator('[data-testid="manual-merge-open-btn"]');
      await expect(manualBtn).toBeVisible({ timeout: 5000 });

      await expect(page).toHaveScreenshot('manual-merge-header-button.png', {
        fullPage: false,
        maxDiffPixelRatio: 0.03,
      });
    },
  );
});
