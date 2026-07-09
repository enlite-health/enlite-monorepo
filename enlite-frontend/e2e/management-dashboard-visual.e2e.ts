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
    equiposArmados: 12,
    equiposPorArmar: 148,
    pacientesActivos: 193,
    vacantesAbiertas: 152,
    vacantesPausadas: 15,
  },
  equipoArmada: {
    armados: 12,
    porArmar: 148,
    semConfig: 61,
    pendenteClasificacao: 24,
  },
  horas: {
    totais: 1240.5,
    aPreencher: 612,
    coberturaConSchedule: 160,
    coberturaSinSchedule: 105,
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

// Estado "config pendente": rollout do papel — sem armados reais, mas com
// N sem classificação / N sem configuração honestos (nunca um 0 falso).
const MOCK_DASHBOARD_PENDENTE = {
  ...MOCK_DASHBOARD,
  bigNumbers: { ...MOCK_DASHBOARD.bigNumbers, equiposArmados: 0, equiposPorArmar: 0 },
  equipoArmada: { armados: 0, porArmar: 0, semConfig: 61, pendenteClasificacao: 204 },
  horas: { totais: 0, aPreencher: 0, coberturaConSchedule: 0, coberturaSinSchedule: 265 },
};

function mockDashboard(page: Page, mode: 'ok' | 'error' | 'pendente' = 'ok'): void {
  page.route('**/analytics/dashboard/management', (route) => {
    if (mode === 'error') {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Internal server error' }),
      });
      return;
    }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: mode === 'pendente' ? MOCK_DASHBOARD_PENDENTE : MOCK_DASHBOARD,
      }),
    });
  });
}

test.describe('ManagementDashboardPage — visual proof', () => {
  test.setTimeout(90000);

  test('POPULADO: big numbers + equipe armada + horas + funil + cadastros', async ({ page }) => {
    await loginAsAdmin(page);
    mockDashboard(page, 'ok');

    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('mgmt-big-numbers')).toBeVisible();
    await expect(page.getByTestId('mgmt-funnel-invitados')).toContainText('3435');
    await expect(page.getByTestId('mgmt-prioridades')).toContainText('6632');
    // Seção Equipe Armada com números reais + classificação honesta.
    await expect(page.getByTestId('mgmt-equipo-armada')).toBeVisible();
    await expect(page.getByTestId('mgmt-armada-clasificacion')).toContainText('61'); // sem config
    await expect(page.getByTestId('mgmt-armada-clasificacion')).toContainText('24'); // sem classificação
    // GAP notice de ubicaciones ainda existe (horas deixou de ser GAP).
    await expect(page.getByTestId('mgmt-gap-notice').first()).toBeVisible();

    await expect(page).toHaveScreenshot('management-dashboard-populated.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('CONFIG PENDENTE: sem armados, mas expõe N sem classificação / N sem config', async ({ page }) => {
    await loginAsAdmin(page);
    mockDashboard(page, 'pendente');

    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-equipo-armada')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('mgmt-armada-clasificacion')).toContainText('204'); // pendentes
    await expect(page.getByTestId('mgmt-armada-clasificacion')).toContainText('61');  // sem config

    await expect(page.getByTestId('mgmt-equipo-armada')).toHaveScreenshot(
      'management-dashboard-equipo-armada-pendente.png',
      { maxDiffPixelRatio: 0.03 },
    );
  });

  test('ERRO: alerta com mensagem e botão de reintentar', async ({ page }) => {
    await loginAsAdmin(page);
    mockDashboard(page, 'error');

    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-error')).toBeVisible({ timeout: 20000 });
    await expect(page.getByRole('button', { name: /Reintentar/i })).toBeVisible();

    await expect(page).toHaveScreenshot('management-dashboard-error.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.03,
    });
  });
});
