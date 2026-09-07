/**
 * admin-access-buttons-workers.integration.e2e.ts @integration
 *
 * D269 — prova, contra o backend real, que a família PRESTADORES + UPLOADS
 * usa o mecanismo `ActionButton`/`useActionGate` (D269, Gabriel: "desabilitar
 * não, ESCONDER. Não pode estar visível."): sem `worker:write` /
 * `worker_document:write` / `worker_document:delete` os botões de
 * editar-perfil, toggle de conta de teste, adicionar/remover tag e
 * enviar/excluir documento SOMEM do DOM (`toHaveCount(0)`), nunca ficam
 * visíveis-e-desabilitados — e voltam assim que a célula chega.
 *
 * `worker:delete` e `upload:write` NÃO aparecem aqui: nenhuma rota do
 * backend declara essas duas células (grep em
 * `worker-functions/src/**\/routes/*.ts`), então não existe botão pra gatear
 * — ver ACHADOS no relatório da task.
 *
 * Mesmo padrão de auth/seed de `admin-access-buttons-vacancies.integration.e2e.ts`
 * (JWT fake no Identity Toolkit, `/api/**` trocado por `mock_*`, contas
 * pré-inseridas em `users` pra não cair no auto-provision do Firebase Admin).
 *
 * ⚠️ O valor de `users.role` é irrelevante aqui: o botão "Editar" da ficha e o
 * toggle de conta de teste dependem SÓ de `worker:write`
 * (`WorkerDetailContent.canEdit`, `WorkerTestAccountToggle`). A coluna segue no
 * banco porque é NOT NULL, não porque decide algo.
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route, type APIRequestContext } from '@playwright/test';

// ── Constantes ───────────────────────────────────────────────────────────────

const BACKEND_URL = 'http://localhost:8089';
const DB_URL = process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const GESTORA_UID = `e2e-wk-gestora-${RUN_ID}`;
const GESTORA_EMAIL = `${GESTORA_UID}@e2e.test`;
const SEM_GRUPO_UID = `e2e-wk-semgrupo-${RUN_ID}`;
const SEM_GRUPO_EMAIL = `${SEM_GRUPO_UID}@e2e.test`;

const GROUP_NAME = `E2E WK Prestadores Read ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

let groupId = '';
let workerId = '';
let tagId = '';

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

/** KMSEncryptionService em test mode só decodifica base64 — ver insertTestWorker em db-test-helper.ts. */
function enc(v: string): string {
  return `'${Buffer.from(v, 'utf8').toString('base64')}'`;
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

test.describe('Botões da família prestadores — esconder, não desabilitar (D269) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    // `users.role` é preenchimento de coluna, não regra de acesso — ver nota do cabeçalho.
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${GESTORA_UID}', '${GESTORA_EMAIL}', 'E2E WK Gestora', 'admin', true, 'ACTIVE', '${TENANT}')`);
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${SEM_GRUPO_UID}', '${SEM_GRUPO_EMAIL}', 'E2E WK Sem Grupo', 'admin', true, 'ACTIVE', '${TENANT}')`);

    // Grupo com SÓ leitura — worker:read (lista + catálogo de tags),
    // worker_pii:read (GET /workers/:id — a ficha), worker_document:read
    // (view-url). Nada de write/delete. É o cenário do passo 1: gestora que
    // só LÊ o prestador.
    groupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GROUP_NAME}', 'e2e prestadores — nao mexer manual')
          RETURNING id`);
    grantCell(groupId, 'worker', 'read');
    grantCell(groupId, 'worker_pii', 'read');
    grantCell(groupId, 'worker_document', 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${groupId}', 'AR', '${GESTORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${GESTORA_UID}', '${groupId}', '${TENANT}')`);

    // Prestador mínimo — PII cifrada em base64 (KMS test mode só decodifica,
    // ver db-test-helper.ts:insertTestWorker), com UM documento já enviado
    // (resume_cv) pra o ícone de excluir ter o que gatear.
    const uniq = RUN_ID;
    const authUid = `e2e-wk-worker-${uniq}`;
    const email = `e2e.wk.worker.${uniq}@test.local`;
    const phone = `+549110000${uniq.slice(-4)}`;
    workerId = scalar(`INSERT INTO workers (
            auth_uid, email, phone, status, country, occupation,
            first_name_encrypted, last_name_encrypted,
            created_at, updated_at
          ) VALUES (
            '${authUid}', '${email}', '${phone}', 'REGISTERED', 'AR', 'AT',
            ${enc('E2E')}, ${enc(`Prestador ${uniq}`)},
            NOW(), NOW()
          ) RETURNING id`);
    if (!workerId) throw new Error('prestador e2e não foi inserido');

    psql(`INSERT INTO worker_documents (worker_id, resume_cv_url, documents_status, created_at, updated_at)
          VALUES ('${workerId}', 'workers/${workerId}/resume_cv.pdf', 'submitted', NOW(), NOW())`);

    // Uma tag no catálogo, já atribuída ao prestador — pro "X" de remover
    // ter o que gatear (o dropdown de adicionar não depende de dado).
    tagId = scalar(`INSERT INTO worker_tag_catalog (name, color, created_by)
          VALUES ('E2E WK Urgente ${RUN_ID}', '#ff0000', '${GESTORA_UID}')
          RETURNING id`);
    psql(`INSERT INTO worker_tags (worker_id, tag_id, assigned_by)
          VALUES ('${workerId}', '${tagId}', '${GESTORA_UID}')`);
  });

  test.afterAll(() => {
    const uids = [GESTORA_UID, SEM_GRUPO_UID];
    safeSql(`DELETE FROM worker_tags WHERE worker_id='${workerId}'`);
    if (tagId) safeSql(`DELETE FROM worker_tag_catalog WHERE id='${tagId}'`);
    safeSql(`DELETE FROM worker_documents WHERE worker_id='${workerId}'`);
    safeSql(`DELETE FROM worker_service_areas WHERE worker_id='${workerId}'`);
    safeSql(`DELETE FROM workers WHERE id='${workerId}'`);
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

  const GESTORA: MockUser = { uid: GESTORA_UID, email: GESTORA_EMAIL, role: 'admin', country: 'AR' };
  const SEM_GRUPO: MockUser = { uid: SEM_GRUPO_UID, email: SEM_GRUPO_EMAIL, role: 'admin', country: 'AR' };

  test('1. só read: lista carrega; na ficha, editar/toggle-teste/tags/documentos NÃO existem no DOM', async ({ page }) => {
    await loginAs(page, GESTORA);

    // Lista — sem botão de escrita pra essa família (export/sync-talentum
    // são de OUTRAS células, não gateadas aqui).
    await page.goto('/admin/workers');
    await expect(page.getByRole('heading', { name: 'Lista de Prestadores', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('table, [role="table"]').first()).toBeVisible({ timeout: 15_000 });

    // Ficha
    await page.goto(`/admin/workers/${workerId}`);
    await expect(page.getByTestId('worker-documents-card')).toBeVisible({ timeout: 15_000 });

    // worker:write — botão "Editar" da ficha (perfil) e toggle de conta de teste.
    await expect(page.getByTestId('worker-edit-button')).toHaveCount(0);
    await expect(page.getByTestId('worker-test-account-checkbox')).toHaveCount(0);

    // worker:write — tags: nem o "X" de remover (tag já atribuída) nem o
    // dropdown "Añadir" existem.
    await expect(page.getByLabel('Quitar etiqueta')).toHaveCount(0);
    await expect(page.getByText('+ Etiqueta', { exact: true })).toHaveCount(0);

    // Espera o conteúdo estável (já feito acima) ANTES da captura.
    await expect(page).toHaveScreenshot('admin-worker-detail-buttons-hidden.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.002,
    });

    // worker_document:write — slot vazio (identity_document) não tem input de arquivo.
    const emptySlot = page.getByTestId('doc-slot-identity_document');
    await expect(emptySlot.locator('input[type="file"]')).toHaveCount(0);

    // worker_document:delete — slot já enviado (resume_cv) mostra "Ver" mas não "Eliminar".
    const uploadedSlot = page.getByTestId('doc-slot-resume_cv');
    await expect(uploadedSlot.getByLabel('Remover documento')).toHaveCount(0);
    await expect(uploadedSlot.getByLabel('Visualizar documento')).toBeVisible();

    // worker_document:write — "Agregar" (documentos adicionais) some.
    await expect(page.getByTestId('additional-doc-add')).toHaveCount(0);
  });

  test('2. a conta ganha worker:write + worker_document:write/:delete: os mesmos elementos passam a EXISTIR', async ({ page, request }) => {
    grantCell(groupId, 'worker', 'write');
    grantCell(groupId, 'worker_document', 'write');
    grantCell(groupId, 'worker_document', 'delete');

    const settledWorker = await pollHasCell(request, GESTORA, 'worker:write');
    const settledDocWrite = await pollHasCell(request, GESTORA, 'worker_document:write');
    const settledDocDelete = await pollHasCell(request, GESTORA, 'worker_document:delete');
    console.log(
      `[prova] worker:write em ${settledWorker.elapsedMs}ms, worker_document:write em ${settledDocWrite.elapsedMs}ms, worker_document:delete em ${settledDocDelete.elapsedMs}ms`,
    );
    expect(settledWorker.has).toBe(true);
    expect(settledDocWrite.has).toBe(true);
    expect(settledDocDelete.has).toBe(true);

    await loginAs(page, GESTORA);
    await page.goto(`/admin/workers/${workerId}`);
    await expect(page.getByTestId('worker-documents-card')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByTestId('worker-edit-button')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('worker-test-account-checkbox')).toBeVisible();

    await expect(page.getByLabel('Quitar etiqueta')).toBeVisible();
    await expect(page.getByText('+ Etiqueta', { exact: true })).toBeVisible();

    const emptySlot = page.getByTestId('doc-slot-identity_document');
    await expect(emptySlot.locator('input[type="file"]')).toHaveCount(1);

    const uploadedSlot = page.getByTestId('doc-slot-resume_cv');
    await expect(uploadedSlot.getByLabel('Remover documento')).toBeVisible();

    await expect(page.getByTestId('additional-doc-add')).toBeVisible();

    // Abre o editor: o botão "Guardar" do drawer também é gateado (mesma célula).
    await page.getByTestId('worker-edit-button').click();
    await expect(page.getByTestId('we-save')).toBeVisible({ timeout: 10_000 });
  });

  test('3. sem grupo nenhum: tela de boas-vindas — nenhuma regressão', async ({ page }) => {
    await loginAs(page, SEM_GRUPO);
    await page.goto('/admin');
    await expect(page).not.toHaveURL(/.*login.*/, { timeout: 15_000 });
    await expect(page.getByText('¡Bienvenido/a a Enlite!')).toBeVisible({ timeout: 15_000 });
  });
});
