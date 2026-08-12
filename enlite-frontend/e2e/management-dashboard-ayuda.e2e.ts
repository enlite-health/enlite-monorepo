/**
 * management-dashboard-ayuda.e2e.ts
 *
 * Visual E2E — "¿Qué es este número?" da Gestión a la Vista.
 * Rota: /admin/dashboard
 *
 * Prova que o "?" de um big number abre o painel lateral direito com o
 * documento do indicador (título + seções formatadas), que o de uma coluna
 * do funil abre o documento da coluna, e que Escape fecha.
 *
 * Backend mockado via page.route + auth Firebase interceptada — mesma técnica
 * de management-dashboard-visual.e2e.ts (zero dependência de dados reais).
 *
 * Run: pnpm exec playwright test --project=chromium-admin management-dashboard-ayuda --update-snapshots (1ª vez)
 */

import { test, expect, Page, Route } from '@playwright/test';

const MOCK_ADMIN = {
  uid: 'mgmt-ayuda-admin-uid',
  email: 'mgmt.ayuda@e2e.test',
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

// Payload com o shape vivo de produção (04/08/2026), valores fixos p/ screenshot.
const MOCK_DASHBOARD = {
  bigNumbers: { equiposArmados: 0, equiposPorArmar: 86, pacientesActivos: 193, vacantesAbiertas: 145, vacantesPausadas: 21 },
  equipoArmada: { armados: 0, porArmar: 86, semConfig: 3, pendenteClasificacao: 56, pctRespostaRapidaArmado: { num: 0, den: 86, excluidos: 59, pct: 0 } },
  pacientes: { activos: 193, ubicacionesActivas: 341, solicitudes: 2, entrevistaAgendada: 0, enAdmision: 5, enBusca: 113, sobrepoe: true },
  horas: { totais: 3866.2, aPreencher: 2317.5, coberturaConSchedule: 119, coberturaSinSchedule: 26, ativas: 941.1, ativasConSchedule: 40, ativasSinSchedule: 13 },
  prioridades: { completosEsperandoAgendamiento: 566, profesionalesBloqueados: 6825 },
  funnelPorPrestador: {
    total: 2590,
    recorte: 'vagas-vivas',
    periodoDias: null,
    bloqueados: 484,
    porEtapa: {
      somavel: false,
      colunas: { INVITED: 461, INICIADO: 200, PRE_SCREENING: 49, IN_PROGRESS: 1348, COMPLETED: 602, CONFIRMED: 39, SELECTED: 11, REJECTED: 631 },
    },
    consolidado: {
      somavel: true,
      colunas: { INVITED: 300, INICIADO: 90, PRE_SCREENING: 23, IN_PROGRESS: 1175, COMPLETED: 580, CONFIRMED: 38, SELECTED: 11, REJECTED: 373 },
    },
  },
  funnel: { invitados: 0, bloqueados: 0, preScreening: 0, completos: 0, agendados: 0, seleccionados: 0, rechazados: 0 },
  encuadres: { agendadosEstaSemana: 13, semDataRegistrada: 33, pctCapacidadeSemana: { agendados: 13, capacidade: 80, pct: 16.3 } },
  cadastros: { leads: 7144, completos: 318, alocados: 61, alocadosActivos: 49, alocadosCubriendoGuardias: 12, incompletos: 6825, nuevosCompletosMes: 9 },
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
          firstName: 'Ayuda',
          lastName: 'E2E',
          isActive: true,
          mustChangePassword: false,
        },
      }),
    }),
  );
}

async function openDashboard(page: Page): Promise<void> {
  await installFakeFirebaseAuth(page);
  page.route('**/analytics/dashboard/management*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: MOCK_DASHBOARD }),
    }),
  );
  page.route('**/api/admin/patients/stats*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: { total: 352, complete: 153, needsAttention: 199, createdToday: 0, createdYesterday: 1, createdLast7Days: 6 },
      }),
    }),
  );
  page.route('**/api/admin/patients/funnel*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          period: { from: '2026-07-05T00:00:00.000Z', to: '2026-08-04T00:00:00.000Z' },
          country: null,
          solicitantes: 13,
          admision: 11,
          agendadas: 2,
          vacantes: 8,
          byStatus: { SOLICITANTE: 2, ACTIVE: 193 },
        },
      }),
    }),
  );
  page.route('**/analytics/dashboard/zone-analytics*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: { zones: [], unresolvedCount: 0 } }),
    }),
  );

  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(MOCK_ADMIN.email);
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20000 });

  await page.goto('/admin/dashboard');
  await expect(page.getByTestId('mgmt-big-numbers')).toBeVisible({ timeout: 20000 });
}

test.describe('Gestión a la Vista — ¿Qué es este número?', () => {
  test.setTimeout(90000);

  test('o "?" de um big number abre o painel com o documento do indicador', async ({ page }) => {
    await openDashboard(page);

    // Sem drawer no estado inicial.
    await expect(page.getByTestId('mgmt-help-drawer')).toHaveCount(0);

    // "Pacientes activos" fica na linha RODANDO; o 1º "?" da linha é o dele.
    await page.getByTestId('mgmt-rodando').getByTestId('metric-help').first().click();

    const drawer = page.getByTestId('mgmt-help-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Pacientes activos');
    // As quatro seções do documento, formatadas.
    await expect(drawer.getByTestId('mgmt-help-que')).toBeVisible();
    await expect(drawer.getByTestId('mgmt-help-origen')).toBeVisible();
    await expect(drawer.getByTestId('mgmt-help-cambia')).toBeVisible();
    await expect(drawer.getByTestId('mgmt-help-ojo')).toBeVisible();
    // Conteúdo real do locale, não chave crua.
    await expect(drawer).toContainText('Pacientes en atención hoy');
    await expect(drawer).not.toContainText('admin.managementDashboard');

    await page.waitForTimeout(400); // fim da transição de entrada
    await expect(page).toHaveScreenshot('management-dashboard-ayuda-drawer.png', {
      maxDiffPixelRatio: 0.03,
    });
    // Artefato rastreado no repo (mesma convenção dos demais specs da tela).
    await page.screenshot({ path: 'e2e/__screenshots__/gestao-a-vista-ayuda-drawer.png' });

    // Escape fecha.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mgmt-help-drawer')).toHaveCount(0, { timeout: 2000 });
  });

  test('o "?" de uma coluna do funil abre o documento da coluna (Perdidos)', async ({ page }) => {
    await openDashboard(page);

    await page
      .getByTestId('mgmt-funnel-consolidado-REJECTED')
      .getByTestId('metric-help')
      .click();

    const drawer = page.getByTestId('mgmt-help-drawer');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Perdidos (columna)');
    await expect(drawer).toContainText('Rechazados');

    // Backdrop também fecha (clicar fora da sidebar e fora do painel).
    await page.getByTestId('mgmt-help-backdrop').click({ position: { x: 500, y: 300 } });
    await expect(page.getByTestId('mgmt-help-drawer')).toHaveCount(0, { timeout: 2000 });
  });

  test('a caixa de casos não medíveis e a seção de zona também têm ajuda', async ({ page }) => {
    await openDashboard(page);

    await page.getByTestId('mgmt-armada-clasificacion').getByTestId('metric-help').click();
    await expect(page.getByTestId('mgmt-help-drawer')).toContainText('no se pueden medir');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mgmt-help-drawer')).toHaveCount(0, { timeout: 2000 });

    await page.getByTestId('mgmt-zone-analytics').getByTestId('metric-help').click();
    await expect(page.getByTestId('mgmt-help-drawer')).toContainText('Analytics por zona');
  });

  test('os cards de Pacientes e as etapas do embudo têm documento próprio', async ({ page }) => {
    await openDashboard(page);

    // Card de stats: "Precisa atención" (o mais precisa de explicação).
    await page.getByTestId('patient-stats-needs-attention').getByTestId('metric-help').click();
    const drawer = page.getByTestId('mgmt-help-drawer');
    await expect(drawer).toContainText('Precisa atención');
    await expect(drawer).toContainText('número de caso');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('mgmt-help-drawer')).toHaveCount(0, { timeout: 2000 });

    // Etapa do embudo: "Agendadas" carrega o aviso de coorte.
    await page.getByTestId('funnel-agendadas').getByTestId('metric-help').click();
    await expect(page.getByTestId('mgmt-help-drawer')).toContainText('Agendadas (embudo)');
    await expect(page.getByTestId('mgmt-help-drawer')).toContainText('cohorte');

    await page.waitForTimeout(400); // fim da transição
    // Artefato rastreado no repo (mesma convenção dos demais specs da tela).
    await page.screenshot({ path: 'e2e/__screenshots__/gestao-a-vista-ayuda-pacientes.png' });
  });
});
