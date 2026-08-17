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
    pctRespostaRapidaArmado: { num: 0, den: 84, excluidos: 60, pct: 0 },
  },
  pacientes: {
    activos: 190, ubicacionesActivas: 339,
    solicitudes: 0, entrevistaAgendada: 1, enAdmision: 5, enBusca: 112,
    sobrepoe: true,
  },
  horas: {
    totais: 1240.5,
    aPreencher: 612,
    coberturaConSchedule: 160,
    coberturaSinSchedule: 105,
    ativas: 987.5,
    ativasConSchedule: 38,
    ativasSinSchedule: 12,
  },
  prioridades: {
    completosEsperandoAgendamiento: 2387,
    registrosIncompletos: 6632,
    bloqueadosAlPostularse: 249,
  },
  // Funil por PRESTADOR (30/07/2026): a tela conta pessoas, não cards. Duas vistas —
  // a consolidada fecha com o total, a por-etapa não (pessoa em mais de uma coluna).
  funnelPorPrestador: {
    total: 2576,
    recorte: 'vagas-vivas',
    periodoDias: null,
    bloqueados: 355,
    porEtapa: {
      somavel: false,
      colunas: {
        INVITED: 466, INICIADO: 182, PRE_SCREENING: 49, IN_PROGRESS: 1347,
        COMPLETED: 604, CONFIRMED: 27, SELECTED: 10, REJECTED: 626,
      },
    },
    consolidado: {
      somavel: true,
      colunas: {
        INVITED: 303, INICIADO: 84, PRE_SCREENING: 23, IN_PROGRESS: 1173,
        COMPLETED: 585, CONFIRMED: 27, SELECTED: 10, REJECTED: 371,
      },
    },
  },
  // Legado (por candidatura), mantido por uma release para comparação lado a lado.
  funnel: {
    invitados: 3435,
    bloqueados: 405,
    preScreening: 90,
    completos: 4,
    agendados: 11,
    seleccionados: 2,
    rechazados: 2498,
  },
  encuadres: { agendadosEstaSemana: 7, semDataRegistrada: 36, pctCapacidadeSemana: { agendados: 7, capacidade: 30, pct: 23.3 } },
  cadastros: {
    leads: 6882,
    completos: 250,
    alocados: 2,
    alocadosActivos: 2,
    alocadosCubriendoGuardias: 0,
    incompletos: 6632,
    nuevosCompletosMes: 14,
  },
};

const MOCK_ZONE_ANALYTICS = {
  zones: [
    { zone: 'Palermo', patients: 41, workersMale: 7, workersFemale: 13, demand: 55, availability: 9 },
    { zone: 'Belgrano', patients: 22, workersMale: 4, workersFemale: 6, demand: 28, availability: 5 },
    { zone: 'Não informado', patients: 3, workersMale: 0, workersFemale: 1, demand: 2, availability: 1 },
  ],
  unresolvedCount: 4,
};

function mockZoneAnalytics(page: Page, mode: 'ok' | 'empty' = 'ok'): void {
  page.route('**/analytics/dashboard/zone-analytics*', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: mode === 'empty' ? { zones: [], unresolvedCount: 0 } : MOCK_ZONE_ANALYTICS,
      }),
    });
  });
}

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
  equipoArmada: { armados: 0, porArmar: 0, semConfig: 61, pendenteClasificacao: 204, pctRespostaRapidaArmado: { num: 0, den: 84, excluidos: 60, pct: 0 } },
  horas: { ativas: 987.5, ativasConSchedule: 38, ativasSinSchedule: 12, totais: 0, aPreencher: 0, coberturaConSchedule: 0, coberturaSinSchedule: 265 },
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

  test('POPULADO: big numbers + equipe armada + horas + funil + cadastros + analytics por zona', async ({ page }) => {
    await loginAsAdmin(page);
    mockDashboard(page, 'ok');
    mockZoneAnalytics(page, 'ok');

    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20000 });
    await expect(page.getByTestId('mgmt-big-numbers')).toBeVisible();
    // O funil passou a contar PESSOAS: os cards por etapa crua (mgmt-funnel-invitados)
    // deram lugar às duas vistas por prestador.
    await expect(page.getByTestId('mgmt-funnel-consolidado-INVITED')).toContainText('303');
    await expect(page.getByTestId('mgmt-funnel-por-etapa-INVITED')).toContainText('466');
    await expect(page.getByTestId('mgmt-prioridades')).toContainText('6632'); // registros incompletos
    await expect(page.getByTestId('mgmt-prioridades')).toContainText('249'); // bloqueados al postularse (personas únicas)
    // Prova visual dedicada dos 3 cards de Prioridades (fica abaixo da dobra do fullPage 720px):
    // "Bloqueados al postularse" (249, personas únicas) vs "Registros incompletos" (6632, backlog).
    await expect(page.getByTestId('mgmt-prioridades')).toHaveScreenshot(
      'management-dashboard-prioridades.png',
      { maxDiffPixelRatio: 0.03 },
    );
    // Seção Equipe Armada com números reais + classificação honesta.
    await expect(page.getByTestId('mgmt-equipo-armada')).toBeVisible();
    await expect(page.getByTestId('mgmt-armada-clasificacion')).toContainText('61'); // sem config
    await expect(page.getByTestId('mgmt-armada-clasificacion')).toContainText('24'); // sem classificação
    // GAP notice de ubicaciones ainda existe (horas deixou de ser GAP).
    // O antigo GAP de Ubicaciones virou card real em 31/07 (linha RODANDO).
    await expect(page.getByTestId('mgmt-rodando')).toBeVisible();
    await expect(page.getByTestId('mgmt-chegando')).toBeVisible();
    // Analytics por Zona: dado do mock chega intacto na tabela.
    await expect(page.getByTestId('mgmt-zone-analytics')).toContainText('Palermo');
    await expect(page.getByTestId('mgmt-zone-analytics')).toContainText('55');

    await expect(page).toHaveScreenshot('management-dashboard-populated.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.03,
    });
  });

  test('ZONE ANALYTICS: tabela por zona + filtro de profissão + nota de "Não informado"', async ({ page }) => {
    await loginAsAdmin(page);
    mockDashboard(page, 'ok');
    mockZoneAnalytics(page, 'ok');

    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-zone-analytics')).toBeVisible({ timeout: 20000 });

    // Fidelidade request -> DOM: números do mock aparecem nas células.
    await expect(page.getByTestId('mgmt-zone-analytics')).toContainText('Palermo');
    await expect(page.getByTestId('mgmt-zone-analytics')).toContainText('Belgrano');
    await expect(page.getByTestId('mgmt-zone-analytics')).toContainText('41');
    await expect(page.getByTestId('mgmt-zone-analytics')).toContainText('13');

    // Enum de profissão nunca cru — sempre rótulo traduzido no <select>.
    await expect(
      page.getByTestId('mgmt-zone-analytics-filters').getByRole('option', { name: 'Acompañante Terapéutico' }),
    ).toBeAttached();
    await expect(
      page.getByTestId('mgmt-zone-analytics-filters').getByRole('option', { name: 'Cuidador/a' }),
    ).toBeAttached();

    // unresolvedCount é sinalizado, não some.
    await expect(page.getByTestId('mgmt-zone-analytics-unresolved-note')).toContainText('4');

    // Filtro dispara refetch com ?profession=CAREGIVER.
    const filterReq = page.waitForRequest((req) => req.url().includes('profession=CAREGIVER'));
    await page.getByTestId('mgmt-zone-analytics-filters').getByRole('combobox').selectOption('CAREGIVER');
    await filterReq;

    // Botão "Todas" volta ao geral (novo fetch sem query-param de profession).
    const clearReq = page.waitForRequest(
      (req) => req.url().includes('/zone-analytics') && !req.url().includes('profession='),
    );
    await page.getByRole('button', { name: 'Todas' }).click();
    await clearReq;

    await expect(page.getByTestId('mgmt-zone-analytics')).toHaveScreenshot(
      'management-dashboard-zone-analytics.png',
      { maxDiffPixelRatio: 0.03 },
    );
  });

  test('CONFIG PENDENTE: sem armados, mas expõe N sem classificação / N sem config', async ({ page }) => {
    await loginAsAdmin(page);
    mockDashboard(page, 'pendente');
    mockZoneAnalytics(page, 'ok');

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
