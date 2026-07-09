/**
 * management-dashboard-visual.e2e.ts
 *
 * Visual E2E — "Dashboard para Gestão à Vista" (ClickUp 86ajb4qnw).
 * Rota: /admin/dashboard
 *
 * Prova a experiência real da coordenação via screenshot determinístico.
 * Backend mockado via page.route (endpoint /analytics/dashboard/management) —
 * zero dependência de dados reais, seguro para banco compartilhado.
 *
 * Auth: Firebase Identity Toolkit interceptado localmente (sem emulador, sem
 * conta real) — mesma técnica de blocked-attempts-visual.e2e.ts.
 *
 * Estados: POPULADO (todas as seções + GAP notices) e ERRO (retry).
 *
 * Run: pnpm exec playwright test --project=chromium-admin management-dashboard-visual --update-snapshots (1ª vez)
 */

import { test, expect, Page, Route } from '@playwright/test';

const MOCK_ADMIN = {
  uid: 'mgmt-vis-admin-uid',
  email: 'mgmt.visual@e2e.test',
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

const MOCK_DASHBOARD = {
  bigNumbers: {
    equiposArmados: 82,
    equiposPorArmar: 148,
    pacientesActivos: 193,
    vacantesAbiertas: 152,
    vacantesPausadas: 15,
  },
  prioridades: {
    completosEsperandoAgendamiento: 2387,
    profesionalesBloqueados: 6632,
  },
  funnel: {
    invitados: 3435,
    bloqueados: 405,
    preScreening: 90,
    completos: 4,
    agendados: 11,
    seleccionados: 2,
    rechazados: 2498,
  },
  encuadres: { agendadosEstaSemana: 7 },
  cadastros: {
    leads: 6882,
    completos: 250,
    alocados: 2,
    incompletos: 6632,
    nuevosCompletosMes: 14,
  },
};

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

function mockDashboard(page: Page, ok = true): void {
  page.route('**/analytics/dashboard/management', (route) =>
    route.fulfill({
      status: ok ? 200 : 500,
      contentType: 'application/json',
      body: JSON.stringify(
        ok
          ? { success: true, data: MOCK_DASHBOARD }
          : { success: false, error: 'Internal server error' },
      ),
    }),
  );
}

test.describe('ManagementDashboardPage — visual proof', () => {
  test.setTimeout(90000);

  test('POPULADO: big numbers + prioridades + funil + cadastros + GAP notices', async ({ page }) => {
    await loginAsAdmin(page);
    mockDashboard(page, true);

    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('mgmt-big-numbers')).toBeVisible();
    await expect(page.getByTestId('mgmt-funnel-invitados')).toContainText('3435');
    await expect(page.getByTestId('mgmt-prioridades')).toContainText('6632');
    // GAP notices renderizados (horas + ubicaciones), sem número fabricado.
    await expect(page.getByTestId('mgmt-gap-notice').first()).toBeVisible();

    await expect(page).toHaveScreenshot('management-dashboard-populated.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('ERRO: alerta com mensagem e botão de reintentar', async ({ page }) => {
    await loginAsAdmin(page);
    mockDashboard(page, false);

    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-error')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: /Reintentar/i })).toBeVisible();

    await expect(page).toHaveScreenshot('management-dashboard-error.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });
});
