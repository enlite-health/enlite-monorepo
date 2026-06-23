/**
 * dedup-center-visual.e2e.ts
 *
 * Visual E2E — Centro de Duplicados (/admin/dedup)
 *
 * Objetivo: provar a experiência real do operador admin via screenshot determinístico.
 * Auth: Firebase Identity Toolkit interceptado localmente (sem emulador, sem conta real).
 * Técnica idêntica à de blocked-attempts-visual.e2e.ts.
 *
 * Estados capturados (Onda 2):
 *   1. FILA POPULADA — tabela com grupos, signal badges, botões de ação
 *   2. FILA VAZIA    — empty state com ícone e mensagem
 *   3. FILA ERRO     — alert com mensagem de erro e botão retry
 *   4. MODAL ABERTO  — modal de comparação com dois account cards
 *   5. MODAL MISMATCH — modal com aviso de conflito de campos
 *
 * Estados capturados (Onda 3):
 *   6. HISTÓRICO COM ITENS — aba Historial com linhas, badges de categoria,
 *      botão Deshacer apenas em itens can_undo=true
 *   7. MODAL DESFAZER ABERTO — modal UndoConfirmModal com phone exibido
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

// ── Onda 3 fixtures ───────────────────────────────────────────────────────────

const AUDIT_1 = 101;
const AUDIT_2 = 102;

const MOCK_HISTORY = [
  {
    audit_id: AUDIT_1,
    survivor_id: ACC_1.id,
    absorbed_id: ACC_2.id,
    survivor_name: 'María González',
    absorbed_name: '(importado)',
    phone_normalized: PHONE_1,
    category: 'firebase',
    created_at: '2026-06-20T10:00:00Z',
    can_undo: true,
  },
  {
    audit_id: AUDIT_2,
    survivor_id: ACC_3.id,
    absorbed_id: ACC_4.id,
    survivor_name: 'Carlos López',
    absorbed_name: null,
    phone_normalized: PHONE_2,
    category: 'most_complete',
    created_at: '2026-06-19T08:00:00Z',
    can_undo: false,
  },
];

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
    // PII encriptada agora DECRIPTADA pelo backend (endpoint admin-only).
    // A UI mostra o valor real + um 🔒 discreto, e o campo é selecionável.
    // Valores distintos dos campos públicos pra ancorar o scroll/screenshot.
    {
      field: 'first_name_encrypted',
      values: { [ACC_3.id]: 'NombreCifradoUno', [ACC_4.id]: 'NombreCifradoDos' },
      is_encrypted: true,
      has_conflict: true,
    },
    {
      // enum sex → renderizado via i18n (MALE/FEMALE → label traduzido)
      field: 'sex_encrypted',
      values: { [ACC_3.id]: 'MALE', [ACC_4.id]: 'FEMALE' },
      is_encrypted: true,
      has_conflict: true,
    },
  ],
  reparent_preview: [{ entity: 'worker_job_applications', count: 1 }],
};

// 9-conflict fixture — triggers the scroll bug: Advanced section expands with
// many rows and pushes the footer out of the visible card area.
const PHONE_MANY = '+5491155550000';
const ACC_MANY_A = {
  id: 'acc-many-a',
  email: 'a.scroll@example.com',
  tier: 'REGISTERED',
  status: 'ACTIVE',
  created_at: '2026-01-01T10:00:00Z',
  updated_at: '2026-04-01T10:00:00Z',
  wja_count: 5,
  docs_count: 3,
  encuadres_count: 1,
  login_real: true,
};
const ACC_MANY_B = {
  id: 'acc-many-b',
  email: 'b.scroll@example.com',
  tier: 'INCOMPLETE_REGISTER',
  status: 'INCOMPLETE',
  created_at: '2026-02-15T10:00:00Z',
  updated_at: '2026-02-15T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
};

const MOCK_DETAIL_MANY_CONFLICTS = {
  phone_normalized: PHONE_MANY,
  accounts: [ACC_MANY_A, ACC_MANY_B],
  survivor_suggested: ACC_MANY_A.id,
  field_comparisons: [
    'firstName', 'lastName', 'email', 'documentNumber',
    'birthDate', 'nationality', 'address', 'profession', 'specialty',
  ].map((field, i) => ({
    field,
    values: { [ACC_MANY_A.id]: `valor-a-${i}`, [ACC_MANY_B.id]: `valor-b-${i}` },
    is_encrypted: false,
    has_conflict: true,
  })),
  reparent_preview: [
    { entity: 'worker_job_applications', count: 5 },
    { entity: 'worker_documents', count: 3 },
  ],
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

function mockDedupHistory(page: Page): void {
  page.route('**/api/admin/dedup/history', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_HISTORY }),
    }),
  );
}

function mockDedupManyConflicts(page: Page): void {
  // Adds PHONE_MANY group to the queue list
  page.route('**/api/admin/dedup/groups', (route) => {
    if (route.request().url().includes('/groups/')) return route.continue();
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [
          ...MOCK_GROUPS,
          {
            phone_normalized: PHONE_MANY,
            accounts: [ACC_MANY_A, ACC_MANY_B],
            survivor_suggested: ACC_MANY_A.id,
          },
        ],
      }),
    });
  });
  // Detail endpoint for the many-conflict group
  const encoded = encodeURIComponent(PHONE_MANY);
  page.route(`**/api/admin/dedup/groups/${encoded}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_DETAIL_MANY_CONFLICTS }),
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

  test('AVANZADO ENCRIPTADO: campos PII decriptados, valor visível + 🔒, selecionáveis', async ({ page }) => {
    // Tall viewport so the modal + expanded Advanced section fit without the
    // internal scroll clipping the decrypted PII rows out of the captured frame.
    await page.setViewportSize({ width: 1280, height: 1600 });
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

    const mergeButtons = page.getByRole('button', { name: /Unificar/i });
    await mergeButtons.nth(1).click();

    await expect(page.locator('[data-testid="dedup-merge-modal"]')).toBeVisible({
      timeout: 15000,
    });

    // Expand the "Avanzado" section. Scroll the modal's overflow container to
    // the bottom so the toggle is in view, then dispatch the click via JS
    // (avoids Playwright's "intercepted by overflow parent" false positive).
    const advancedToggle = page
      .locator('[data-testid="dedup-merge-modal"] button[aria-expanded]')
      .filter({ hasText: /Avanzado/i });
    await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const scrollable = modal?.querySelector('.overflow-y-auto');
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    });
    await page.waitForTimeout(200);
    await advancedToggle.dispatchEvent('click');
    await expect(advancedToggle).toHaveAttribute('aria-expanded', 'true', {
      timeout: 10000,
    });

    // The decrypted value for the encrypted field must be present (not just 🔒).
    const encryptedValue = page.getByText('NombreCifradoUno', { exact: true }).first();
    await expect(encryptedValue).toBeAttached({ timeout: 10000 });
    // The raw enum MALE/FEMALE must NOT leak — sex_encrypted is rendered via i18n.
    await expect(page.getByText('MALE', { exact: true })).toHaveCount(0);
    await expect(page.getByText('FEMALE', { exact: true })).toHaveCount(0);

    // Scroll the modal's overflow container to the bottom so the decrypted PII
    // rows (values + 🔒 markers) sit in the visible band, then snapshot the page.
    await encryptedValue.scrollIntoViewIfNeeded();
    await expect(encryptedValue).toBeVisible({ timeout: 10000 });
    await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const scrollable = modal?.querySelector('.overflow-y-auto');
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    });
    await page.waitForTimeout(300);

    await expect(page).toHaveScreenshot('dedup-center-modal-advanced-encrypted.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  // ── Onda 3 visual tests ─────────────────────────────────────────────────────

  test('HISTORIAL COM ITENS: aba com linhas, categoria badge, botão Deshacer condicional', async ({ page }) => {
    await loginAsAdmin(page);
    mockDedupPopulated(page);
    mockDedupHistory(page);

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });

    // Navigate to History tab (button text comes from i18n — es locale key = "Historial")
    const historyTabBtn = page.getByRole('button', { name: /Historial|Histórico/i });
    await historyTabBtn.click();

    await expect(page.locator('[data-testid="dedup-history-content"]')).toBeVisible({
      timeout: 10000,
    });

    // Verify the table is visible with correct content
    await expect(
      page.locator('[data-testid="history-table-container"]'),
    ).toBeVisible({ timeout: 10000 });

    // (a) Human names must appear in the table
    await expect(page.getByText('María González', { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText('(importado)', { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });

    // (b) Raw UUIDs must NOT appear in the document
    await expect(page.getByText(ACC_1.id, { exact: true })).toHaveCount(0);
    await expect(page.getByText(ACC_2.id, { exact: true })).toHaveCount(0);

    // (b) Raw category string 'firebase' must NOT appear — should be "Cuenta con acceso"
    //     (the i18n key admin.dedup.history.category.firebase resolves to the label)
    await expect(page.getByText('firebase', { exact: true })).toHaveCount(0);
    await expect(
      page.locator('.bg-blue-100').filter({ hasText: /Cuenta con acceso/i }).first(),
    ).toBeVisible({ timeout: 5000 });

    // Only AUDIT_1 should have the undo button (can_undo=true)
    await expect(
      page.locator(`[data-testid="undo-btn-${AUDIT_1}"]`),
    ).toBeVisible({ timeout: 5000 });
    await expect(
      page.locator(`[data-testid="undo-btn-${AUDIT_2}"]`),
    ).not.toBeVisible();

    await expect(page).toHaveScreenshot('dedup-center-history-populated.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  // ── Onda 4b visual tests ────────────────────────────────────────────────────

  test('IMPORTADOS POPULADOS: aba com aviso de name-match, toggle e grupos', async ({ page }) => {
    const ACC_IMP_REAL = {
      id: 'acc-real-vis-001',
      email: 'maria.gonzalez@example.com',
      tier: 'REGISTERED',
      status: 'ACTIVE',
      created_at: '2026-01-10T10:00:00Z',
      updated_at: '2026-03-01T10:00:00Z',
      wja_count: 2,
      docs_count: 1,
      encuadres_count: 0,
      login_real: true,
      is_imported: false,
    };
    const ACC_IMP_IMPORTED = {
      id: 'acc-imp-vis-001',
      email: null,
      tier: 'PRE_REGISTER',
      status: 'INCOMPLETE',
      created_at: '2026-02-15T10:00:00Z',
      updated_at: '2026-02-15T10:00:00Z',
      wja_count: 0,
      docs_count: 0,
      encuadres_count: 0,
      login_real: false,
      is_imported: true,
    };
    const MOCK_IMPORTED_GROUPS = [
      {
        accounts: [ACC_IMP_REAL, ACC_IMP_IMPORTED],
        survivor_suggested_id: ACC_IMP_REAL.id,
        survivor_reason: 'real_account_absorbs_imported',
        has_real: true,
      },
    ];

    await loginAsAdmin(page);
    mockDedupPopulated(page);
    mockDedupHistory(page);

    page.route('**/api/admin/dedup/imported-groups**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_IMPORTED_GROUPS }),
      }),
    );

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });

    // Navigate to Importados tab
    const importedTabBtn = page.getByRole('button', { name: /Importados/i });
    await importedTabBtn.click();

    await expect(
      page.locator('[data-testid="dedup-imported-content"]'),
    ).toBeVisible({ timeout: 10000 });

    // Warning banner must be visible
    await expect(
      page.locator('[data-testid="imported-name-match-warning"]'),
    ).toBeVisible({ timeout: 5000 });

    // Toggle must be present
    await expect(
      page.locator('[data-testid="only-with-real-toggle"]'),
    ).toBeVisible({ timeout: 5000 });

    // Merge button for the group
    await expect(
      page.locator('[data-testid="imported-merge-btn-0"]'),
    ).toBeVisible({ timeout: 5000 });

    await expect(page).toHaveScreenshot('dedup-center-imported-populated.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('IMPORTADOS MODAL ABERTO: modal em modo direct-accounts com survivor real', async ({ page }) => {
    const ACC_IMP_REAL = {
      id: 'acc-real-vis-002',
      email: 'juan.perez@example.com',
      tier: 'REGISTERED',
      status: 'ACTIVE',
      created_at: '2026-01-10T10:00:00Z',
      updated_at: '2026-03-01T10:00:00Z',
      wja_count: 5,
      docs_count: 3,
      encuadres_count: 1,
      login_real: true,
      is_imported: false,
    };
    const ACC_IMP_IMPORTED = {
      id: 'acc-imp-vis-002',
      email: null,
      tier: 'PRE_REGISTER',
      status: 'INCOMPLETE',
      created_at: '2026-03-01T10:00:00Z',
      updated_at: '2026-03-01T10:00:00Z',
      wja_count: 0,
      docs_count: 0,
      encuadres_count: 0,
      login_real: false,
      is_imported: true,
    };
    const MOCK_IMPORTED_GROUPS = [
      {
        accounts: [ACC_IMP_REAL, ACC_IMP_IMPORTED],
        survivor_suggested_id: ACC_IMP_REAL.id,
        survivor_reason: 'real_account_absorbs_imported',
        has_real: true,
      },
    ];

    await loginAsAdmin(page);
    mockDedupPopulated(page);
    mockDedupHistory(page);

    page.route('**/api/admin/dedup/imported-groups**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: MOCK_IMPORTED_GROUPS }),
      }),
    );

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });

    // Navigate to Importados tab
    const importedTabBtn = page.getByRole('button', { name: /Importados/i });
    await importedTabBtn.click();

    await expect(
      page.locator('[data-testid="dedup-imported-content"]'),
    ).toBeVisible({ timeout: 10000 });

    // Click the merge button to open modal
    await page.locator('[data-testid="imported-merge-btn-0"]').click();

    // Modal should appear
    await expect(
      page.locator('[data-testid="dedup-merge-modal"]'),
    ).toBeVisible({ timeout: 10000 });

    // Survivor card should be visible (no phone label in direct mode)
    await expect(
      page.locator(`[data-testid="merge-account-card-${ACC_IMP_REAL.id}"]`),
    ).toBeVisible({ timeout: 10000 });

    // No conflict banner for real_account_absorbs_imported
    await expect(
      page.locator('[data-testid="imported-conflict-banner"]'),
    ).not.toBeVisible();

    await expect(page).toHaveScreenshot('dedup-center-imported-modal-open.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  // ── Bug-fix scroll test (atualizado: prova scroll REAL via scrollHeight/clientHeight) ──

  test('MODAL SCROLL: com 9 conflitos o miolo rola e o footer fica visível', async ({ page }) => {
    // Regression test for the layout bug where many Advanced-section fields
    // pushed the content beyond max-h-[90vh] with no scrollbar, cutting off
    // the footer and making it unreachable.
    //
    // Prova REAL de scroll: mede scrollHeight > clientHeight no container rolável
    // (não apenas presença no DOM), rola até o fundo e confirma que o último
    // campo e o footer ficam dentro do viewport do modal.
    await loginAsAdmin(page);
    mockDedupManyConflicts(page);

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });

    // Click Unificar for PHONE_MANY (the 3rd row)
    const mergeButtons = page.getByRole('button', { name: /Unificar/i });
    await mergeButtons.nth(2).click();

    await expect(page.locator('[data-testid="dedup-merge-modal"]')).toBeVisible({
      timeout: 15000,
    });

    // Wait for account cards
    await expect(
      page.locator(`[data-testid="merge-account-card-${ACC_MANY_A.id}"]`),
    ).toBeVisible({ timeout: 15000 });

    // Scroll the overflow container to the bottom so the toggle is in view,
    // then dispatch click via JS to avoid Playwright pointer interception.
    await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const scrollable = modal?.querySelector('.overflow-y-auto');
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    });
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const toggle = modal?.querySelector('button[aria-expanded]');
      if (toggle) (toggle as HTMLElement).click();
    });
    await page.waitForTimeout(400);

    // All 9 conflict field rows must be in the DOM after expanding
    await expect(page.getByText('valor-a-0').first()).toBeAttached({ timeout: 8000 });
    await expect(page.getByText('valor-a-8').first()).toBeAttached({ timeout: 5000 });

    // ── PROVA REAL DE SCROLL (antes só checava presença no DOM) ───────────────
    // 1. scrollHeight > clientHeight prova que o container TEM conteúdo rolável.
    const scrollMetrics = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const scrollable = modal?.querySelector('.overflow-y-auto') as HTMLElement | null;
      return {
        scrollHeight: scrollable?.scrollHeight ?? -1,
        clientHeight: scrollable?.clientHeight ?? -1,
        overflowY: scrollable ? window.getComputedStyle(scrollable).overflowY : 'none',
      };
    });

    // O container deve ter conteúdo excedente (overflow real, não apenas DOM)
    expect(scrollMetrics.scrollHeight).toBeGreaterThan(scrollMetrics.clientHeight);
    expect(scrollMetrics.overflowY).toBe('auto');

    // 2. Rola até o fundo e verifica que o último campo fica dentro da área
    //    visível do container scrollável (não cortado pelo overflow).
    await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const scrollable = modal?.querySelector('.overflow-y-auto');
      if (scrollable) scrollable.scrollTop = scrollable.scrollHeight;
    });
    await page.waitForTimeout(300);

    // O último campo de conflito (último row do Avanzado) deve estar dentro
    // da área visível do scrollable após rolar até o fundo.
    // "Dentro da área visível" significa que a row do campo está com seu
    // bottom dentro do scrollRect do container (não cortado pelo overflow).
    const lastFieldVisible = await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]') as HTMLElement | null;
      const scrollable = modal?.querySelector('.overflow-y-auto') as HTMLElement | null;
      if (!scrollable) return false;
      const scrollRect = scrollable.getBoundingClientRect();

      // O Avanzado expandido renderiza rows com class "px-4 py-3 flex flex-col gap-2"
      // dentro do container ".divide-y.divide-slate-100" que fica DENTRO do scrollable.
      const advancedRows = scrollable.querySelectorAll('.divide-y.divide-slate-100 > .px-4.py-3');
      if (!advancedRows.length) return false;
      const lastRow = advancedRows[advancedRows.length - 1] as HTMLElement;
      const rowRect = lastRow.getBoundingClientRect();

      // A row do último campo está dentro dos limites verticais do container scrollável
      return (
        rowRect.top >= scrollRect.top - 16 && // tolerância de 16px
        rowRect.bottom <= scrollRect.bottom + 16
      );
    });
    expect(lastFieldVisible).toBe(true);

    // 3. O footer (Confirmar unificación) deve estar visível com Advanced expandido.
    const confirmBtn = page.getByRole('button', { name: /Confirmar unificación/i });
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });

    // Screenshot final: modal com Advanced expandido, rolado ao fundo — mostra
    // o último campo E o footer visíveis simultaneamente.
    await expect(page).toHaveScreenshot('dedup-center-modal-scroll-9-conflicts.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  // ── Bug-fix enum misto de prod (valores ES/EN em caixa mista) ────────────────

  test('MODAL ENUM MISTO: "mujer"/"Hombre"/"Femenino"/"male" mostram label amigável', async ({ page }) => {
    // Regression test para o bug onde valores reais de prod em espanhol/inglês
    // em caixa mista (mujer, Hombre, Varón, Femenino, Masculino, male, female)
    // apareciam crus em vez de labels amigáveis via i18n.
    //
    // A tentativa anterior de fix só checava MALE/FEMALE (sintético). Esta
    // suite usa valores REAIS e MISTOS de prod.
    await loginAsAdmin(page);
    // Reutiliza mockDedupManyConflicts mas sobrescreve o detail com valores mistos
    mockDedupManyConflicts(page);

    // Adicionar grupo extra com valores mistos reais de enum
    const PHONE_MISTO = '+5491166660000';
    const ACC_MISTO_A = { ...ACC_MANY_A, id: 'acc-misto-a', email: 'misto.a@example.com' };
    const ACC_MISTO_B = { ...ACC_MANY_B, id: 'acc-misto-b', email: 'misto.b@example.com' };
    const encodedMisto = encodeURIComponent(PHONE_MISTO);
    page.route(`**/api/admin/dedup/groups/${encodedMisto}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            phone_normalized: PHONE_MISTO,
            accounts: [ACC_MISTO_A, ACC_MISTO_B],
            survivor_suggested: ACC_MISTO_A.id,
            field_comparisons: [
              // Valores mistos reais de prod (ES e EN, caixa mista)
              {
                field: 'sex_encrypted',
                values: { [ACC_MISTO_A.id]: 'mujer', [ACC_MISTO_B.id]: 'Hombre' },
                is_encrypted: true,
                has_conflict: true,
              },
              {
                field: 'gender_encrypted',
                values: { [ACC_MISTO_A.id]: 'Femenino', [ACC_MISTO_B.id]: 'male' },
                is_encrypted: true,
                has_conflict: true,
              },
            ],
            reparent_preview: [],
          },
        }),
      }),
    );
    // Sobrescreve a lista para incluir PHONE_MISTO como 4o grupo
    page.route('**/api/admin/dedup/groups', (route) => {
      if (route.request().url().includes('/groups/')) return route.continue();
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: [
            ...MOCK_GROUPS,
            { phone_normalized: PHONE_MANY, accounts: [ACC_MANY_A, ACC_MANY_B], survivor_suggested: ACC_MANY_A.id },
            { phone_normalized: PHONE_MISTO, accounts: [ACC_MISTO_A, ACC_MISTO_B], survivor_suggested: ACC_MISTO_A.id },
          ],
        }),
      });
    });

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({ timeout: 20000 });

    // Abrir modal para o grupo com enum misto (4o botão Unificar)
    const mergeButtons = page.getByRole('button', { name: /Unificar/i });
    await mergeButtons.nth(3).click();

    await expect(page.locator('[data-testid="dedup-merge-modal"]')).toBeVisible({ timeout: 15000 });
    await expect(
      page.locator(`[data-testid="merge-account-card-${ACC_MISTO_A.id}"]`),
    ).toBeVisible({ timeout: 15000 });

    // Expandir Avanzado
    await page.evaluate(() => {
      const modal = document.querySelector('[data-testid="dedup-merge-modal"]');
      const toggle = modal?.querySelector('button[aria-expanded]');
      if (toggle) (toggle as HTMLElement).click();
    });
    await page.waitForTimeout(400);

    // "mujer" não deve aparecer cru — deve ser substituído pelo label i18n
    await expect(page.getByText('mujer', { exact: true })).toHaveCount(0);
    // "Hombre" não deve aparecer cru
    await expect(page.getByText('Hombre', { exact: true })).toHaveCount(0);
    // Labels amigáveis devem aparecer (via i18n: Masculino/Femenino no es locale)
    // Em testes reais com locale carregado, a i18n traduz a key para "Femenino"/"Masculino".
    // Como o dev server carrega as traduções reais, podemos checar o texto visible.
    const sexRow = page.locator('.px-4.py-3.flex.flex-col.gap-2').filter({
      has: page.locator('span', { hasText: /Sexo/i }),
    });
    // O campo sex_encrypted deve conter "Femenino" (mujer→Femenino) e "Masculino" (Hombre→Masculino)
    await expect(sexRow.getByText('Femenino', { exact: true }).first()).toBeVisible({ timeout: 5000 });
    await expect(sexRow.getByText('Masculino', { exact: true }).first()).toBeVisible({ timeout: 5000 });

    // Screenshot mostrando "Femenino"/"Masculino" em vez de "mujer"/"Hombre"
    await expect(page).toHaveScreenshot('dedup-center-modal-enum-misto.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('MODAL DESHACER ABERTO: confirmação com phone exibido', async ({ page }) => {
    await loginAsAdmin(page);
    mockDedupPopulated(page);
    mockDedupHistory(page);

    await page.goto('/admin/dedup');
    await expect(page.locator('[data-testid="dedup-content"]')).toBeVisible({
      timeout: 20000,
    });

    // Navigate to History tab
    const historyTabBtn = page.getByRole('button', { name: /Historial|Histórico/i });
    await historyTabBtn.click();

    await expect(
      page.locator('[data-testid="history-table-container"]'),
    ).toBeVisible({ timeout: 10000 });

    // Click the Deshacer button for AUDIT_1
    await page.locator(`[data-testid="undo-btn-${AUDIT_1}"]`).click();

    // Modal should appear
    await expect(
      page.locator('[data-testid="undo-confirm-modal"]'),
    ).toBeVisible({ timeout: 10000 });

    // Phone should be visible in the modal
    await expect(page.locator(`text=${PHONE_1}`).nth(1)).toBeVisible({
      timeout: 5000,
    });

    await expect(page).toHaveScreenshot('dedup-center-undo-modal-open.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });
});
