/**
 * dedup-center-visual.e2e.ts
 *
 * Visual E2E — Centro de Duplicados (/admin/dedup)
 *
 * Objetivo: provar a experiência real do operador admin via screenshot determinístico.
 * Auth: Firebase Identity Toolkit interceptado localmente (sem emulador, sem conta real).
 * Técnica idêntica à de blocked-attempts-visual.e2e.ts.
 *
 * Estados capturados:
 *   1. FILA POPULADA — tabela com grupos, signal badges, botões de ação
 *   2. FILA VAZIA    — empty state com ícone e mensagem
 *   3. FILA ERRO     — alert com mensagem de erro e botão retry
 *   4. MODAL ABERTO  — modal de comparação com dois account cards
 *   5. MODAL MISMATCH — modal com aviso de conflito de campos
 *
 * Run: pnpm test:e2e:no-integration --update-snapshots (1ª vez)
 *      pnpm test:e2e:no-integration (runs subsequentes)
 */

import { test, expect, Page, Route } from '@playwright/test';

// ── Auth constants ─────────────────────────────────────────────────────────────

const MOCK_ADMIN = {
  uid: 'dedup-vis-admin-uid',
  email: 'dedup.visual@e2e.test',
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

// ── Fixture data ───────────────────────────────────────────────────────────────

const ACC_1 = {
  id: 'acc-dedup-001',
  email: 'maria.real@example.com',
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
  id: 'acc-dedup-002',
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

const ACC_3 = {
  id: 'acc-dedup-003',
  email: 'carlos.otro@example.com',
  tier: 'REGISTERED',
  status: 'ACTIVE',
  created_at: '2026-03-10T10:00:00Z',
  updated_at: '2026-04-01T10:00:00Z',
  wja_count: 1,
  docs_count: 1,
  encuadres_count: 0,
  login_real: true,
};

const ACC_4 = {
  id: 'acc-dedup-004',
  email: 'carlos.alt@example.com',
  tier: 'INCOMPLETE_REGISTER',
  status: 'INCOMPLETE',
  created_at: '2026-04-01T10:00:00Z',
  updated_at: '2026-04-01T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: true,
};

const PHONE_1 = '+5491112345678';
const PHONE_2 = '+5491198765432';

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

const MOCK_DETAIL_NO_CONFLICT = {
  phone_normalized: PHONE_1,
  accounts: [ACC_1, ACC_2],
  survivor_suggested: ACC_1.id,
  field_comparisons: [
    {
      field: 'email',
      values: { [ACC_1.id]: 'maria.real@example.com', [ACC_2.id]: null },
      is_encrypted: false,
      has_conflict: false,
    },
    {
      field: 'documentNumber',
      values: { [ACC_1.id]: null, [ACC_2.id]: null },
      is_encrypted: true,
      has_conflict: false,
    },
  ],
  reparent_preview: [
    { entity: 'worker_job_applications', count: 3 },
    { entity: 'worker_documents', count: 2 },
  ],
};

const MOCK_DETAIL_WITH_CONFLICT = {
  phone_normalized: PHONE_2,
  accounts: [ACC_3, ACC_4],
  survivor_suggested: ACC_3.id,
  field_comparisons: [
    {
      field: 'firstName',
      values: { [ACC_3.id]: 'Carlos', [ACC_4.id]: 'Karl' },
      is_encrypted: false,
      has_conflict: true,
    },
    {
      field: 'email',
      values: { [ACC_3.id]: 'carlos.otro@example.com', [ACC_4.id]: 'carlos.alt@example.com' },
      is_encrypted: false,
      has_conflict: true,
    },
  ],
  reparent_preview: [{ entity: 'worker_job_applications', count: 1 }],
};

// ── Auth helper ───────────────────────────────────────────────────────────────

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
        users: [{
          localId: MOCK_ADMIN.uid, email: MOCK_ADMIN.email, emailVerified: true,
        }],
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

function mockDedupPopulated(page: Page): void {
  page.route('**/api/admin/dedup/groups', (route) => {
    if (route.request().url().includes('/groups/')) return route.continue();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_GROUPS }),
    });
  });
}

function mockDedupEmpty(page: Page): void {
  page.route('**/api/admin/dedup/groups', (route) => {
    if (route.request().url().includes('/groups/')) return route.continue();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    });
  });
}

function mockDedupError(page: Page): void {
  page.route('**/api/admin/dedup/groups', (route) => {
    if (route.request().url().includes('/groups/')) return route.continue();
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Internal server error' }),
    });
  });
}

function mockGroupDetail(
  page: Page,
  phone: string,
  detail: typeof MOCK_DETAIL_NO_CONFLICT,
): void {
  const encoded = encodeURIComponent(phone);
  page.route(`**/api/admin/dedup/groups/${encoded}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: detail }),
    }),
  );
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('DedupCenterPage — visual proof', () => {
  test.setTimeout(90000);

  test('FILA POPULADA: tabela com grupos, signal badges, ações', async ({ page }) => {
    await loginAsAdmin(page);
    mockDedupPopulated(page);

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });

    // Verify key content is visible
    await expect(page.locator(`text=${PHONE_1}`).first()).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator(`text=${PHONE_2}`).first()).toBeVisible({
      timeout: 5000,
    });

    await expect(page).toHaveScreenshot('dedup-center-populated.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('FILA VAZIA: empty state com ícone e mensagem', async ({ page }) => {
    await loginAsAdmin(page);
    mockDedupEmpty(page);

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });
    await expect(page.locator('[data-testid="dedup-empty"]')).toBeVisible({
      timeout: 10000,
    });

    await expect(page).toHaveScreenshot('dedup-center-empty.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('FILA ERRO: alerta de erro com botão retry', async ({ page }) => {
    await loginAsAdmin(page);
    mockDedupError(page);

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-error"]')).toBeVisible({
      timeout: 20000,
    });

    await expect(page).toHaveScreenshot('dedup-center-error.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('MODAL ABERTO: modal de comparação com account cards', async ({ page }) => {
    await loginAsAdmin(page);
    mockDedupPopulated(page);
    mockGroupDetail(page, PHONE_1, MOCK_DETAIL_NO_CONFLICT);

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });
    await expect(page.locator(`text=${PHONE_1}`).first()).toBeVisible({
      timeout: 10000,
    });

    // Click the Merge button for PHONE_1
    const mergeButtons = page.getByRole('button', { name: /Unificar/i });
    await mergeButtons.first().click();

    await expect(page.locator('[data-testid="dedup-merge-modal"]')).toBeVisible({
      timeout: 15000,
    });

    // Wait for account cards to load
    await expect(
      page.locator(`[data-testid="merge-account-card-${ACC_1.id}"]`),
    ).toBeVisible({ timeout: 15000 });

    await expect(page).toHaveScreenshot('dedup-center-modal-open.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('MODAL MISMATCH: modal com aviso de conflito de campos', async ({ page }) => {
    await loginAsAdmin(page);
    mockDedupPopulated(page);
    mockGroupDetail(page, PHONE_2, MOCK_DETAIL_WITH_CONFLICT);

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });
    await expect(page.locator(`text=${PHONE_2}`).first()).toBeVisible({
      timeout: 10000,
    });

    // Click the second Merge button (for PHONE_2)
    const mergeButtons = page.getByRole('button', { name: /Unificar/i });
    await mergeButtons.nth(1).click();

    await expect(page.locator('[data-testid="dedup-merge-modal"]')).toBeVisible({
      timeout: 15000,
    });

    // Wait for mismatch alert
    await expect(page.locator('[data-testid="merge-mismatch-alert"]')).toBeVisible({
      timeout: 15000,
    });

    await expect(page).toHaveScreenshot('dedup-center-modal-mismatch.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });
});
