/**
 * gestion-pais-humano.integration.e2e.ts @integration
 *
 * PR-9 (`lex` #9, US-22) — filtro de país na Gestão à Vista, backend REAL +
 * Postgres REAL (mesmo padrão de admission-patient-flow.integration.e2e.ts):
 * só o header de auth é trocado por `page.route`; nenhum dado é mockado.
 *
 * Seed: 2 grupos com escopo de país diferentes (AR-only vs AR+BR documentado)
 * e pacientes ACTIVE reais em AR e BR, para que o número mudar de verdade ao
 * trocar o filtro seja a prova (não um fixture combinado com o produto).
 *
 *   feliz — gestora AR+BR: "Todos" mostra a soma; escolher "Brasil" muda o
 *           número para só o de BR (screenshot).
 *   alt 1 — conta só AR: o seletor lista SÓ Argentina (sem Brasil).
 *   alt 2 — pedido forjado `?country=BR` (via page.route, reescrevendo a URL
 *           que o PRÓPRIO app manda) com conta só-AR → tela de erro 403.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { execSync } from 'child_process';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const BACKEND_URL = process.env.PW_BACKEND_URL || 'http://localhost:8080';

function runSQL(sql: string): void {
  const escaped = sql.replace(/'/g, "'\\''");
  execSync(`docker exec ${CONTAINER} psql -U enlite_admin -d enlite_e2e -v ON_ERROR_STOP=1 -c '${escaped}'`, {
    stdio: 'pipe',
  });
}

const TENANT = '00000000-0000-0000-0000-000000000001';
const SUFFIX = 'gpais'; // fixo — a suíte roda numa Postgres exclusiva da worktree (isolamento por docker -p)

const IDS = {
  patientAR1: `f9000000-b000-0001-0001-000000000001`,
  patientAR2: `f9000000-b000-0001-0002-000000000001`,
  patientBR1: `f9000000-b000-0001-0003-000000000001`,
  groupArBrDoc: `f9000000-b000-0003-0001-000000000001`,
  groupArOnly: `f9000000-b000-0003-0002-000000000001`,
  scopeArBrDocAr: `f9000000-b000-0004-0001-000000000001`,
  scopeArBrDocBr: `f9000000-b000-0004-0002-000000000001`,
  scopeArOnly: `f9000000-b000-0004-0003-000000000001`,
};

const STAFF_AR_BR = `e2e-${SUFFIX}-ar-br`;
const STAFF_AR_ONLY = `e2e-${SUFFIX}-ar-only`;

function cleanup(): void {
  runSQL(`DELETE FROM group_country_scopes WHERE group_id IN ('${IDS.groupArBrDoc}','${IDS.groupArOnly}')`);
  runSQL(`DELETE FROM user_groups WHERE user_id IN ('${STAFF_AR_BR}','${STAFF_AR_ONLY}')`);
  runSQL(`DELETE FROM permission_groups WHERE id IN ('${IDS.groupArBrDoc}','${IDS.groupArOnly}')`);
  runSQL(`DELETE FROM users WHERE firebase_uid IN ('${STAFF_AR_BR}','${STAFF_AR_ONLY}')`);
  runSQL(
    `DELETE FROM patients WHERE id IN ('${IDS.patientAR1}','${IDS.patientAR2}','${IDS.patientBR1}')`,
  );
}

function seed(): void {
  cleanup();
  runSQL(
    `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status) VALUES
       ('${IDS.patientAR1}', 'e2e-${SUFFIX}-ar-1', 'PR9', 'ArUno', 'AR', 'ACTIVE'),
       ('${IDS.patientAR2}', 'e2e-${SUFFIX}-ar-2', 'PR9', 'ArDois', 'AR', 'ACTIVE'),
       ('${IDS.patientBR1}', 'e2e-${SUFFIX}-br-1', 'PR9', 'BrUno', 'BR', 'ACTIVE')`,
  );
  runSQL(
    `INSERT INTO users (firebase_uid, email, role, tenant_id) VALUES
       ('${STAFF_AR_BR}', '${STAFF_AR_BR}@e2e.test', 'admin', '${TENANT}'),
       ('${STAFF_AR_ONLY}', '${STAFF_AR_ONLY}@e2e.test', 'admin', '${TENANT}')`,
  );
  runSQL(
    `INSERT INTO permission_groups (id, tenant_id, name) VALUES
       ('${IDS.groupArBrDoc}', '${TENANT}', 'PR9 e2e AR+BR documentado'),
       ('${IDS.groupArOnly}', '${TENANT}', 'PR9 e2e AR only')`,
  );
  runSQL(
    `INSERT INTO user_groups (user_id, group_id, tenant_id) VALUES
       ('${STAFF_AR_BR}', '${IDS.groupArBrDoc}', '${TENANT}'),
       ('${STAFF_AR_ONLY}', '${IDS.groupArOnly}', '${TENANT}')`,
  );
  runSQL(
    `INSERT INTO group_country_scopes (id, group_id, country, granted_by, reason) VALUES
       ('${IDS.scopeArBrDocAr}', '${IDS.groupArBrDoc}', 'AR', 'e2e-admin', 'e2e: gestion-pais AR'),
       ('${IDS.scopeArBrDocBr}', '${IDS.groupArBrDoc}', 'BR', 'e2e-admin', 'e2e: gestion-pais BR'),
       ('${IDS.scopeArOnly}', '${IDS.groupArOnly}', 'AR', 'e2e-admin', 'e2e: gestion-pais AR only')`,
  );
}

function mockToken(uid: string): string {
  return 'mock_' + Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.test`, role: 'admin' })).toString('base64');
}

const FAKE_ID_TOKEN =
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(JSON.stringify({ sub: 'x', iat: 0, exp: 9999999999 })).toString('base64url') +
  '.';

/**
 * Instala os interceptadores mínimos: login Firebase (fake JWT — nenhum
 * Firebase real envolvido) + troca do Authorization para o token mock em
 * TODA chamada ao backend real (`/api/**`, `/v1/**`, `/analytics/**`).
 */
async function installInterceptors(page: Page, uid: string): Promise<void> {
  const token = mockToken(uid);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: uid,
          email: `${uid}@e2e.test`,
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
      body: JSON.stringify({ users: [{ localId: uid, email: `${uid}@e2e.test`, emailVerified: true }] }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: FAKE_ID_TOKEN,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
        id_token: FAKE_ID_TOKEN,
      }),
    });
  });

  // Backend real: só troca o header de auth (contrato do USE_MOCK_AUTH) — sem
  // fabricar NENHUM corpo de resposta (nem /api/admin/auth/profile, nem
  // /v1/me/authz, nem /analytics/dashboard/management).
  await page.route(`${BACKEND_URL}/**`, async (route: Route) => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${token}` };
    await route.continue({ headers });
  });
}

/** Digitação humana (click + keyboard.type) — `.fill()` prova estado, não uso. */
async function loginAsAdmin(page: Page, uid: string): Promise<void> {
  await installInterceptors(page, uid);
  await page.goto('/admin/login');

  const emailInput = page.locator('input[type="email"]');
  await emailInput.click();
  await page.keyboard.type(`${uid}@e2e.test`);

  const passwordInput = page.locator('input[type="password"]');
  await passwordInput.click();
  await page.keyboard.type('TestAdmin123!');

  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Gestión a la Vista — filtro de país (PR-9, `lex` #9) @integration', () => {
  test.setTimeout(90_000);

  test.beforeAll(() => {
    seed();
  });

  test.afterAll(() => {
    cleanup();
  });

  test('feliz: gestora AR+BR vê o total dos dois países e, ao escolher Brasil, o número muda para só BR', async ({
    page,
  }) => {
    await loginAsAdmin(page, STAFF_AR_BR);
    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20_000 });

    // "Pacientes activos" é o 1º MetricCard do bloco RODANDO — mira o valor
    // exato (h4), não o texto da seção inteira (que contém outros números).
    const pacientesActivosValue = page.getByTestId('mgmt-rodando').locator('h4').first();

    // ALL (união AR+BR): 2 (AR) + 1 (BR) = 3 pacientes ativos.
    await expect(pacientesActivosValue).toHaveText('3', { timeout: 20_000 });

    const select = page.getByTestId('mgmt-country-filter').locator('select');
    await expect(select).toBeVisible();
    await select.selectOption('BR');

    // Só BR: 1 paciente ativo — o número mudou de verdade (contagem real, não fixture).
    await expect(pacientesActivosValue).toHaveText('1', { timeout: 20_000 });

    await expect(page.getByTestId('mgmt-content')).toHaveScreenshot('gestion-pais-brasil.png', {
      mask: [page.locator('[data-testid="mgmt-zone-analytics"]')],
    });
  });

  test('alt 1: conta só AR — o seletor lista SÓ Argentina (sem Brasil)', async ({ page }) => {
    await loginAsAdmin(page, STAFF_AR_ONLY);
    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-content')).toBeVisible({ timeout: 20_000 });

    const select = page.getByTestId('mgmt-country-filter').locator('select');
    const optionValues = await select.locator('option').evaluateAll((opts) =>
      opts.map((o) => (o as HTMLOptionElement).value),
    );

    expect(optionValues).toContain('AR');
    expect(optionValues).not.toContain('BR');
  });

  test('alt 2: pedido forjado `?country=BR` com conta só-AR → tela de erro (403 no servidor)', async ({ page }) => {
    await loginAsAdmin(page, STAFF_AR_ONLY);

    // Reescreve a request que o PRÓPRIO app manda para /analytics/dashboard/management,
    // acrescentando country=BR — simula um cliente forjado/adulterado; o servidor
    // é quem tem de recusar (FR-731), não a tela. Registrado DEPOIS do interceptador
    // genérico de `installInterceptors` (dentro de `loginAsAdmin`) — no Playwright, o
    // último `page.route` a casar tem prioridade — então este PRECISA repetir a troca
    // do header de auth (senão a request forjada sai sem token e vira 401, não 403).
    await page.route(`${BACKEND_URL}/analytics/dashboard/management*`, async (route: Route) => {
      const u = new URL(route.request().url());
      u.searchParams.set('country', 'BR');
      const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken(STAFF_AR_ONLY)}` };
      await route.continue({ url: u.toString(), headers });
    });

    await page.goto('/admin/dashboard');
    await expect(page.getByTestId('mgmt-error')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('mgmt-error')).toContainText(/AR/);
  });
});
