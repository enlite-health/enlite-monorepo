/**
 * abac-stack-helper.ts — o que os specs @integration do ABAC (engine LIGADO) repetem
 * arquivo por arquivo: psql contra o banco real, o login por JWT fake + token `mock_*`,
 * a leitura de `/v1/me/authz` e a concessão de célula por SQL.
 *
 * Diferença para as cópias nos specs `admin-access-*`: a API e o banco vêm de VARIÁVEL
 * (`ABAC_API_URL`, `ABAC_TEST_DB_URL`), com o default da família (8089/5439) — assim o mesmo
 * spec roda contra o stack isolado de qualquer sessão (`docker compose -p <sessão>`), sem
 * editar o arquivo. Ver `admin-access-cells-visual.integration.e2e.ts` para subir o stack.
 *
 * `loginAs` é HUMANO (click + keyboard.type), não `fill()` — memória `e2e-humano-nao-e-fill`.
 */
import { execFileSync } from 'child_process';
import { expect, type APIRequestContext, type Page, type Route } from '@playwright/test';

export const ABAC_API_URL = process.env.ABAC_API_URL ?? 'http://localhost:8089';
export const ABAC_DB_URL =
  process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
export const ABAC_TENANT = '00000000-0000-0000-0000-000000000001';
const PASSWORD = 'TestAdmin123!';

export interface MockUser {
  uid: string;
  email: string;
  role: string;
  country: string;
}

export function psql(sql: string): string {
  try {
    return execFileSync('psql', [ABAC_DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message} | sql=${sql}`);
  }
}

export function scalar(sql: string): string {
  return psql(sql).trim().split('\n')[0] ?? '';
}

/** Limpeza: falha de um DELETE não pode esconder a dos seguintes. */
export function safeSql(sql: string): void {
  try {
    psql(sql);
  } catch (err) {
    console.error(`[cleanup] falhou (seguindo): ${(err as Error).message}`);
  }
}

/** Concede `resource:action` ao grupo. Célula inexistente no catálogo é ERRO, não silêncio. */
export function grantCell(groupId: string, resource: string, action: string): void {
  const inserted = scalar(`INSERT INTO iam.group_permissions (group_id, permission_id)
      SELECT '${groupId}', id FROM iam.permissions WHERE resource='${resource}' AND action='${action}'
      RETURNING permission_id`);
  if (!inserted) throw new Error(`célula ${resource}:${action} não existe em iam.permissions`);
}

export function revokeCell(groupId: string, resource: string, action: string): void {
  psql(`DELETE FROM iam.group_permissions
        WHERE group_id = '${groupId}'
          AND permission_id = (SELECT id FROM iam.permissions WHERE resource='${resource}' AND action='${action}')`);
}

/** Cria staff + grupo com escopo de país e o filia. Devolve o que o `afterAll` precisa apagar. */
export function seedStaffInGroup(opts: { uid: string; email: string; groupName: string; country: string }): {
  groupId: string;
} {
  psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
        VALUES ('${opts.uid}', '${opts.email}', 'E2E ${opts.uid}', 'recruiter', true, 'ACTIVE', '${ABAC_TENANT}')`);
  const groupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
        VALUES ('${ABAC_TENANT}', '${opts.groupName}', 'e2e — nao mexer manual')
        RETURNING id`);
  psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
        VALUES ('${groupId}', '${opts.country}', '${opts.uid}', 'e2e setup')`);
  psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${opts.uid}', '${groupId}', '${ABAC_TENANT}')`);
  return { groupId };
}

export function cleanupStaffAndGroup(uid: string, groupId: string): void {
  safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id = '${uid}'`);
  safeSql(`DELETE FROM resource_access_log WHERE operator_uid = '${uid}'`);
  if (groupId) {
    safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id = '${groupId}'`);
    safeSql(`DELETE FROM iam.user_groups WHERE group_id = '${groupId}'`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id = '${groupId}'`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id = '${groupId}'`);
    safeSql(`DELETE FROM iam.permission_groups WHERE id = '${groupId}'`);
  }
  safeSql(`DELETE FROM users WHERE firebase_uid = '${uid}'`);
}

// ── Auth: JWT fake no Identity Toolkit, token `mock_*` na API (USE_MOCK_AUTH=true) ──────────

export function tokenFor(u: MockUser): string {
  return 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');
}

function fakeIdToken(u: MockUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: u.uid, uid: u.uid, email: u.email, iss: 'https://securetoken.google.com/enlite-prd', aud: 'enlite-prd', iat: now, exp: now + 3600 };
  return 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.';
}

export async function installAuthInterceptors(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email, idToken, refreshToken: 'fake-refresh', expiresIn: '3600', registered: true }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [{ localId: u.uid, email: u.email, emailVerified: true }] }) });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
    });
  });
  // Só o Authorization é trocado — a REQUEST segue para a API real, e a RESPOSTA é a real.
  const swapToken = async (route: Route): Promise<void> => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${mockToken}` } });
  };
  await page.route('**/api/**', swapToken);
  await page.route('**/v1/me/authz', swapToken);
}

/** Login como uma pessoa faz: clica no campo, digita, clica no botão. */
export async function loginAs(page: Page, u: MockUser): Promise<void> {
  await installAuthInterceptors(page, u);
  await page.goto('/admin/login');
  const email = page.locator('input[type="email"]');
  await email.click();
  await expect(email).toBeFocused();
  await page.keyboard.type(u.email);
  const password = page.locator('input[type="password"]');
  await password.click();
  await expect(password).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
  // ⚠️ A página de login dispara um SEGUNDO redirect para `/admin` ~500 ms depois (medido em
  // `admin-access.e2e.ts`). Clicar num item do menu antes disso leva a uma foto da tela ERRADA:
  // o teste navega para Prestadores e o redirect atrasado puxa de volta para Usuarios. Comportamento
  // pré-existente do login, fora do que estes specs medem — espera-se ele assentar.
  await page.waitForTimeout(1_200);
  await expect(page).toHaveURL(/\/admin\/?$/);
}

export async function meAuthz(request: APIRequestContext, u: MockUser): Promise<{ status: number; body: any }> {
  const res = await request.get(`${ABAC_API_URL}/v1/me/authz`, { headers: { Authorization: `Bearer ${tokenFor(u)}` }, failOnStatusCode: false });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

/**
 * O contrato tem cache (~30 s) no backend: espera até a condição valer, e diz quanto demorou.
 * Medido 24-30 s por mudança; 60 s deixa margem para um intervalo a mais e a latência da API.
 */
export async function pollAuthz(
  request: APIRequestContext,
  u: MockUser,
  predicate: (body: any) => boolean,
  timeoutMs = 60_000,
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
