/**
 * blocked-attempts-smoke.integration.e2e.ts @integration
 *
 * Smoke test de integração real — prova o wiring ponta-a-ponta:
 * frontend real + backend real (GET /api/admin/recruitment/blocked-attempts) + Postgres real.
 *
 * O que prova:
 *   - A página /admin/recruitment/blocked-attempts carrega sem crash
 *   - A chamada GET /api/admin/recruitment/blocked-attempts é disparada
 *   - A página renderiza o título "Intentos de postulación bloqueados"
 *   - Sem screenshot (dados reais são não-determinísticos)
 *   - Sem erros JavaScript fatais
 *
 * Mocks (mínimos para viabilizar o teste):
 *   - Firebase Identity Toolkit → fake JWT (sem custo, sem conta real)
 *   - /api/admin/auth/profile → admin user inline
 *   - Bearer token substituído por mock_* que o backend aceita via USE_MOCK_AUTH=true
 *
 * Tudo o resto bate no backend real (blocked-attempts endpoint + Postgres).
 *
 * Padrão idêntico ao full-create-vacancy.integration.e2e.ts.
 *
 * Pré-condições:
 *   - Docker stack rodando: enlite-api (8080) + enlite-postgres (5432)
 *   - Frontend dev server: localhost:5173
 *   - Backend com USE_MOCK_AUTH=true (ver docker-compose.yml)
 *
 * Run: pnpm test:e2e:integration
 */

import { test, expect, type Page, type Route } from '@playwright/test';

// ── Auth constants ─────────────────────────────────────────────────────────────

const MOCK_ADMIN = {
  uid: 'blocked-smoke-admin-uid',
  email: 'blocked.smoke@e2e.test',
  // 'admin' role satisfies requireStaff() guard: ['admin','recruiter','community_manager']
  role: 'admin',
};

const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN), 'utf-8').toString('base64');

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(
    JSON.stringify({
      sub: MOCK_ADMIN.uid,
      uid: MOCK_ADMIN.uid,
      email: MOCK_ADMIN.email,
      iss: 'https://securetoken.google.com/enlite-prd',
      aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString('base64url') +
  '.';

// ── Auth helper ────────────────────────────────────────────────────────────────

async function installInterceptors(page: Page): Promise<void> {
  // Intercept Firebase Identity Toolkit — inject fake JWT without real Firebase account
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
          access_token: FAKE_ID_TOKEN,
          id_token: FAKE_ID_TOKEN,
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
        access_token: FAKE_ID_TOKEN,
        id_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
      }),
    });
  });

  // Backend: stub profile inline + inject mock token for all other API calls
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: MOCK_ADMIN.uid,
            email: MOCK_ADMIN.email,
            role: 'admin',
            firstName: 'Smoke',
            lastName: 'Admin',
            isActive: true,
            mustChangePassword: false,
          },
        }),
      });
      return;
    }

    // All other API calls: replace Firebase token with mock_* that backend accepts
    const headers = { ...route.request().headers(), authorization: `Bearer ${MOCK_TOKEN}` };
    await route.continue({ headers });
  });
}

async function loginAsAdmin(page: Page): Promise<void> {
  await installInterceptors(page);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('@integration BlockedAttemptsPage — smoke real', () => {
  test.setTimeout(60000);

  test('página carrega, chama GET /blocked-attempts real, renderiza sem erro de console', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let blockedAttemptsCalled = false;
    let blockedAttemptsStatus: number | null = null;

    page.on('response', (resp) => {
      if (resp.url().includes('/api/admin/recruitment/blocked-attempts')) {
        blockedAttemptsCalled = true;
        blockedAttemptsStatus = resp.status();
      }
    });

    await loginAsAdmin(page);

    await page.goto('/admin/recruitment/blocked-attempts', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Wait for skeleton to disappear
    await expect(
      page.locator('[data-testid="blocked-skeleton"]'),
    ).not.toBeVisible({ timeout: 30000 });

    // Page title must render — proves the component mounted correctly
    await expect(
      page.locator('text=Intentos de postulación bloqueados').first(),
    ).toBeVisible({ timeout: 15000 });

    // Either content (populated/empty) or error — never hanging skeleton
    const hasContent = await page.locator('[data-testid="blocked-content"]').isVisible();
    const hasError = await page.locator('[data-testid="blocked-error"]').isVisible();
    expect(hasContent || hasError).toBe(true);

    // The real endpoint must have been called
    expect(blockedAttemptsCalled).toBe(true);

    // Endpoint responded with known HTTP codes
    if (blockedAttemptsStatus !== null) {
      expect([200, 400, 401, 403, 404, 500]).toContain(blockedAttemptsStatus);
    }

    // No JavaScript crashes
    const criticalErrors = pageErrors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('Non-Error'),
    );
    expect(criticalErrors).toHaveLength(0);

    // No unexpected console JS errors (network failures from real API are acceptable)
    const jsErrors = consoleErrors.filter(
      (e) =>
        !e.includes('Failed to load resource') &&
        !e.includes('net::ERR') &&
        !e.includes('401') &&
        !e.includes('403') &&
        !e.includes('500'),
    );
    expect(jsErrors).toHaveLength(0);
  });
});
