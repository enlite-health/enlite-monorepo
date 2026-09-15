/**
 * admin-access-buttons-users.integration.e2e.ts @integration
 *
 * D269 — prova, contra o backend real, que a família USUÁRIOS ADMIN
 * (`AdminUsersPage`) usa o mecanismo do `ActionButton`/`useActionGate`:
 * sem a célula de escrita o botão SOME do DOM (`mode='hide'`, default —
 * D269: "esconder, não desabilitar" — ao contrário da família vagas, que
 * usa `disable`). Mapa rota → célula (`adminUsersRoutes.ts`):
 *   POST   /users            → user_management:write   (Crear usuario)
 *   POST   /users/:id/reset-password → user_management:write (Reset)
 *   DELETE /users/:id        → user_management:delete  (Eliminar)
 * (`PATCH /users/:id/role` não existe mais: papel deixou de ser atributo do
 * admin — quem pode o quê é a célula.)
 *
 * Também prova o segundo achado da D268 nomeado na task: os itens da seção
 * Administración (`adminNavigation.tsx`) derivam de CÉLULA DE LEITURA — aqui
 * só o caso de Duplicados (`dedup:read`), que é o mais barato de montar sem
 * depender de vaga/paciente.
 *
 * Mesmo padrão de auth/seed de `admin-access-panel.integration.e2e.ts` e
 * `admin-access-buttons-vacancies.integration.e2e.ts` (JWT fake no Identity
 * Toolkit, `/api/**` trocado por `mock_*`, contas pré-inseridas em `users`
 * pra não cair no auto-provision do Firebase Admin). Contas/grupos com
 * prefixo `E2E US` — próprios deste arquivo, sem tocar nos de outros specs.
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route, type APIRequestContext } from '@playwright/test';

// ── Constantes ───────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8089';
const DB_URL = process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const ADMIN_UID = `e2e-us-admin-${RUN_ID}`;
const ADMIN_EMAIL = `${ADMIN_UID}@e2e.test`;
const RECRUITER_UID = `e2e-us-recruiter-${RUN_ID}`;
const RECRUITER_EMAIL = `${RECRUITER_UID}@e2e.test`;

const ADMIN_GROUP_NAME = `E2E US Admin ${RUN_ID}`;
const RECRUITER_GROUP_NAME = `E2E US Recruiter ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

let adminGroupId = '';
let recruiterGroupId = '';

// ── SQL helper — psql direto em 5439 (mesmo padrão dos outros specs @integration). ──

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

/** Célula existe no catálogo? Falha alto (não silencioso) se não existir. */
function grantCell(group: string, resource: string, action: string): void {
  const inserted = scalar(`INSERT INTO iam.group_permissions (group_id, permission_id)
      SELECT '${group}', id FROM iam.permissions WHERE resource='${resource}' AND action='${action}'
      RETURNING permission_id`);
  if (!inserted) throw new Error(`célula ${resource}:${action} não existe em iam.permissions`);
}

// ── Auth mock (idêntico aos outros specs @integration) ──────────────────────

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

/** Cache de permissões do backend tem TTL — poll até TODAS as células novas aparecerem no contrato. */
async function pollHasCells(
  request: APIRequestContext,
  u: MockUser,
  cells: string[],
  timeoutMs = 35_000,
  intervalMs = 2_000,
): Promise<{ has: boolean; elapsedMs: number }> {
  const start = Date.now();
  const hasAll = (perms: string[]) => cells.every((c) => perms.includes(c));
  let body = (await meAuthz(request, u)).body;
  let has = hasAll(body?.permissions ?? []);
  while (!has && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    body = (await meAuthz(request, u)).body;
    has = hasAll(body?.permissions ?? []);
  }
  return { has, elapsedMs: Date.now() - start };
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

test.describe('Botões da família USUÁRIOS ADMIN + item de menu Duplicados (D269) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    // A coluna `users.role` ainda existe no banco, mas não decide nada na UI:
    // Crear/Reset/Eliminar dependem só da célula. Os valores abaixo são
    // preenchimento de coluna NOT NULL, não regra de acesso.
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${ADMIN_UID}', '${ADMIN_EMAIL}', 'E2E US Admin', 'admin', true, 'ACTIVE', '${TENANT}')`);
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${RECRUITER_UID}', '${RECRUITER_EMAIL}', 'E2E US Recruiter', 'recruiter', true, 'ACTIVE', '${TENANT}')`);

    // Grupo do admin: começa só com user_management:read (leitura nunca é
    // gateada — é o piso pra sequer abrir /admin) + worker:read (teste 5:
    // a guarda de rota de TagCatalogPage é `worker:read`, e worker:read sem
    // worker:write prova que a LEITURA da lista não é o que falta.
    adminGroupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${ADMIN_GROUP_NAME}', 'e2e usuarios admin — nao mexer manual')
          RETURNING id`);
    grantCell(adminGroupId, 'user_management', 'read');
    grantCell(adminGroupId, 'worker', 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${adminGroupId}', 'AR', '${ADMIN_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${ADMIN_UID}', '${adminGroupId}', '${TENANT}')`);

    // Grupo do recruiter: worker:read + patient:read + recruitment:read,
    // de propósito SEM dedup:read — é o cenário exato do teste de menu.
    recruiterGroupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${RECRUITER_GROUP_NAME}', 'e2e usuarios admin — nao mexer manual')
          RETURNING id`);
    grantCell(recruiterGroupId, 'worker', 'read');
    grantCell(recruiterGroupId, 'patient', 'read');
    grantCell(recruiterGroupId, 'recruitment', 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${recruiterGroupId}', 'AR', '${ADMIN_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${RECRUITER_UID}', '${recruiterGroupId}', '${TENANT}')`);
  });

  test.afterAll(() => {
    const uids = [ADMIN_UID, RECRUITER_UID];
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    if (adminGroupId) safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id='${adminGroupId}'`);
    if (recruiterGroupId) safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id='${recruiterGroupId}'`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    for (const g of [adminGroupId, recruiterGroupId]) {
      if (!g) continue;
      safeSql(`DELETE FROM iam.group_permissions WHERE group_id='${g}'`);
      safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id='${g}'`);
      safeSql(`DELETE FROM iam.permission_groups WHERE id='${g}'`);
    }
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  const ADMIN: MockUser = { uid: ADMIN_UID, email: ADMIN_EMAIL, role: 'admin', country: 'AR' };
  const RECRUITER: MockUser = { uid: RECRUITER_UID, email: RECRUITER_EMAIL, role: 'recruiter', country: 'AR' };

  test('1. só user_management:read: "Crear", "Reset" e "Eliminar" NÃO EXISTEM no DOM (e nenhum <select> — a coluna de papel saiu)', async ({ page }) => {
    await loginAs(page, ADMIN);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Usuarios Administradores' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('table, [role="table"]').first()).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('button', { name: 'Nuevo Usuario' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reset', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Eliminar', exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox')).toHaveCount(0);

    // screenshot da REGIÃO ESTÁVEL (cabeçalho + botão) — não da tabela, que
    // cresce conforme outros specs @integration inserem contas de teste em
    // paralelo (mesma lição do achado consertado em
    // admin-access-panel.integration.e2e.ts teste 1).
    // Página inteira, com a TABELA mascarada (cresce conforme outros specs inserem contas):
    // o que a captura prova é a ausência do botão "Crear usuario" ao lado do título, com o menu ao lado.
    await expect(page).toHaveScreenshot('admin-users-buttons-hidden.png', {
      fullPage: false,
      mask: [page.locator('table')],
      maxDiffPixelRatio: 0.002,
    });
  });

  test('2. a conta ganha user_management:create/update/delete (PR-8b): os mesmos elementos passam a EXISTIR', async ({
    page,
    request,
  }) => {
    grantCell(adminGroupId, 'user_management', 'create');
    grantCell(adminGroupId, 'user_management', 'update');
    grantCell(adminGroupId, 'user_management', 'delete');
    const settled = await pollHasCells(request, ADMIN, [
      'user_management:create',
      'user_management:update',
      'user_management:delete',
    ]);
    console.log(`[prova] as 2 células chegaram em ${settled.elapsedMs}ms`);
    expect(settled.has).toBe(true);

    await loginAs(page, ADMIN);
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Usuarios Administradores' })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('button', { name: 'Nuevo Usuario' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Reset', exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Eliminar', exact: true }).first()).toBeVisible();
    // Nenhum <select>: a escrita voltou, mas a coluna de papel não existe mais.
    await expect(page.getByRole('combobox')).toHaveCount(0);
  });

  test('3. conta sem dedup:read não vê "Duplicados" no menu — os outros 3 itens (worker/patient/recruitment:read) continuam', async ({
    page,
  }) => {
    await loginAs(page, RECRUITER);
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/.*login.*/, { timeout: 15_000 });

    await expect(page.getByRole('link', { name: 'Duplicados' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Etiquetas' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Roles de grupos' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Postulaciones bloqueadas' })).toBeVisible();
  });

  test('4. a conta ganha dedup:read: "Duplicados" passa a existir no menu', async ({ page, request }) => {
    grantCell(recruiterGroupId, 'dedup', 'read');
    const settled = await pollHasCells(request, RECRUITER, ['dedup:read']);
    console.log(`[prova] dedup:read chegou em ${settled.elapsedMs}ms`);
    expect(settled.has).toBe(true);

    await loginAs(page, RECRUITER);
    await page.goto('/admin');
    await expect(page.getByRole('link', { name: 'Duplicados' })).toBeVisible({ timeout: 15_000 });
  });

  test('5. ADMIN com worker:read (sem worker:write) em /admin/tags: lista aparece, "Nueva Etiqueta" e editar/excluir NÃO', async ({
    page,
  }) => {
    // adminGroupId nunca ganha worker:write nesta suíte — a célula
    // permanece ausente do início ao fim deste describe.
    await loginAs(page, ADMIN);
    await page.goto('/admin/tags');
    await expect(page.getByRole('heading', { name: 'Etiquetas' })).toBeVisible({ timeout: 15_000 });

    await expect(page.getByRole('button', { name: 'Nueva Etiqueta' })).toHaveCount(0);
    await expect(page.getByLabel('Editar Etiqueta')).toHaveCount(0);
    await expect(page.getByLabel('Eliminar Etiqueta')).toHaveCount(0);
  });
});
