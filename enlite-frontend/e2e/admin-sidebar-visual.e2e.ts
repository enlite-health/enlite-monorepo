/**
 * admin-sidebar-visual.e2e.ts
 *
 * Visual regression test — separação visual do bloco Admin no sidebar.
 *
 * Verifica que o rótulo "Administración" e o divisor aparecem ACIMA dos itens
 * Etiquetas e Duplicados quando o usuário tem role=admin.
 *
 * Auth: Firebase Identity Toolkit interceptado localmente (sem emulador).
 * Padrão idêntico ao usado em blocked-attempts-visual.e2e.ts.
 *
 * Nota: este teste aponta para BASE_URL dinâmica via process.env.SIDEBAR_TEST_BASE_URL
 * para permitir rodar contra o worktree correto (diferente do server padrão em 5173).
 * Padrão é http://localhost:5173 (comportamento normal em CI e main branch).
 *
 * Run (1ª vez — gera baseline):
 *   pnpm test:e2e:no-integration --update-snapshots --grep "admin-sidebar"
 * Run subsequente:
 *   pnpm test:e2e:no-integration --grep "admin-sidebar"
 */

import { test, expect, Page, Route } from '@playwright/test';

const BASE = process.env.SIDEBAR_TEST_BASE_URL ?? 'http://localhost:5173';

// ── Auth constants ────────────────────────────────────────────────────────────

const MOCK_ADMIN = {
  uid: 'sidebar-vis-admin-uid',
  email: 'sidebar.visual@e2e.test',
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

// ── Auth helper (sem emulador) ────────────────────────────────────────────────

async function installFakeFirebaseAuth(page: Page, role: string = MOCK_ADMIN.role): Promise<void> {
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

  // Profile retorna o role pedido → controla se adminItems aparecem no sidebar
  await page.route('**/api/admin/auth/profile', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: MOCK_ADMIN.uid,
          email: MOCK_ADMIN.email,
          role,
          firstName: 'Visual',
          lastName: 'Admin',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );
}

async function loginAsAdmin(page: Page, role: string = MOCK_ADMIN.role): Promise<void> {
  await installFakeFirebaseAuth(page, role);
  await page.goto(`${BASE}/admin/login`);
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });
}

// ── Mock páginas de destino ───────────────────────────────────────────────────

function mockAdminListEndpoints(page: Page): void {
  page.route('**/api/admin/users**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('AppSidebar — separação visual admin', () => {
  test.setTimeout(90000);

  test('EXPANDIDO: mostra rótulo "Administración" acima de Etiquetas e Duplicados', async ({ page }) => {
    await loginAsAdmin(page);
    mockAdminListEndpoints(page);

    // Navega para a home do admin (garante que o sidebar está visível)
    await page.goto(`${BASE}/admin`);

    // Aguarda o sidebar renderizar com os itens admin
    await expect(page.getByText('Etiquetas')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Duplicados')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Postulaciones bloqueadas')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Administración')).toBeVisible({ timeout: 10000 });

    // Captura apenas o sidebar lateral para evitar variação de conteúdo de página
    const sidebar = page.locator('aside').first();
    await expect(sidebar).toBeVisible({ timeout: 5000 });

    await expect(sidebar).toHaveScreenshot('admin-sidebar-expanded-with-section.png', {
      maxDiffPixelRatio: 0.03,
    });
  });

  test('rótulo de seção aparece entre os itens de navegação base e os itens admin', async ({ page }) => {
    await loginAsAdmin(page);
    mockAdminListEndpoints(page);

    await page.goto(`${BASE}/admin`);

    // Confirma ordem: itens base existem, depois o separador, depois Etiquetas
    await expect(page.getByText('Prestadores')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Administración')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Etiquetas')).toBeVisible({ timeout: 10000 });

    // O separador deve ter role="separator"
    await expect(page.getByRole('separator').first()).toBeVisible({ timeout: 5000 });
  });
});

test.describe('AppSidebar — visão não-admin (recruiter)', () => {
  test.setTimeout(90000);

  test('RECRUITER: sidebar NÃO mostra Postulaciones bloqueadas nem seção Administración', async ({ page }) => {
    await loginAsAdmin(page, 'recruiter');
    mockAdminListEndpoints(page);

    await page.goto(`${BASE}/admin`);

    const sidebar = page.locator('aside').first();

    // Itens base seguem visíveis
    await expect(sidebar.getByText('Usuarios')).toBeVisible({ timeout: 15000 });

    // Itens admin-only ausentes
    await expect(sidebar.getByText('Postulaciones bloqueadas')).toHaveCount(0);
    await expect(sidebar.getByText('Administración')).toHaveCount(0);
    await expect(sidebar.getByText('Etiquetas')).toHaveCount(0);

    await expect(sidebar).toHaveScreenshot('admin-sidebar-recruiter-no-section.png', {
      maxDiffPixelRatio: 0.03,
    });
  });

  test('RECRUITER: URL direta de blocked-attempts redireciona pra /admin', async ({ page }) => {
    await loginAsAdmin(page, 'recruiter');
    mockAdminListEndpoints(page);

    await page.goto(`${BASE}/admin/recruitment/blocked-attempts`);

    // Guard da page redireciona sem renderizar conteúdo da tela bloqueada
    await expect(page).toHaveURL(`${BASE}/admin`, { timeout: 15000 });
    await expect(page.locator('[data-testid="blocked-content"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="blocked-skeleton"]')).toHaveCount(0);

    const sidebar = page.locator('aside').first();
    await expect(sidebar).toHaveScreenshot('admin-sidebar-recruiter-after-redirect.png', {
      maxDiffPixelRatio: 0.03,
    });
  });

  test('RECRUITER: header do Reclutamiento NÃO mostra o link de postulaciones bloqueadas', async ({ page }) => {
    await loginAsAdmin(page, 'recruiter');
    mockAdminListEndpoints(page);
    // Dados do dashboard vazios → página renderiza estável
    await page.route('**/api/admin/recruitment/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );

    await page.goto(`${BASE}/admin/recruitment`);

    // Página renderizada, mas sem o link admin-only no header
    await expect(page.locator('aside').first().getByText('Reclutamiento')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-testid="blocked-attempts-link"]')).toHaveCount(0);

    await expect(page).toHaveScreenshot('recruitment-header-recruiter-no-link.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });
});
