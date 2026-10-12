/**
 * login-cai-na-gestao-a-vista.integration.e2e.ts @integration
 *
 * Quem entra no painel admin começa em `/admin/dashboard` (Gestión a la Vista), e FICA lá: nem o segundo
 * redirect do `AdminLoginGuard` (~500 ms depois) nem o `FeatureRouteGate` devolvem para `/admin` (Usuarios).
 *
 * Stack REAL com o engine ABAC ligado (job `integration-e2e-group-simulation`): login pela UI, staff REAL em grupo
 * (`seedStaffInGroup`/`grantCell` de `abac-stack-helper.ts`), nada de `page.route` em dado. Célula concedida ANTES do
 * 1º request (o override liga PERMISSION_CACHE_TTL_MS=30000). Molde: `vacante-anotacao-sem-celula.integration.e2e.ts`.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { loginAs, seedStaffInGroup, cleanupStaffAndGroup, grantCell, tokenFor, type MockUser } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const COM_UID = `e2e-int-gestao-com-${RUN_ID}`;
const SEM_UID = `e2e-int-gestao-sem-${RUN_ID}`;
const STAFF_COM: MockUser = { uid: COM_UID, email: `${COM_UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const STAFF_SEM: MockUser = { uid: SEM_UID, email: `${SEM_UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const DASHBOARD_URL = /\/admin\/dashboard\/?$/;

/**
 * `installAuthInterceptors` (helper) só troca o token em `/api/**` e `/v1/me/*`; a Gestão à Vista chama
 * `/analytics/dashboard/management`, que sairia com o JWT fake e levaria 401. Troca LOCAL a este spec (forma de
 * `gestion-pais-humano.integration.e2e.ts:~156`; o `swapToken` do helper não é exportado). Instalada ANTES do
 * `loginAs`: o dashboard dispara a chamada assim que monta, e o helper não registra rota para `/analytics/**`.
 */
async function trocarTokenEmAnalytics(page: Page, u: MockUser): Promise<void> {
  await page.route('**/analytics/**', async (route: Route) => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${tokenFor(u)}` } });
  });
}

const respostaDoDashboard = (page: Page) =>
  page.waitForResponse((r) => new URL(r.url()).pathname === '/analytics/dashboard/management' && r.request().method() === 'GET');

test.describe('login cai na Gestão à Vista @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  let groupComId = '';
  let groupSemId = '';

  test.beforeAll(() => {
    ({ groupId: groupComId } = seedStaffInGroup({ uid: COM_UID, email: STAFF_COM.email, groupName: `Gestao com ${RUN_ID}`, country: 'AR' }));
    grantCell(groupComId, 'dashboard', 'read');
    // Sem `dashboard:read`, mas num grupo (sem grupo nenhum o painel mostraria a WelcomeNoGroupPage).
    ({ groupId: groupSemId } = seedStaffInGroup({ uid: SEM_UID, email: STAFF_SEM.email, groupName: `Gestao sem ${RUN_ID}`, country: 'AR' }));
    grantCell(groupSemId, 'patient', 'read');
  });

  test.afterAll(() => {
    for (const [uid, gid] of [[COM_UID, groupComId], [SEM_UID, groupSemId]] as const) {
      try {
        cleanupStaffAndGroup(uid, gid);
      } catch (err) {
        console.error('[cleanup] falhou (seguindo)', err);
      }
    }
  });

  const titulo = (page: import('@playwright/test').Page) => page.getByRole('heading', { level: 1, name: 'Gestión a la Vista' });

  test('FELIZ — staff com dashboard:read loga pela UI e fica em /admin/dashboard', async ({ page }) => {
    await trocarTokenEmAnalytics(page, STAFF_COM);
    const resposta = respostaDoDashboard(page);
    await loginAs(page, STAFF_COM);
    await expect(page).toHaveURL(DASHBOARD_URL);
    expect((await resposta).status(), 'com dashboard:read a API da tela responde 200').toBe(200);
    await expect(titulo(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('mgmt-error')).toHaveCount(0);

    await page.waitForTimeout(1_500);
    await expect(page).toHaveURL(DASHBOARD_URL);
  });

  test('ALTERNATIVO 1 — já autenticado abrindo /admin/login é levado a /admin/dashboard (AdminLoginGuard)', async ({ page }) => {
    await loginAs(page, STAFF_COM);
    await page.goto('/admin/login');
    await expect(page).toHaveURL(DASHBOARD_URL, { timeout: 15_000 });

    await page.waitForTimeout(1_500);
    await expect(page).toHaveURL(DASHBOARD_URL);
  });

  test('ALTERNATIVO 2 — sem dashboard:read pousa em /admin/dashboard, não é devolvido a /admin, e a API responde 403 e a tela mostra o erro', async ({ page }) => {
    // Fixa o comportamento ATUAL conhecido (a rota é gateada por feature de país, não por célula): sem a célula a
    // API nega e a tela mostra `mgmt-error`. Se isso mudar, o teste muda de propósito.
    await trocarTokenEmAnalytics(page, STAFF_SEM);
    const resposta = respostaDoDashboard(page);
    await loginAs(page, STAFF_SEM);
    await expect(page).toHaveURL(DASHBOARD_URL);
    expect((await resposta).status(), 'sem dashboard:read a API da tela responde 403').toBe(403);
    await expect(titulo(page)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('mgmt-error')).toBeVisible({ timeout: 15_000 });

    await page.waitForTimeout(1_500);
    await expect(page).toHaveURL(DASHBOARD_URL);
  });
});
