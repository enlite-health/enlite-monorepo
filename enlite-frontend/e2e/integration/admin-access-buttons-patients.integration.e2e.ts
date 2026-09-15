/**
 * admin-access-buttons-patients.integration.e2e.ts @integration
 *
 * D269 — prova, contra o backend real, que a família PACIENTES usa o
 * mecanismo `ActionButton`/`useActionGate` (D269, Gabriel: "desabilitar não,
 * ESCONDER. Não pode estar visível."): sem a célula de ESCRITA os botões de
 * (D286, atualizado em 08/09: a célula é por CONTAINER — `patient_<container>:write` para cada card,
 * `patient:write` para criar/ativar/arrastar — e a aba só existe com o `:read` do container)
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

/** D286: a ficha é por CONTAINER — ler a aba exige a célula `:read` do container; editar, a `:write`. */
const CONTAINERS = ['patient_identity', 'patient_clinical', 'patient_care_team', 'patient_family', 'patient_chat', 'patient_coverage', 'patient_address', 'patient_services', 'patient_therapeutic_project'] as const;

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
let serviceId = '';

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
    // D286 (spec defasado até 08/09): sem a célula `:read` de cada container a aba nem existe — o cenário
    // "só leitura" é `patient:read` + todos os `:read` de container, e NENHUM `:write`.
    for (const c of CONTAINERS) grantCell(groupId, c, 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${groupId}', 'AR', '${RECRUTADORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${RECRUTADORA_UID}', '${groupId}', '${TENANT}')`);

    // Paciente mínimo, status ADMISSION (ativável — testa a régua do
    // ActivateRecruitmentAction, spec 018 PR-6 ADR-5, também) e no kanban (coluna ADMISSION).
    const clickupTaskId = `E2E-PT-${RUN_ID}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${clickupTaskId}', 'E2E', 'Pacientes ${RUN_ID}', 'ADMISSION', 'TEA leve', 'MODERATE', 'AR', NOW(), NOW())`);
    patientId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`);
    if (!patientId) throw new Error('paciente e2e não foi inserido');

    // Spec 018, PR-6, ADR-5: ativar deixou de ser um botão no cabeçalho e virou um ícone POR
    // SERVIÇO — sem UM serviço contratado o ícone nem tem linha pra renderizar, e este teste
    // deixaria de provar qualquer coisa sobre a célula `patient_services:write`. O serviço nasce
    // sem endereço/horário de propósito: a régua daqui é VISIBILIDADE por permissão, não completude.
    serviceId = scalar(`INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
          VALUES ('${patientId}', 'AT', true, 'AR', 'e2e-pt-setup', 'e2e-pt-setup') RETURNING id`);
    if (!serviceId) throw new Error('serviço contratado e2e não foi inserido');
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

  test('1. só LEITURA (patient:read + :read de cada container, D286): lista e ficha sem NENHUM botão de adicionar/editar/ativar/vincular; kanban sem arrasto', async ({ page }) => {
    await loginAs(page, RECRUTADORA);

    // Lista
    await page.goto('/admin/patients');
    await expect(page.getByRole('heading', { name: 'Lista de Pacientes', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('table, [role="table"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('new-patient-btn')).toHaveCount(0);

    // Ficha — espera o conteúdo (título, sempre visível) ANTES da screenshot.
    await page.goto(`/admin/patients/${patientId}`);
    // Achado fora do escopo do PR-8b: "Ficha del Paciente" não é mais `heading` (PR-3 do
    // cabeçalho — o `h1` virou o NOME do paciente); texto simples continua visível.
    await expect(page.getByText('Ficha del Paciente', { exact: true })).toBeVisible({ timeout: 15_000 });
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

    // Servicio contratado — spec 018, PR-6, ADR-5: "Activar reclutamiento" é o ícone POR
    // SERVIÇO (`ActivateRecruitmentAction`, mesma célula `patient_services:write` do botão
    // antigo) — some do DOM sem a célula, igual a `new-service-btn`.
    await page.getByRole('button', { name: 'Servicio Contratado', exact: true }).click();
    await expect(page.getByTestId('new-service-btn')).toHaveCount(0);
    await expect(page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`)).toHaveCount(0);

    // Kanban — o card existe (leitura), mas o arrasto está bloqueado.
    await page.goto('/admin/patients/kanban');
    await expect(page.getByTestId(`patient-kanban-card-${patientId}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId(`kanban-draggable-${patientId}`)).toHaveAttribute('data-drag-disabled', 'true');
  });

  test('2. a conta ganha patient:create+update E os :create/:update de container (PR-8b): os mesmos elementos passam a EXISTIR e o arrasto libera', async ({ page, request }) => {
    grantCell(groupId, 'patient', 'create');
    grantCell(groupId, 'patient', 'update');
    for (const c of CONTAINERS) {
      grantCell(groupId, c, 'create');
      grantCell(groupId, c, 'update');
    }
    // "Activar reclutamiento" (ActivateRecruitmentAction) exige patient_services:update E
    // vacancy:update JUNTAS (contracts/permissions-split.md) — sem vacancy, o ícone continua
    // escondido mesmo com o serviço liberado.
    grantCell(groupId, 'vacancy', 'update');
    const settled = await pollHasCell(request, RECRUTADORA, 'patient:update');
    console.log(`[prova] patient:update chegou em ${settled.elapsedMs}ms`);
    expect(settled.has).toBe(true);

    await loginAs(page, RECRUTADORA);

    await page.goto('/admin/patients');
    await expect(page.getByRole('heading', { name: 'Lista de Pacientes', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('new-patient-btn')).toBeVisible({ timeout: 10_000 });

    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('edit-general-btn')).toBeVisible();
    await expect(page.getByTestId('edit-clinical-btn')).toBeVisible();

    await page.getByRole('button', { name: 'Red de Apoyo', exact: true }).click();
    await expect(page.getByTestId('edit-support-btn')).toBeVisible();
    await expect(page.getByTestId('chat-ids-edit-btn')).toBeVisible();

    await page.getByRole('button', { name: 'Servicio Contratado', exact: true }).click();
    await expect(page.getByTestId('new-service-btn')).toBeVisible();
    // "Activar reclutamiento" (ícone por serviço) volta a existir assim que a célula chega —
    // desabilitado (falta endereço/horário do serviço de teste), mas VISÍVEL: a régua do D269
    // é sobre esconder/mostrar, não sobre habilitar/desabilitar.
    await expect(page.getByTestId(`contracted-service-activate-recruitment-${serviceId}`)).toBeVisible({ timeout: 15_000 });

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
