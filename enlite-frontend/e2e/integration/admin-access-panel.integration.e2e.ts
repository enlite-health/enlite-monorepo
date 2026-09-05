/**
 * admin-access-panel.integration.e2e.ts @integration
 *
 * Prova que `/admin/access` (o painel de permissões ABAC) OPERA contra o
 * backend real — não o mock de `e2e/admin-access.e2e.ts` (`page.route`
 * declarado no próprio arquivo). Backend: localhost:8089 (USE_MOCK_AUTH=true,
 * PERMISSION_ENGINE_ENABLED=true, as 12 famílias em PERMISSION_ENFORCED_ROUTES).
 * DB: postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e
 * (container `abac-postgres` — NÃO `enlite-postgres`, que é outro worktree).
 *
 * Padrão de auth: `identitytoolkit.googleapis.com` interceptado (JWT fake) e
 * `/api/**` troca o Authorization por `mock_<base64>` — IGUAL ao padrão de
 * `admission-patient-flow.integration.e2e.ts:20-110`, EXCETO que aqui
 * `/api/admin/auth/profile` e `/v1/me/authz` NÃO são mockados: são o próprio
 * contrato sob teste (C2/C3). Por isso as duas contas são pré-inseridas em
 * `users` por SQL — sem a linha, `GetAdminProfileUseCase` cairia no
 * auto-provision (chamada real ao Firebase Admin, que não existe aqui).
 *
 * Achados de wiring incompleto (documentados linha a linha onde aparecem):
 *  - CONSERTADO (D268 A1): existe `WelcomeNoGroupPage` — com
 *    `authz.enforcement === 'on'`, `AdminProtectedRoute` troca TODO o shell
 *    `/admin/*` por ela quando o ator não tem grupo (ou está inativo), em vez
 *    de cair em `AdminUsersPage` sem tela dedicada (teste 7).
 *  - `AuthzContract.features` (país → featureKey) não tem NENHUM consumidor em
 *    `src/presentation` — desligar uma feature por país muda o contrato, não
 *    o DOM.
 *  - CONSERTADO (D269 Parte 3): `vacancy:write` não gateava o botão "Nueva
 *    Vacante" — `ActionButton` agora cobre a família vagas (ver teste 8 aqui
 *    e o arquivo dedicado `admin-access-buttons-vacancies.integration.e2e.ts`).
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route, type APIRequestContext } from '@playwright/test';

// ── Constantes ───────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8089';
const DB_URL = process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const GESTORA_UID = `e2e-abac-gestora-${RUN_ID}`;
const GESTORA_EMAIL = `${GESTORA_UID}@e2e.test`;
const COMUM_UID = `e2e-abac-comum-${RUN_ID}`;
const COMUM_EMAIL = `${COMUM_UID}@e2e.test`;

const OWN_GROUP_NAME = `E2E ABAC Own ${RUN_ID}`;
const NOVO_GROUP_NAME = `E2E ABAC Panel ${RUN_ID}`;
const FEATURE_COUNTRY = 'BR';
const FEATURE_KEY = 'screen:workers';

const PASSWORD = 'TestAdmin123!';

let ownGroupId = '';
let novoGroupId = '';

// ── SQL helper — psql direto em 5439, SEM docker exec (o container real
// aqui é `abac-postgres`, não `enlite-postgres`; e2e/helpers/db-test-helper.ts
// está fixo em `enlite-postgres`/porta implícita 5432 e não serve para esta
// worktree — por isso este arquivo tem seu próprio helper, sem tocar o
// compartilhado). ─────────────────────────────────────────────────────────────
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

// ── Auth mock ────────────────────────────────────────────────────────────────

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

/**
 * Instala os interceptors mínimos: Identity Toolkit → JWT fake; `/api/**` →
 * troca o Authorization por `mock_*`. NÃO mocka `/api/admin/auth/profile` nem
 * `/v1/me/authz` — o contrato real é o que está sob teste (C2/C3).
 */
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
  // `/v1/me/authz` NÃO cai sob `/api/**` — é contrato versionado à parte, de
  // propósito (AdminAuthzApiService.ts:5, D115 §7: fora de /api/admin para o
  // dia em que o BFF for extraído). Sem este 2º route o request desta rota
  // sai com o JWT fake do identitytoolkit em vez do mock_* — USE_MOCK_AUTH só
  // aceita mock_*, dá 401, e a tela cai em "No se pudo cargar tu contrato de
  // autorización" (medido rodando sem esta linha — não é bug do produto).
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

// ── API raw check (sem browser) — para o "antes/depois 403" ──────────────────

async function vacanciesStatus(request: APIRequestContext, u: MockUser): Promise<number> {
  const res = await request.get(`${BACKEND_URL}/api/admin/vacancies`, {
    headers: { Authorization: `Bearer ${tokenFor(u)}` },
    failOnStatusCode: false,
  });
  return res.status();
}

async function meAuthz(request: APIRequestContext, u: MockUser): Promise<any> {
  const res = await request.get(`${BACKEND_URL}/v1/me/authz`, {
    headers: { Authorization: `Bearer ${tokenFor(u)}` },
    failOnStatusCode: false,
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/** Cache de permissões no processo do backend tem TTL default 30s (sem
 * PERMISSION_CACHE_TTL_MS setado) — poll até o efeito aparecer OU estourar. */
async function pollStatus(
  request: APIRequestContext,
  u: MockUser,
  predicate: (status: number) => boolean,
  timeoutMs = 35_000,
  intervalMs = 2_000,
): Promise<{ status: number; elapsedMs: number }> {
  const start = Date.now();
  let status = await vacanciesStatus(request, u);
  while (!predicate(status) && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    status = await vacanciesStatus(request, u);
  }
  return { status, elapsedMs: Date.now() - start };
}

/**
 * `PermissionService.featuresCache` (país→feature) é um cache ÚNICO por
 * processo, TTL 30s — e a escrita deste teste é UPDATE direto no banco, sem
 * publicar `country_feature.changed` (só a função SECURITY DEFINER publica).
 * Sem poll, a leitura seguinte ecoaria o cache antigo até o TTL vencer.
 */
async function pollFeatureEnabled(
  request: APIRequestContext,
  u: MockUser,
  country: string,
  featureKey: string,
  expected: boolean,
  timeoutMs = 40_000,
  intervalMs = 2_000,
): Promise<{ enabled: boolean | undefined; elapsedMs: number }> {
  const start = Date.now();
  let body = (await meAuthz(request, u)).body;
  let enabled = body?.features?.[country]?.[featureKey]?.enabled;
  while (enabled !== expected && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    body = (await meAuthz(request, u)).body;
    enabled = body?.features?.[country]?.[featureKey]?.enabled;
  }
  return { enabled, elapsedMs: Date.now() - start };
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

test.describe('Painel de acessos ABAC — integração real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    // users — pré-inserida para NÃO cair no auto-provision (getUser real do
    // Firebase Admin, que não existe neste ambiente mock).
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${GESTORA_UID}', '${GESTORA_EMAIL}', 'E2E Gestora', 'admin', true, 'ACTIVE', '${TENANT}')`);
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${COMUM_UID}', '${COMUM_EMAIL}', 'E2E Comum', 'recruiter', true, 'ACTIVE', '${TENANT}')`);

    // Grupo PRÓPRIO da gestora — dá a ela permission_management:read/write (o
    // que abre o painel) e user_management:read (o que popula o combo
    // "adicionar membro" via GET /api/admin/users). NÃO é o grupo sob teste
    // nos passos 1-6 — esse ("novo") nasce pela TELA, no teste 1.
    ownGroupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${OWN_GROUP_NAME}', 'e2e own — nao mexer manual')
          RETURNING id`);
    for (const [resource, action] of [
      ['permission_management', 'read'],
      ['permission_management', 'write'],
      ['user_management', 'read'],
    ]) {
      const inserted = scalar(`INSERT INTO iam.group_permissions (group_id, permission_id)
          SELECT '${ownGroupId}', id FROM iam.permissions WHERE resource='${resource}' AND action='${action}'
          RETURNING permission_id`);
      if (!inserted) throw new Error(`célula ${resource}:${action} não existe em iam.permissions`);
    }
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${ownGroupId}', 'AR', '${GESTORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${GESTORA_UID}', '${ownGroupId}', '${TENANT}')`);
  });

  test.afterAll(() => {
    const groupIds = [ownGroupId, novoGroupId].filter(Boolean);
    const uids = [GESTORA_UID, COMUM_UID];
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    if (groupIds.length) {
      safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id IN ('${groupIds.join("','")}')`);
    }
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    if (groupIds.length) {
      safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN ('${groupIds.join("','")}')`);
      safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN ('${groupIds.join("','")}')`);
      safeSql(`DELETE FROM iam.permission_groups WHERE id IN ('${groupIds.join("','")}')`);
    }
    safeSql(`DELETE FROM iam.country_features WHERE country='${FEATURE_COUNTRY}' AND feature_key='${FEATURE_KEY}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  const GESTORA: MockUser = { uid: GESTORA_UID, email: GESTORA_EMAIL, role: 'admin', country: 'AR' };
  const COMUM: MockUser = { uid: COMUM_UID, email: COMUM_EMAIL, role: 'recruiter', country: 'AR' };

  // ── V1/V2 ────────────────────────────────────────────────────────────────

  test('1. gestora vê seu grupo (backend real) e cria um grupo novo pela tela', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto('/admin/access');
    await expect(page.getByText(OWN_GROUP_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });

    // screenshot da REGIÃO ESTÁVEL do painel (cabeçalho + checkbox + botão
    // "Nuevo grupo"), não da tela inteira. A lista de grupos abaixo cresce
    // quando outros specs @integration rodam em paralelo contra o MESMO
    // Postgres (`enlite_e2e`) — mascarar só a `<table>` não bastava: o
    // baseline foi gravado com a tabela numa altura, e a captura ao vivo
    // com mais grupos (de outro spec) tem a tabela mais alta → a caixa
    // mascarada muda de tamanho entre baseline e captura, e o diff estoura
    // `maxDiffPixelRatio` mesmo sem nenhuma regressão visual real. Restringir
    // a um locator que não inclui a `<table>` elimina a fonte de flakiness.
    await expect(page.getByTestId('access-groups-header')).toHaveScreenshot('admin-access-panel-gestora.png', {
      maxDiffPixelRatio: 0.002,
    });

    await page.getByRole('button', { name: 'Nuevo grupo' }).click();
    await page.locator('#ng-name').fill(NOVO_GROUP_NAME);
    await page.locator('#ng-desc').fill('Grupo criado pelo e2e de integração real');
    await page.getByRole('button', { name: 'Crear' }).click();

    await expect(page).toHaveURL(/\/admin\/access\/groups\/[0-9a-f-]{36}/, { timeout: 15_000 });
    novoGroupId = page.url().match(/groups\/([0-9a-f-]{36})/)![1];

    const dbRow = scalar(`SELECT name FROM iam.permission_groups WHERE id='${novoGroupId}'`);
    expect(dbRow).toBe(NOVO_GROUP_NAME);

    // volta à lista via navegação SPA (Link, não page.reload()) — o grupo tem
    // que aparecer porque o componente refaz o fetch, não porque a página
    // recarregou.
    await page.getByRole('link', { name: /Volver a grupos/i }).click();
    await expect(page.getByText(NOVO_GROUP_NAME, { exact: true })).toBeVisible({ timeout: 15_000 });
  });

  test('2. gestora marca a célula vacancy:read no grupo novo e salva', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${novoGroupId}`);
    await expect(page.getByRole('heading', { name: NOVO_GROUP_NAME })).toBeVisible({ timeout: 15_000 });

    const cellCheckbox = page.locator('input[id="cell-vacancy:read"]');
    await expect(cellCheckbox).toBeAttached({ timeout: 10_000 });
    await cellCheckbox.click({ force: true });
    await page.getByRole('button', { name: 'Guardar células' }).click();
    await expect(page.getByRole('status')).toContainText('Guardado.', { timeout: 10_000 });

    const count = scalar(`SELECT COUNT(*) FROM iam.group_permissions gp
        JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id='${novoGroupId}' AND p.resource='vacancy' AND p.action='read'`);
    expect(count).toBe('1');

    // reflexo na tela — reload do componente (via re-navegação, o load() do
    // GroupDetailPage roda de novo) mostra a checkbox continua marcada.
    await page.goto(`/admin/access/groups/${novoGroupId}`);
    await expect(page.locator('input[id="cell-vacancy:read"]')).toBeChecked({ timeout: 10_000 });
  });

  test('3. gestora concede o país BR ao grupo novo', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${novoGroupId}`);
    await expect(page.getByRole('heading', { name: NOVO_GROUP_NAME })).toBeVisible({ timeout: 15_000 });

    // O motivo do país é campo PRÓPRIO (`#country-reason`), na seção de Países.
    // Era `#cells-reason`, que alimentava os dois — e depois que Países virou a
    // primeira seção, aquele campo ficou duas seções abaixo do botão que ele
    // destravava. E o nome do país agora sai por extenso, do dicionário
    // `countries`: é "Brasil ✓", não "BR ✓".
    const countriesSection = page.locator('section[aria-labelledby="sec-countries"]');
    await page.locator('#country-reason').fill('e2e — concede BR para prova de integração');
    const brRow = countriesSection.locator('div', { hasText: 'Brasil' }).last();
    await brRow.getByRole('button', { name: 'Conceder' }).click();
    await expect(page.getByRole('status')).toContainText('Guardado.', { timeout: 10_000 });
    await expect(page.getByText('Brasil ✓')).toBeVisible({ timeout: 10_000 });

    const row = scalar(`SELECT revoked_at FROM iam.group_country_scopes
        WHERE group_id='${novoGroupId}' AND country='BR' ORDER BY created_at DESC LIMIT 1`);
    expect(row).toBe('');
  });

  test('4. gestora adiciona a comum ao grupo — a request seguinte de comum deixa de ser 403', async ({ page, request }) => {
    const before = await vacanciesStatus(request, COMUM);
    expect(before).toBe(403);

    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${novoGroupId}`);
    await expect(page.getByRole('heading', { name: NOVO_GROUP_NAME })).toBeVisible({ timeout: 15_000 });

    const miembros = page.getByRole('listbox', { name: 'Miembros' });
    const resto = page.getByRole('listbox', { name: 'Resto del equipo' });

    // Marca na coluna de fora e empurra para dentro; nada vale até Guardar.
    await resto.getByRole('option', { name: COMUM_EMAIL }).click();
    await page.getByRole('button', { name: 'Agregar a los miembros' }).click();
    // já atravessou na tela, mas ainda é pendente — o banco não sabe
    await expect(miembros.getByRole('option', { name: COMUM_EMAIL })).toBeVisible();
    await expect(page.getByText('Cambios sin guardar')).toBeVisible();

    await page.getByRole('button', { name: 'Guardar' }).last().click();
    await expect(page.getByRole('status')).toContainText('Guardado.', { timeout: 10_000 });
    // Escopado à COLUNA de membros: o mesmo e-mail existe do outro lado
    // enquanto a pessoa não é membro, e `getByText` sem escopo acharia os dois.
    await expect(miembros.getByRole('option', { name: COMUM_EMAIL })).toBeVisible({ timeout: 10_000 });

    const row = scalar(`SELECT removed_at FROM iam.user_groups
        WHERE user_id='${COMUM_UID}' AND group_id='${novoGroupId}' ORDER BY assigned_at DESC LIMIT 1`);
    expect(row).toBe('');

    const after = await pollStatus(request, COMUM, (s) => s !== 403);
     
    console.log(`[prova] comum deixou de receber 403 em ${after.elapsedMs}ms (status=${after.status})`);
    expect(after.status).not.toBe(403);
  });

  test('5. gestora remove a comum do grupo — ela volta a 403', async ({ page, request }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${novoGroupId}`);
    const miembros = page.getByRole('listbox', { name: 'Miembros' });
    await expect(miembros.getByRole('option', { name: COMUM_EMAIL })).toBeVisible({ timeout: 15_000 });

    await miembros.getByRole('option', { name: COMUM_EMAIL }).click();
    await page.getByRole('button', { name: 'Quitar de los miembros' }).click();
    await page.getByRole('button', { name: 'Guardar' }).last().click();
    await expect(page.getByRole('status')).toContainText('Guardado.', { timeout: 10_000 });
    // Escopado à COLUNA — o mesmo e-mail reaparece em "Resto del equipo" assim
    // que ela deixa de ser membro, então `page.getByText` sem escopo acharia 1
    // elemento mesmo depois da remoção bem-sucedida.
    await expect(miembros.getByRole('option', { name: COMUM_EMAIL })).toHaveCount(0, { timeout: 10_000 });

    const removedAt = scalar(`SELECT removed_at FROM iam.user_groups
        WHERE user_id='${COMUM_UID}' AND group_id='${novoGroupId}' ORDER BY assigned_at DESC LIMIT 1`);
    expect(removedAt).not.toBe('');

    const after = await pollStatus(request, COMUM, (s) => s === 403);
     
    console.log(`[prova] comum voltou a 403 em ${after.elapsedMs}ms`);
    expect(after.status).toBe(403);
  });

  test('6. auditoria filtra pelo uid da comum sem o uid ir na URL', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto('/admin/access/audit');
    await expect(page.getByRole('heading', { name: 'Auditoría de decisiones' })).toBeVisible({ timeout: 15_000 });

    let auditRequestUrl = '';
    page.on('request', (req) => {
      if (req.url().includes('/permission-audit/query')) auditRequestUrl = req.url();
    });

    await page.locator('#au-user').fill(COMUM_UID);
     
    await page.getByRole('button', { name: 'Buscar' }).click();
     
    await expect(page.getByText('DENY').first()).toBeVisible({ timeout: 15_000 });

    expect(auditRequestUrl).toContain('/permission-audit/query');
    expect(auditRequestUrl).not.toContain(COMUM_UID);
     
    console.log(`[prova] URL do request de auditoria (sem uid): ${auditRequestUrl}`);

    const denyCount = scalar(`SELECT COUNT(*) FROM iam.permission_audit_log
        WHERE user_id='${COMUM_UID}' AND decision='DENY' AND resource='vacancy' AND action='read'`);
    expect(Number(denyCount)).toBeGreaterThan(0);
  });

  // ── V3 — telas para quem não tem célula ──────────────────────────────────

  test('7. comum sem grupo: WelcomeNoGroupPage substitui o shell inteiro (D269/A1) — sem menu, sem painel de acessos', async ({ page }) => {
    // Neste ponto a comum já foi removida do grupo novo (teste 5) — está de
    // volta a "sem grupo nenhum".
    await loginAs(page, COMUM);
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/.*login.*/, { timeout: 15_000 });

    // Com o engine ligado (`authz.enforcement === 'on'`), `AdminProtectedRoute`
    // troca TODO o shell `/admin/*` pela `WelcomeNoGroupPage`
    // (`shouldShowWelcomeNoGroup`, D268 A1) — não mais o fallback antigo de
    // cair em `AdminUsersPage` sem tela dedicada (isso valia só com o engine
    // desligado). Sem grupo nenhum: mensagem "sem-grupo", não "inativo".
    await expect(page.getByRole('heading', { name: '¡Bienvenido/a a Enlite!' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Usuarios Administradores' })).toHaveCount(0);

    // Sem menu operacional nessa tela (by design, ver WelcomeNoGroupPage) —
    // o item do painel de acessos não existe no DOM.
    await expect(page.getByRole('link', { name: 'Accesos y permisos' })).toHaveCount(0);
  });

  test('8. comum com vacancy:read (só leitura): vê a lista; botão de escrita NÃO ESTÁ NO DOM (D269 — conserto do achado)', async ({
    page,
    request,
  }) => {
    // Readiciona a comum ao grupo "novo" — que hoje só tem a célula
    // vacancy:read (adicionada no teste 2) e NENHUMA célula de escrita. É o
    // cenário exato do passo 8: leitura de vagas, sem escrita.
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${COMUM_UID}', '${novoGroupId}', '${TENANT}')`);
    const readded = scalar(`SELECT removed_at FROM iam.user_groups
        WHERE user_id='${COMUM_UID}' AND group_id='${novoGroupId}' ORDER BY assigned_at DESC LIMIT 1`);
    expect(readded).toBe('');

    const settled = await pollStatus(request, COMUM, (s) => s !== 403);
    expect(settled.status).not.toBe(403);

    await loginAs(page, COMUM);
    await page.goto('/admin/vacancies');
    // Duas headings batem em /Vacantes/i nesta tela — a do widget de resumo
    // ("Vacantes - Solicitudes") e a da própria página ("Vacantes"); exact
    // desambigua.
    await expect(page.getByRole('heading', { name: 'Vacantes', exact: true })).toBeVisible({ timeout: 15_000 });
    // A lista carrega — prova de que o vacancy:read real chegou até a UI.
    await expect(page.locator('table, [role="table"]').first()).toBeVisible({ timeout: 15_000 });

    // D269 (Parte 3) consertou o achado: "Nueva Vacante" agora é
    // `ActionButton` (resource="vacancy" action="write", mode="hide" default
    // — correção do Gabriel: "esconder, não desabilitar") — a comum, que só
    // tem vacancy:read, NÃO VÊ o botão de escrita: ele não está no DOM.
    // Prova mais completa (várias famílias de botão, screenshot, e o caminho
    // inverso write→aparece) está em
    // admin-access-buttons-vacancies.integration.e2e.ts.
    await expect(page.getByTestId('new-vacancy-btn')).toHaveCount(0);

    const writeCells = scalar(`SELECT COUNT(*) FROM iam.group_permissions gp
        JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id='${novoGroupId}' AND p.resource='vacancy' AND p.action='write'`);
    expect(writeCells).toBe('0'); // confirma que a célula de escrita NÃO existe no grupo da comum
  });

  test('9. desligar uma feature por país muda o contrato (/v1/me/authz); nenhum elemento do DOM reage (achado)', async ({
    request,
  }) => {
    // iam.country_features está vazio neste ambiente (COUNTRY_FEATURES_SYNC_ENABLED
    // não está ligado — o boot que populava os defaults do manifest não rodou).
    // Sem UI para CRIAR uma linha nova (CountryFeaturesPage só lista/liga o que
    // já existe), semeamos por SQL — igual ao manifest real
    // (country-features.manifest.ts: 'screen:workers' AR/BR enabled=true).
    psql(`INSERT INTO iam.country_features (country, feature_key, enabled, source, updated_by)
          VALUES ('${FEATURE_COUNTRY}', '${FEATURE_KEY}', true, 'default', 'e2e:setup')`);

    const beforeBR = await meAuthz(request, { ...COMUM, country: 'BR' });
    expect(beforeBR.status).toBe(200);
    expect(beforeBR.body?.features?.BR?.[FEATURE_KEY]?.enabled).toBe(true);

    // Desliga por UPDATE direto (não pela função `iam.set_country_feature` —
    // SECURITY DEFINER que exige a GUC `app.user_uid` carimbada pelo
    // middleware da request; fora de uma request HTTP real ela recusa com
    // 42501, e não é o que este passo está provando). O passo 3 já provou
    // escrita real pela TELA (grantCountry); aqui o alvo é o EFEITO no
    // contrato, não o caminho de escrita.
    psql(`UPDATE iam.country_features SET enabled=false, source='override', reason='e2e — desliga para prova de país', updated_by='${GESTORA_UID}', updated_at=now()
          WHERE country='${FEATURE_COUNTRY}' AND feature_key='${FEATURE_KEY}'`);

    const dbRow = scalar(`SELECT enabled, source FROM iam.country_features
        WHERE country='${FEATURE_COUNTRY}' AND feature_key='${FEATURE_KEY}'`);
    expect(dbRow).toBe('f|override');

    const after = await pollFeatureEnabled(request, { ...COMUM, country: 'BR' }, 'BR', FEATURE_KEY, false);
     
    console.log(`[prova] /v1/me/authz refletiu enabled=false em ${after.elapsedMs}ms`);
    expect(after.enabled).toBe(false);

    const stillAR = await meAuthz(request, { ...COMUM, country: 'AR' });
    // Não tocamos AR — o manifest (country-features.manifest.ts) declara
    // 'screen:workers' AR=true por default, e nenhuma linha AR foi escrita.
    expect(stillAR.body?.features?.AR?.[FEATURE_KEY]?.enabled).not.toBe(false);

    // ACHADO (grep evidence no relatório): `AuthzContract.features` não tem
    // NENHUM consumidor em src/presentation (nem hook `useFeature`, nem
    // `authz.features` lido em componente algum). O contrato muda; nada no
    // DOM reage. Não fabricamos aqui uma asserção de DOM que dependeria de
    // um componente que não existe.
  });
});
