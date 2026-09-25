/**
 * admin-access-buttons-vacancies.integration.e2e.ts @integration
 *
 * D269 — prova, contra o backend real, que a família VAGAS usa o mecanismo
 * novo do `ActionButton` (Parte 1/3 do plano): sem a célula de escrita o
 * botão fica VISÍVEL e DESABILITADO (`toBeDisabled()` + `data-gate="denied"`),
 * nunca escondido — e volta a ficar habilitado assim que a célula chega.
 *
 * Mesmo padrão de auth/seed de `admin-access-panel.integration.e2e.ts`
 * (JWT fake no Identity Toolkit, `/api/**` trocado por `mock_*`, contas
 * pré-inseridas em `users` pra não cair no auto-provision do Firebase Admin).
 *
 * Este arquivo TAMBÉM fecha o achado documentado no teste 8 de
 * `admin-access-panel.integration.e2e.ts` ("o botão 'Nueva Vacante' é um
 * <Button> comum, sem gate nenhum" — D269 Parte 3 é exatamente o conserto
 * disso); aquele teste foi atualizado para refletir o novo comportamento.
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route, type APIRequestContext } from '@playwright/test';

// ── Constantes ───────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8089';
const DB_URL = process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const RECRUTADORA_UID = `e2e-vagas-recrutadora-${RUN_ID}`;
const RECRUTADORA_EMAIL = `${RECRUTADORA_UID}@e2e.test`;
const SEM_GRUPO_UID = `e2e-vagas-semgrupo-${RUN_ID}`;
const SEM_GRUPO_EMAIL = `${SEM_GRUPO_UID}@e2e.test`;

const GROUP_NAME = `E2E Vagas Read ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

let groupId = '';
let patientId = '';
let addressId = '';
let vacancyId = '';

// ── SQL helper — psql direto em 5439 (mesmo padrão de admin-access-panel). ──

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

// ── Auth mock (idêntico a admin-access-panel.integration.e2e.ts) ────────────

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

test.describe('Botões da família vagas — desabilitar em vez de sumir (D269) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${RECRUTADORA_UID}', '${RECRUTADORA_EMAIL}', 'E2E Recrutadora', 'recruiter', true, 'ACTIVE', '${TENANT}')`);
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${SEM_GRUPO_UID}', '${SEM_GRUPO_EMAIL}', 'E2E Sem Grupo', 'recruiter', true, 'ACTIVE', '${TENANT}')`);

    // Grupo com SÓ vacancy:read — nada de screen/write. É o cenário exato do
    // passo 1: recrutadora que só LÊ vagas.
    groupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GROUP_NAME}', 'e2e vagas — nao mexer manual')
          RETURNING id`);
    grantCell(groupId, 'vacancy', 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${groupId}', 'AR', '${RECRUTADORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${RECRUTADORA_UID}', '${groupId}', '${TENANT}')`);

    // Paciente + endereço + vaga mínimos, pra abrir o detalhe (mesmo shape de
    // e2e/helpers/db-test-helper.ts — `insertTestPatient`/`insertBaseVacancy`
    // — mas via psql direto em 5439, que é o Postgres desta worktree, não o
    // `enlite-postgres` do helper compartilhado).
    const clickupTaskId = `E2E-VAGAS-${RUN_ID}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${clickupTaskId}', 'E2E', 'Vagas ${RUN_ID}', 'ACTIVE', 'TEA leve', 'SEVERE', 'AR', NOW(), NOW())`);
    patientId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`);
    if (!patientId) throw new Error('paciente e2e não foi inserido');

    psql(`INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
          VALUES ('${patientId}', 'Av. Corrientes 1234, CABA, AR', 'Av. Corrientes 1234, CABA', -34.6037, -58.3816, 1, 'manual', NOW(), NOW())`);
    addressId = scalar(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`);
    if (!addressId) throw new Error('endereço e2e não foi inserido');

    psql(`INSERT INTO job_postings (
            vacancy_number, case_number, title, description,
            patient_id, patient_address_id,
            required_professions, required_sex, providers_needed,
            status, is_draft, country, created_at, updated_at
          ) VALUES (
            nextval('job_postings_vacancy_number_seq'), 900001, 'CASO E2E vagas', '',
            '${patientId}', '${addressId}',
            ARRAY['AT']::varchar[], NULL, 1,
            'SEARCHING', false, 'AR', NOW(), NOW()
          )`);
    vacancyId = scalar(`SELECT id FROM job_postings WHERE patient_id = '${patientId}' ORDER BY created_at DESC LIMIT 1`);
    if (!vacancyId) throw new Error('vaga e2e não foi inserida');
  });

  test.afterAll(() => {
    const uids = [RECRUTADORA_UID, SEM_GRUPO_UID];
    safeSql(`DELETE FROM job_postings WHERE id='${vacancyId}'`);
    safeSql(`DELETE FROM patient_addresses WHERE patient_id='${patientId}'`);
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

  test('1. só vacancy:read: "Nueva", "Sincronizar Talentum", editor de status, "Guardar horário" e switch Talentum NÃO EXISTEM no DOM', async ({ page }) => {
    await loginAs(page, RECRUTADORA);
    await page.goto('/admin/vacancies');
    await expect(page.getByRole('heading', { name: 'Vacantes', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('table, [role="table"]').first()).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('new-vacancy-btn')).toHaveCount(0);
    await expect(page.getByTestId('sync-talentum-btn')).toHaveCount(0);

    // Espera o texto da página (já feito acima) ANTES da captura — e o
    // contrato precisa estar `ready`/estável (Parte 2: sem isso a tela
    // pisca em branco a cada troca de área e a captura sai vazia).
    await expect(page).toHaveScreenshot('admin-vacancies-buttons-hidden.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.002,
      mask: [page.locator('table')],
    });

    await page.goto(`/admin/vacancies/${vacancyId}`);
    await expect(page.getByTestId('vacancy-edit-schedule-trigger')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toHaveCount(0);

    await page.getByTestId('vacancy-edit-schedule-trigger').click();
    await expect(page.getByTestId('vacancy-schedule-save')).toHaveCount(0);
    // fecha o modal de horário antes de seguir (não deixar aberto atrapalhando a próxima navegação)
    await page.getByTestId('vacancy-schedule-modal-backdrop').click({ force: true });

    await page.getByRole('button', { name: 'Talentum', exact: true }).click();
    await expect(page.getByRole('switch')).toHaveCount(0);

    // Gate rodada 6: as telas de criar vaga e configurar Talentum são
    // alcançáveis DIRETO por URL (não só pelo botão que leva até elas) — sem
    // `vacancy:write`/`talentum:write` a PORTA fecha (`<Navigate replace>`),
    // não só o botão de salvar/publicar. Prova pela URL FINAL após o redirect.
    await page.goto('/admin/vacancies/new');
    await expect(page).toHaveURL(/\/admin\/vacancies$/, { timeout: 15_000 });

    await page.goto(`/admin/vacancies/${vacancyId}/talentum`);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`), { timeout: 15_000 });
  });

  test('2. a conta ganha vacancy:create+update E talentum:create+update (PR-8b): os mesmos elementos passam a EXISTIR', async ({ page, request }) => {
    grantCell(groupId, 'vacancy', 'create');
    grantCell(groupId, 'vacancy', 'update');
    grantCell(groupId, 'talentum', 'create');
    grantCell(groupId, 'talentum', 'update');
    const settledVacancyC = await pollHasCell(request, RECRUTADORA, 'vacancy:create');
    const settledVacancyU = await pollHasCell(request, RECRUTADORA, 'vacancy:update');
    const settledTalentumC = await pollHasCell(request, RECRUTADORA, 'talentum:create');
    const settledTalentumU = await pollHasCell(request, RECRUTADORA, 'talentum:update');

    console.log(`[prova] vacancy:create em ${settledVacancyC.elapsedMs}ms, vacancy:update em ${settledVacancyU.elapsedMs}ms, talentum:create em ${settledTalentumC.elapsedMs}ms, talentum:update em ${settledTalentumU.elapsedMs}ms`);
    expect(settledVacancyC.has).toBe(true);
    expect(settledVacancyU.has).toBe(true);
    expect(settledTalentumC.has).toBe(true);
    expect(settledTalentumU.has).toBe(true);

    await loginAs(page, RECRUTADORA);
    await page.goto('/admin/vacancies');
    await expect(page.getByRole('heading', { name: 'Vacantes', exact: true })).toBeVisible({ timeout: 15_000 });
    // "Nueva" (new-vacancy-btn) SAIU temporariamente (D425 item 4, 24/09/2026,
    // docs/decisoes.md, Fase 3 de completar-vacante-em-rascunho) — some para TODO mundo,
    // independente de `vacancy:create`/`vacancy:update`. Deixou de ser prova de D269 aqui;
    // count(0) incondicional já está coberto no teste 1 acima e em admin-access-panel.
    await expect(page.getByTestId('sync-talentum-btn')).toBeVisible();

    await page.goto(`/admin/vacancies/${vacancyId}`);
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('vacancy-edit-schedule-trigger').click();
    await expect(page.getByTestId('vacancy-schedule-save')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('vacancy-schedule-modal-backdrop').click({ force: true });

    await page.getByRole('button', { name: 'Talentum', exact: true }).click();
    await expect(page.getByRole('switch')).toBeVisible({ timeout: 15_000 });
  });

  test('3. sem grupo nenhum: tela de boas-vindas — nenhuma regressão', async ({ page }) => {
    await loginAs(page, SEM_GRUPO);
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/.*login.*/, { timeout: 15_000 });
    await expect(page.getByText('¡Bienvenido/a a Enlite!')).toBeVisible({ timeout: 15_000 });
  });
});
