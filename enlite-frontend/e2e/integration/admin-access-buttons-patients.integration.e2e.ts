/**
 * admin-access-buttons-patients.integration.e2e.ts @integration
 *
 * D269 — prova, contra o backend real, que a família PACIENTES usa o
 * mecanismo `ActionButton`/`useActionGate` (D269, Gabriel: "desabilitar não,
 * ESCONDER. Não pode estar visível."): sem `patient:write` os botões de
 * adicionar/editar (criar paciente, editar seções da ficha, ativar, vincular
 * chat, e o arrasto do kanban) SOMEM do DOM (`toHaveCount(0)`), nunca ficam
 * visíveis-e-desabilitados — e voltam assim que a célula chega.
 *
 * Mesmo padrão de auth/seed de `admin-access-buttons-vacancies.integration.e2e.ts`
 * (JWT fake no Identity Toolkit, `/api/**` trocado por `mock_*`, contas
 * pré-inseridas em `users` pra não cair no auto-provision do Firebase Admin).
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route, type APIRequestContext } from '@playwright/test';

// ── Constantes ───────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8089';
const DB_URL = process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const RECRUTADORA_UID = `e2e-pt-recrutadora-${RUN_ID}`;
const RECRUTADORA_EMAIL = `${RECRUTADORA_UID}@e2e.test`;
const SEM_GRUPO_UID = `e2e-pt-semgrupo-${RUN_ID}`;
const SEM_GRUPO_EMAIL = `${SEM_GRUPO_UID}@e2e.test`;

const GROUP_NAME = `E2E PT Pacientes Read ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

let groupId = '';
let patientId = '';

// ── SQL helper — psql direto em 5439 (mesmo padrão de admin-access-buttons-vacancies). ──

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

// ── Auth mock (idêntico a admin-access-buttons-vacancies.integration.e2e.ts) ────

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

/** Cache de permissões do backend tem TTL — poll até a célula nova aparecer no contrato. */
async function pollHasCell(
  request: APIRequestContext,
  u: MockUser,
  cell: string,
  timeoutMs = 35_000,
  intervalMs = 2_000,
): Promise<{ has: boolean; elapsedMs: number }> {
  const start = Date.now();
  let body = (await meAuthz(request, u)).body;
  let has = (body?.permissions ?? []).includes(cell);
  while (!has && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, intervalMs));
    body = (await meAuthz(request, u)).body;
    has = (body?.permissions ?? []).includes(cell);
  }
  return { has, elapsedMs: Date.now() - start };
}

// ── Setup / teardown ───────────────────────────────────────────────────────────

test.describe('Botões da família pacientes — esconder, não desabilitar (D269) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${RECRUTADORA_UID}', '${RECRUTADORA_EMAIL}', 'E2E PT Recrutadora', 'recruiter', true, 'ACTIVE', '${TENANT}')`);
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${SEM_GRUPO_UID}', '${SEM_GRUPO_EMAIL}', 'E2E PT Sem Grupo', 'recruiter', true, 'ACTIVE', '${TENANT}')`);

    // Grupo com SÓ patient:read — nada de escrita. É o cenário exato do
    // passo 1: recrutadora que só LÊ a ficha.
    groupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GROUP_NAME}', 'e2e pacientes — nao mexer manual')
          RETURNING id`);
    grantCell(groupId, 'patient', 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${groupId}', 'AR', '${RECRUTADORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${RECRUTADORA_UID}', '${groupId}', '${TENANT}')`);

    // Paciente mínimo, status ADMISSION (ativável — testa a régua do
    // ActivatePatientButton também) e no kanban (coluna ADMISSION).
    const clickupTaskId = `E2E-PT-${RUN_ID}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${clickupTaskId}', 'E2E', 'Pacientes ${RUN_ID}', 'ADMISSION', 'TEA leve', 'MODERATE', 'AR', NOW(), NOW())`);
    patientId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`);
    if (!patientId) throw new Error('paciente e2e não foi inserido');
  });

  test.afterAll(() => {
    const uids = [RECRUTADORA_UID, SEM_GRUPO_UID];
    safeSql(`DELETE FROM patients WHERE id='${patientId}'`);
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    if (groupId) {
      safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id='${groupId}'`);
    }
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    if (groupId) {
      safeSql(`DELETE FROM iam.group_permissions WHERE group_id='${groupId}'`);
      safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id='${groupId}'`);
      safeSql(`DELETE FROM iam.permission_groups WHERE id='${groupId}'`);
    }
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  const RECRUTADORA: MockUser = { uid: RECRUTADORA_UID, email: RECRUTADORA_EMAIL, role: 'recruiter', country: 'AR' };
  const SEM_GRUPO: MockUser = { uid: SEM_GRUPO_UID, email: SEM_GRUPO_EMAIL, role: 'recruiter', country: 'AR' };

  test('1. só patient:read: lista e ficha sem NENHUM botão de adicionar/editar/ativar/vincular; kanban sem arrasto', async ({ page }) => {
    await loginAs(page, RECRUTADORA);

    // Lista
    await page.goto('/admin/patients');
    await expect(page.getByRole('heading', { name: 'Lista de Pacientes', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('table, [role="table"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('new-patient-btn')).toHaveCount(0);

    // Ficha — espera o conteúdo (título, sempre visível) ANTES da screenshot.
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByRole('heading', { name: 'Ficha del Paciente', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('activate-patient-btn')).toHaveCount(0);
    await expect(page.getByTestId('edit-general-btn')).toHaveCount(0);
    await expect(page.getByTestId('edit-clinical-btn')).toHaveCount(0);

    await expect(page).toHaveScreenshot('admin-patient-detail-buttons-hidden.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.002,
    });

    // Rede de apoio — Familiares + Chat IDs
    await page.getByRole('button', { name: 'Red de Apoyo', exact: true }).click();
    await expect(page.getByTestId('edit-support-btn')).toHaveCount(0);
    await expect(page.getByTestId('chat-ids-edit-btn')).toHaveCount(0);

    // Servicio contratado
    await page.getByRole('button', { name: 'Servicio Contratado', exact: true }).click();
    await expect(page.getByTestId('edit-service-btn')).toHaveCount(0);

    // Kanban — o card existe (leitura), mas o arrasto está bloqueado.
    await page.goto('/admin/patients/kanban');
    await expect(page.getByTestId(`patient-kanban-card-${patientId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`kanban-draggable-${patientId}`)).toHaveAttribute('data-drag-disabled', 'true');
  });

  test('2. a conta ganha patient:write: os mesmos elementos passam a EXISTIR e o arrasto libera', async ({ page, request }) => {
    grantCell(groupId, 'patient', 'write');
    const settled = await pollHasCell(request, RECRUTADORA, 'patient:write');
    console.log(`[prova] patient:write chegou em ${settled.elapsedMs}ms`);
    expect(settled.has).toBe(true);

    await loginAs(page, RECRUTADORA);

    await page.goto('/admin/patients');
    await expect(page.getByRole('heading', { name: 'Lista de Pacientes', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('new-patient-btn')).toBeVisible({ timeout: 10_000 });

    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('activate-patient-btn')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('edit-general-btn')).toBeVisible();
    await expect(page.getByTestId('edit-clinical-btn')).toBeVisible();

    await page.getByRole('button', { name: 'Red de Apoyo', exact: true }).click();
    await expect(page.getByTestId('edit-support-btn')).toBeVisible();
    await expect(page.getByTestId('chat-ids-edit-btn')).toBeVisible();

    await page.getByRole('button', { name: 'Servicio Contratado', exact: true }).click();
    await expect(page.getByTestId('edit-service-btn')).toBeVisible();

    await page.goto('/admin/patients/kanban');
    await expect(page.getByTestId(`patient-kanban-card-${patientId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`kanban-draggable-${patientId}`)).not.toHaveAttribute('data-drag-disabled', 'true');
  });

  test('3. sem grupo nenhum: tela de boas-vindas — nenhuma regressão', async ({ page }) => {
    await loginAs(page, SEM_GRUPO);
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/.*login.*/, { timeout: 15_000 });
    await expect(page.getByText('¡Bienvenido/a a Enlite!')).toBeVisible({ timeout: 15_000 });
  });
});
