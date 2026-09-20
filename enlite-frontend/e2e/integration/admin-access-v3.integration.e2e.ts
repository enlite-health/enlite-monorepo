/**
 * admin-access-v3.integration.e2e.ts @integration
 *
 * V3 do plano D268 — welcome sem grupo (A1) e feature por país (B2), contra o
 * backend REAL (não `page.route`). Backend: localhost:8089, `enforcement`
 * agora vem `'on'` em `/v1/me/authz` (API reconstruída — confirmado via token
 * mock antes deste arquivo ser escrito). DB: postgresql://enlite_admin:
 * enlite_password@localhost:5439/enlite_e2e. Vite: localhost:5183 (rodar com
 * `PW_BASE_URL=http://localhost:5183`).
 *
 * Mesmo padrão de auth de `admin-access-panel.integration.e2e.ts`: JWT fake no
 * Identity Toolkit + troca por `mock_*` em `/api/**` e `/v1/me/authz`; conta
 * pré-inserida em `users` (sem isso cai no auto-provision, que chamaria o
 * Firebase Admin de verdade — inexistente aqui).
 *
 * As 4 asserções do plano:
 *  1. staff sem grupo → welcome
 *  2. entra em grupo {AR} → painel na request seguinte (poll — cache 30s)
 *  3. sai do grupo → welcome de novo
 *  4. `screen:talentum` desligada no país do ator (AR) → rota nega (redireciona
 *     a /admin); ligada → acessa.
 *
 * ACHADO (grep evidence, `screenFeatureMap.ts`): `screen:talentum` NÃO tem
 * item de menu de topo hoje — é alcançado só via link dentro do detalhe de
 * vaga. A parte "item de menu... some" do enunciado do plano não tem alvo
 * real para esta chave; testamos só a ROTA (o que existe). O mecanismo de
 * item-de-menu está coberto por `adminNavigation.feature.test.tsx` (unit).
 */

import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { test, expect, type Page, type Route, type APIRequestContext } from '@playwright/test';

const BACKEND_URL = 'http://localhost:8089';
const DB_URL = process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const STAFF_UID = `e2e-v3-staff-${RUN_ID}`;
const STAFF_EMAIL = `${STAFF_UID}@e2e.test`;
const GROUP_NAME = `E2E V3 ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';
const TALENTUM_KEY = 'screen:talentum';
const FAKE_VACANCY_ID = randomUUID();

let groupId = '';

function psql(sql: string): string {
  try {
    return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err: any) {
    throw new Error(`DB error: ${err.stderr?.toString() ?? err.message} | sql=${sql}`);
  }
}
function scalar(sql: string): string {
  return psql(sql).trim().split('\n')[0] ?? '';
}
function safeSql(sql: string): void {
  try {
    psql(sql);
  } catch (err) {
     
    console.error(`[cleanup] falhou (seguindo): ${(err as Error).message}`);
  }
}

// ── Auth mock — idêntico ao de admin-access-panel.integration.e2e.ts ───────

interface MockUser {
  uid: string;
  email: string;
  role: string;
  country: string;
}

function tokenFor(u: MockUser): string {
  return 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');
}

function fakeIdToken(u: MockUser): string {
  return (
    'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
    Buffer.from(
      JSON.stringify({
        sub: u.uid,
        uid: u.uid,
        email: u.email,
        iss: 'https://securetoken.google.com/enlite-prd',
        aud: 'enlite-prd',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url') +
    '.'
  );
}

async function installAuthInterceptors(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse',
          localId: u.uid,
          email: u.email,
          idToken,
          refreshToken: 'fake-refresh',
          expiresIn: '3600',
          registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ users: [{ localId: u.uid, email: u.email, emailVerified: true }] }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        access_token: idToken,
        id_token: idToken,
        expires_in: '3600',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh',
      }),
    });
  });

  const swapToken = async (route: Route): Promise<void> => {
    const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken}` };
    await route.continue({ headers });
  };
  await page.route('**/api/**', swapToken);
  await page.route('**/v1/me/authz', swapToken);
}

async function loginAs(page: Page, u: MockUser): Promise<void> {
  await installAuthInterceptors(page, u);
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(u.email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

async function meAuthz(request: APIRequestContext, u: MockUser): Promise<any> {
  const res = await request.get(`${BACKEND_URL}/v1/me/authz`, {
    headers: { Authorization: `Bearer ${tokenFor(u)}` },
    failOnStatusCode: false,
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Poll genérico sobre `/v1/me/authz` — o cache do backend (~30s) exige isso antes de qualquer navegação. */
async function pollAuthz(
  request: APIRequestContext,
  u: MockUser,
  predicate: (body: any) => boolean,
  timeoutMs = 40_000,
  intervalMs = 2_000,
): Promise<{ body: any; elapsedMs: number }> {
  const start = Date.now();
  let { body } = await meAuthz(request, u);
  while (!predicate(body) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    ({ body } = await meAuthz(request, u));
  }
  return { body, elapsedMs: Date.now() - start };
}

// ── Setup / teardown ─────────────────────────────────────────────────────

test.describe('Welcome sem grupo (A1) e feature por país (B2) — integração real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(150_000);

  test.beforeAll(() => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${STAFF_UID}', '${STAFF_EMAIL}', 'E2E V3 Staff', 'recruiter', true, 'ACTIVE', '${TENANT}')`);

    groupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GROUP_NAME}', 'e2e V3 — nao mexer manual')
          RETURNING id`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${groupId}', 'AR', '${STAFF_UID}', 'e2e V3 setup')`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id = '${STAFF_UID}'`);
    if (groupId) {
      safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id = '${groupId}'`);
      safeSql(`DELETE FROM iam.user_groups WHERE group_id = '${groupId}'`);
      safeSql(`DELETE FROM iam.group_permissions WHERE group_id = '${groupId}'`);
      safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id = '${groupId}'`);
      safeSql(`DELETE FROM iam.permission_groups WHERE id = '${groupId}'`);
    }
    safeSql(`DELETE FROM iam.country_features WHERE country = 'AR' AND feature_key = '${TALENTUM_KEY}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid = '${STAFF_UID}'`);
  });

  const STAFF: MockUser = { uid: STAFF_UID, email: STAFF_EMAIL, role: 'recruiter', country: 'AR' };

  test('1. staff ACTIVE sem grupo nenhum → WelcomeNoGroupPage (enforcement=on real)', async ({ page, request }) => {
    const { body } = await meAuthz(request, STAFF);
    expect(body.enforcement, 'a API precisa estar reconstruída com o campo enforcement — verificado antes deste arquivo').toBe('on');
    expect(body.groups).toEqual([]);

    await loginAs(page, STAFF);
    await page.goto('/admin');
    await expect(page.getByText('Sua conta ainda não tem um grupo de acesso atribuído. Fale com o gestor de acessos do seu time para que ele te adicione a um.').or(
      page.getByText('Tu cuenta todavía no tiene un grupo de acceso asignado. Hablá con el gestor de accesos de tu equipo para que te agregue a uno.'),
    )).toBeVisible({ timeout: 15_000 });
    // Sem menu operacional — nenhum link de navegação admin no DOM.
    await expect(page.getByRole('link', { name: 'Accesos y permisos' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Vacantes' })).toHaveCount(0);

    await expect(page).toHaveScreenshot('admin-access-v3-welcome.png', { fullPage: false, maxDiffPixelRatio: 0.002, timeout: 20_000 });
  });

  test('2. entra no grupo {AR} → painel na request seguinte (poll)', async ({ page, request }) => {
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${STAFF_UID}', '${groupId}', '${TENANT}')`);

    const after = await pollAuthz(request, STAFF, (b) => Array.isArray(b?.groups) && b.groups.length > 0);
     
    console.log(`[prova] /v1/me/authz refletiu o grupo novo em ${after.elapsedMs}ms`);
    expect(after.body.groups.length).toBeGreaterThan(0);

    await loginAs(page, STAFF);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Usuarios Administradores' })).toBeVisible({ timeout: 15_000 });
    // BAIXA (gate rodada 4): a chave crua de i18n nunca é renderizada — essa
    // asserção era morta (sempre passava, ligada ou desligada). Texto
    // traduzido, mesmo padrão do teste 3 abaixo.
    await expect(page.getByText(/no tiene un grupo de acceso|não tem um grupo de acesso/i)).toHaveCount(0);
  });

  test('3. sai do grupo → welcome de novo', async ({ page, request }) => {
    psql(`UPDATE iam.user_groups SET removed_at = now()
          WHERE user_id = '${STAFF_UID}' AND group_id = '${groupId}' AND removed_at IS NULL`);

    const after = await pollAuthz(request, STAFF, (b) => Array.isArray(b?.groups) && b.groups.length === 0);
     
    console.log(`[prova] /v1/me/authz refletiu a saída do grupo em ${after.elapsedMs}ms`);
    expect(after.body.groups).toEqual([]);

    await loginAs(page, STAFF);
    await page.goto('/admin');
    await expect(page.getByText(/no tiene un grupo de acceso|não tem um grupo de acesso/i)).toBeVisible({ timeout: 15_000 });
  });

  test('4. screen:talentum desligada no país do ator (AR) → rota /admin/vacancies/:id/talentum redireciona; ligada → acessa', async ({
    page,
    request,
  }) => {
    // Precisa estar de volta num grupo (senão TODA rota cai no welcome, e o
    // teste mediria o gate global de A1, não o de feature por país).
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${STAFF_UID}', '${groupId}', '${TENANT}')`);
    await pollAuthz(request, STAFF, (b) => Array.isArray(b?.groups) && b.groups.length > 0);

    // Seed — iam.country_features está vazia neste ambiente (mesmo achado do
    // spec vizinho, admin-access-panel teste 9): sem UI para CRIAR, semeia por SQL.
    psql(`INSERT INTO iam.country_features (country, feature_key, enabled, source, updated_by)
          VALUES ('AR', '${TALENTUM_KEY}', false, 'default', 'e2e:v3-setup')`);

    const off = await pollAuthz(request, STAFF, (b) => b?.features?.AR?.[TALENTUM_KEY]?.enabled === false);
     
    console.log(`[prova] screen:talentum=false refletiu em ${off.elapsedMs}ms`);
    expect(off.body.features.AR[TALENTUM_KEY].enabled).toBe(false);
    expect(off.body.countries).toEqual(['AR']); // país único — a régua de useFeature não é ambígua aqui

    await loginAs(page, STAFF);
    await page.goto(`/admin/vacancies/${FAKE_VACANCY_ID}/talentum`);
    await expect(page).toHaveURL(/\/admin\/?$/, { timeout: 15_000 });

    // Liga — UPDATE direto (mesmo padrão do spec vizinho: fora de uma request
    // HTTP real, `iam.set_country_feature` recusaria por falta da GUC de ator).
    psql(`UPDATE iam.country_features SET enabled = true, source = 'override', reason = 'e2e V3 — liga para provar rota acessível', updated_by = '${STAFF_UID}', updated_at = now()
          WHERE country = 'AR' AND feature_key = '${TALENTUM_KEY}'`);
    const on = await pollAuthz(request, STAFF, (b) => b?.features?.AR?.[TALENTUM_KEY]?.enabled === true);
     
    console.log(`[prova] screen:talentum=true refletiu em ${on.elapsedMs}ms`);

    await page.goto(`/admin/vacancies/${FAKE_VACANCY_ID}/talentum`);
    await expect(page).toHaveURL(/\/admin\/vacancies\/.+\/talentum/, { timeout: 15_000 });
    // Não afirmamos nada sobre o CONTEÚDO de TalentumConfigPage — o id é
    // fictício de propósito; a prova aqui é só a ROTA não ter sido negada.
  });
});
