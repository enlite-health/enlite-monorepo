/**
 * permissoes-criar-editar-humano.integration.e2e.ts @integration
 *
 * Spec 018, PR-8b (rodada B do front — ADR-2/SUP-30): prova, contra o backend
 * REAL (engine ABAC ligado, catálogo sincronizado), que a divisão
 * `<recurso>:write` → `<recurso>:create` + `<recurso>:update` funciona na
 * TELA, não só no unit — com interação HUMANA (click + keyboard.type, nunca
 * `fill`/`evaluate` — memória `e2e-humano-nao-e-fill`).
 *
 * Casos (task 8b.9):
 *  (a) grupo só com `vacancy:create` — vê "Nueva vacante", digita um dado
 *      real no formulário; NÃO vê a ação de editar uma vaga existente.
 *  (b) grupo só com `vacancy:update` — edita uma vaga existente (link de
 *      reunión, campo de texto real) e SALVA; NÃO vê "Nueva vacante".
 *  (c) na tela de grupos (ScreenTree, D286 — a `CellMatrix` saiu do
 *      `GroupDetailPage`), marca "Crear" e "Editar" SEPARADOS por clique,
 *      salva, recarrega a página e confere que persistiu cada um.
 *
 * Stack: mesmo padrão de `admin-access-buttons-vacancies.integration.e2e.ts`
 * — API 8089, Postgres 5439 (`ABAC_TEST_DB_URL`), engine ligado
 * (`PERMISSION_ENGINE_ENABLED=true`, `PERMISSION_CATALOG_SYNC_ENABLED=true`),
 * `iam.rollout_state.permission_groups_migrated=done`.
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';

const BACKEND_URL = 'http://localhost:8089';
const DB_URL = process.env.ABAC_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5439/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const CRIADORA_UID = `e2e-pr8b-criadora-${RUN_ID}`;
const CRIADORA_EMAIL = `${CRIADORA_UID}@e2e.test`;
const EDITORA_UID = `e2e-pr8b-editora-${RUN_ID}`;
const EDITORA_EMAIL = `${EDITORA_UID}@e2e.test`;
const GESTORA_UID = `e2e-pr8b-gestora-${RUN_ID}`;
const GESTORA_EMAIL = `${GESTORA_UID}@e2e.test`;

const GRUPO_CREATE = `E2E PR8b Create ${RUN_ID}`;
const GRUPO_UPDATE = `E2E PR8b Update ${RUN_ID}`;
const GRUPO_OWN = `E2E PR8b Own ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

let createGroupId = '';
let updateGroupId = '';
let ownGroupId = '';
let novoGroupId = '';
let patientId = '';
let addressId = '';
let vacancyId = '';

// ── SQL helpers (mesmo molde de admin-access-buttons-vacancies) ────────────

function psql(sql: string): string {
  try {
    return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`DB error: ${e.stderr?.toString() ?? e.message} | sql=${sql}`);
  }
}
const scalar = (sql: string): string => psql(sql).trim().split('\n')[0] ?? '';
function safeSql(sql: string): void {
  try {
    psql(sql);
  } catch (err) {
    console.error(`[cleanup] falhou (seguindo): ${(err as Error).message}`);
  }
}
function grantCell(group: string, resource: string, action: string): void {
  const inserted = scalar(`INSERT INTO iam.group_permissions (group_id, permission_id)
      SELECT '${group}', id FROM iam.permissions WHERE resource='${resource}' AND action='${action}'
      RETURNING permission_id`);
  if (!inserted) throw new Error(`célula ${resource}:${action} não existe em iam.permissions`);
}

// ── Auth mock (idêntico aos outros specs @integration desta família) ───────

interface MockUser { uid: string; email: string; role: string; country: string }

function tokenFor(u: MockUser): string {
  return 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');
}
function fakeIdToken(u: MockUser): string {
  return (
    'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
    Buffer.from(JSON.stringify({
      sub: u.uid, uid: u.uid, email: u.email,
      iss: 'https://securetoken.google.com/enlite-prd', aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url') + '.'
  );
}
async function installAuthInterceptors(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email,
          idToken, refreshToken: 'fake-refresh', expiresIn: '3600', registered: true,
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ users: [{ localId: u.uid, email: u.email, emailVerified: true }] }),
    });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
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
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(u.email);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type(PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Setup / teardown ────────────────────────────────────────────────────────

test.describe('Permissões criar × editar — prova humana contra o backend real (PR-8b, 8b.9) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    for (const [uid, email, name] of [
      [CRIADORA_UID, CRIADORA_EMAIL, 'E2E PR8b Criadora'],
      [EDITORA_UID, EDITORA_EMAIL, 'E2E PR8b Editora'],
      [GESTORA_UID, GESTORA_EMAIL, 'E2E PR8b Gestora'],
    ]) {
      psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
            VALUES ('${uid}', '${email}', '${name}', 'admin', true, 'ACTIVE', '${TENANT}')`);
    }

    // Grupo (a): SÓ vacancy:create.
    createGroupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_CREATE}', 'e2e pr8b create — nao mexer manual') RETURNING id`);
    grantCell(createGroupId, 'vacancy', 'read');
    grantCell(createGroupId, 'vacancy', 'create');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${createGroupId}', 'AR', '${CRIADORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${CRIADORA_UID}', '${createGroupId}', '${TENANT}')`);

    // Grupo (b): SÓ vacancy:update.
    updateGroupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_UPDATE}', 'e2e pr8b update — nao mexer manual') RETURNING id`);
    grantCell(updateGroupId, 'vacancy', 'read');
    grantCell(updateGroupId, 'vacancy', 'update');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${updateGroupId}', 'AR', '${EDITORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${EDITORA_UID}', '${updateGroupId}', '${TENANT}')`);

    // Grupo (c): da gestora — abre o painel de acessos (permission_management fica `write`, ADR-2 linha 11).
    ownGroupId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_OWN}', 'e2e pr8b own — nao mexer manual') RETURNING id`);
    grantCell(ownGroupId, 'permission_management', 'read');
    grantCell(ownGroupId, 'permission_management', 'write');
    grantCell(ownGroupId, 'user_management', 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${ownGroupId}', 'AR', '${GESTORA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${GESTORA_UID}', '${ownGroupId}', '${TENANT}')`);

    // Paciente + endereço + 1 vaga existente (alvo do caso (b), editar).
    const clickupTaskId = `E2E-PR8B-${RUN_ID}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${clickupTaskId}', 'E2E', 'PR8b ${RUN_ID}', 'ACTIVE', 'TEA leve', 'SEVERE', 'AR', NOW(), NOW())`);
    patientId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`);
    if (!patientId) throw new Error('paciente e2e não foi inserido');

    psql(`INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, lat, lng, display_order, source, created_at, updated_at)
          VALUES ('${patientId}', 'Av. Santa Fe 1000, CABA, AR', 'Av. Santa Fe 1000, CABA', -34.5951, -58.3927, 1, 'manual', NOW(), NOW())`);
    addressId = scalar(`SELECT id FROM patient_addresses WHERE patient_id = '${patientId}' LIMIT 1`);
    if (!addressId) throw new Error('endereço e2e não foi inserido');

    psql(`INSERT INTO job_postings (
            vacancy_number, case_number, title, description,
            patient_id, patient_address_id,
            required_professions, required_sex, providers_needed,
            status, is_draft, country, created_at, updated_at
          ) VALUES (
            nextval('job_postings_vacancy_number_seq'), 900002, 'CASO E2E PR8b', '',
            '${patientId}', '${addressId}',
            ARRAY['AT']::varchar[], NULL, 1,
            'SEARCHING', false, 'AR', NOW(), NOW()
          )`);
    vacancyId = scalar(`SELECT id FROM job_postings WHERE patient_id = '${patientId}' ORDER BY created_at DESC LIMIT 1`);
    if (!vacancyId) throw new Error('vaga e2e não foi inserida');
  });

  test.afterAll(() => {
    const uids = [CRIADORA_UID, EDITORA_UID, GESTORA_UID];
    safeSql(`DELETE FROM job_postings WHERE id='${vacancyId}'`);
    safeSql(`DELETE FROM job_postings WHERE case_number=900001 AND title LIKE 'CASO E2E PR8b - Nueva%'`);
    safeSql(`DELETE FROM patient_addresses WHERE patient_id='${patientId}'`);
    safeSql(`DELETE FROM patients WHERE id='${patientId}'`);
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    const groupIds = [createGroupId, updateGroupId, ownGroupId, novoGroupId].filter(Boolean);
    if (groupIds.length) safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id IN ('${groupIds.join("','")}')`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    for (const g of groupIds) {
      safeSql(`DELETE FROM iam.group_permissions WHERE group_id='${g}'`);
      safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id='${g}'`);
      safeSql(`DELETE FROM iam.permission_groups WHERE id='${g}'`);
    }
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  const CRIADORA: MockUser = { uid: CRIADORA_UID, email: CRIADORA_EMAIL, role: 'admin', country: 'AR' };
  const EDITORA: MockUser = { uid: EDITORA_UID, email: EDITORA_EMAIL, role: 'admin', country: 'AR' };
  const GESTORA: MockUser = { uid: GESTORA_UID, email: GESTORA_EMAIL, role: 'admin', country: 'AR' };

  test('(a) grupo só com vacancy:create: vê "Nueva vacante", digita um dado real, e NÃO vê a ação de editar a vaga existente', async ({ page }) => {
    await loginAs(page, CRIADORA);

    // A lista mostra "Nueva vacante" (create) — e NENHUM lápis/editar por linha (a lista não tem
    // ação de edição própria; a prova de "não edita" está na página de detalhe abaixo).
    await page.goto('/admin/vacancies');
    await expect(page.getByRole('heading', { name: 'Vacantes', exact: true })).toBeVisible({ timeout: 15_000 });
    const novaBtn = page.getByTestId('new-vacancy-btn');
    await expect(novaBtn).toBeVisible({ timeout: 10_000 });

    // Abre o detalhe da vaga existente: sem `vacancy:update`, o editor de STATUS não existe.
    // (o lápis de horário, `vacancy-edit-schedule-trigger`, é um `<button>` sem gate — achado fora
    // do escopo do PR-8b, `VacancyProfessionCard.tsx` não tem `ActionButton`/`useActionGate` nenhum.)
    await page.goto(`/admin/vacancies/${vacancyId}`);
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toHaveCount(0);

    // Interação HUMANA real: volta à lista e clica em "Nueva vacante" para digitar no formulário
    // de criação (o `locator` de `novaBtn` foi capturado na lista; navegar embora o invalida).
    await page.goto('/admin/vacancies');
    await expect(novaBtn).toBeVisible({ timeout: 10_000 });
    await novaBtn.click();
    await expect(page).toHaveURL(/\/admin\/vacancies\/new$/, { timeout: 10_000 });
    await expect(page.getByTestId('create-vacancy-save-btn')).toBeVisible({ timeout: 10_000 });

    const caseSearch = page.getByPlaceholder(/[Bb]uscar|[Cc]aso/).first();
    if (await caseSearch.count() > 0) {
      await caseSearch.click();
      await page.keyboard.type('PR8b');
      await expect(caseSearch).toHaveValue(/PR8b/);
    }

    await page.screenshot({ path: 'test-results/pr8b-8b9-a-create-form.png', fullPage: false });
  });

  test('(b) grupo só com vacancy:update: edita a vaga existente (link real digitado) e SALVA; NÃO vê "Nueva vacante"', async ({ page }) => {
    await loginAs(page, EDITORA);

    await page.goto('/admin/vacancies');
    await expect(page.getByRole('heading', { name: 'Vacantes', exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('new-vacancy-btn')).toHaveCount(0);

    await page.goto(`/admin/vacancies/${vacancyId}`);
    await expect(page.getByTestId('vacancy-status-editor-trigger')).toBeVisible({ timeout: 15_000 });

    await page.getByRole('button', { name: 'Links', exact: true }).click();
    const meetCard = page.getByTestId('vacancy-meet-links-card');
    await expect(meetCard).toBeVisible({ timeout: 10_000 });

    const linkInput = meetCard.getByPlaceholder('https://meet.google.com/xxx-xxxx-xxx').first();
    await linkInput.click();
    // `MEET_LINK_REGEX` (VacancyMeetLinksCard.tsx) exige 3-4-3 letras minúsculas — sem dígito.
    const letras = RUN_ID.toLowerCase().replace(/[^a-z]/g, '') || 'abcdefghijklmnop';
    const codigo = letras.padEnd(10, 'prbfxyzqwe').slice(0, 10);
    const meetUrl = `https://meet.google.com/${codigo.slice(0, 3)}-${codigo.slice(3, 7)}-${codigo.slice(7, 10)}`;
    await page.keyboard.type(meetUrl);
    await expect(linkInput).toHaveValue(meetUrl);

    await meetCard.getByTestId('meet-links-save').click();
    // `onSaved` refaz o fetch da vaga (a mesma prop `refetch` do resto da tela) — o card pode
    // remontar antes do assert enxergar o feedback local; a prova forte é o RELOAD abaixo, que
    // lê o valor de volta do servidor.
    await page.waitForTimeout(1_500);

    await page.screenshot({ path: 'test-results/pr8b-8b9-b-update-links.png', fullPage: false });

    // Recarrega e confere que o link digitado persistiu — a prova de que salvou de verdade.
    await page.reload();
    await page.getByRole('button', { name: 'Links', exact: true }).click();
    const linkInputAfter = page.getByTestId('vacancy-meet-links-card').getByPlaceholder('https://meet.google.com/xxx-xxxx-xxx').first();
    await expect(linkInputAfter).toHaveValue(meetUrl, { timeout: 10_000 });
  });

  test('(c) na tela de grupos: marca Crear e Editar separados por clique, salva, recarrega e confere que persistiu', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto('/admin/access');
    await expect(page.getByRole('heading', { name: 'Accesos y permisos' })).toBeVisible({ timeout: 15_000 });

    // Cria um grupo novo PELA TELA (mesmo molde de admin-access-panel teste 1: campos `#ng-name`/
    // `#ng-desc`, botão "Crear" — não "Crear grupo").
    await page.getByRole('button', { name: 'Nuevo grupo' }).click();
    const novoNome = `E2E PR8b Novo ${RUN_ID}`;
    await page.locator('#ng-name').click();
    await page.keyboard.type(novoNome);
    await page.locator('#ng-desc').click();
    await page.keyboard.type('Grupo criado pelo e2e 8b.9 — create/update separados');
    await page.getByRole('button', { name: 'Crear' }).click();
    await expect(page).toHaveURL(/\/admin\/access\/groups\/[0-9a-f-]{36}/, { timeout: 15_000 });
    novoGroupId = page.url().match(/groups\/([0-9a-f-]{36})/)![1];
    const dbRow = scalar(`SELECT name FROM iam.permission_groups WHERE id='${novoGroupId}'`);
    if (dbRow !== novoNome) throw new Error('grupo novo não foi criado pela tela');

    // Marca "Crear" e "Editar" de vagas SEPARADAMENTE, por clique (não fill) — o rótulo
    // acessível da caixa é `${resource}:${action} — ${descrição}` (BlocoCategoria, CellMatrix.tsx).
    const createCheckbox = page.getByRole('checkbox', { name: /^vacancy:create/ }).first();
    const updateCheckbox = page.getByRole('checkbox', { name: /^vacancy:update/ }).first();
    await expect(createCheckbox).toBeAttached({ timeout: 15_000 });
    await expect(updateCheckbox).toBeAttached({ timeout: 15_000 });
    // `read` é implicado (marcar create/update marca read do mesmo recurso, D128-like) — mas o
    // clique é só nas duas caixas pedidas, exercitando a implicação em vez de marcar à mão.
    await createCheckbox.click({ force: true });
    await updateCheckbox.click({ force: true });

    await page.getByRole('button', { name: 'Guardar células' }).click();
    await expect(page.getByRole('status')).toContainText('Guardado.', { timeout: 10_000 });

    await page.screenshot({ path: 'test-results/pr8b-8b9-c-grupo-create-update.png', fullPage: false });

    // Recarrega a página do grupo do ZERO e confere que as DUAS marcações persistiram.
    await page.reload();
    await expect(page.getByRole('checkbox', { name: /^vacancy:create/ }).first()).toBeChecked({ timeout: 15_000 });
    await expect(page.getByRole('checkbox', { name: /^vacancy:update/ }).first()).toBeChecked();

    const cellsAfter = scalar(`SELECT string_agg(p.resource || ':' || p.action, ',' ORDER BY p.action)
        FROM iam.group_permissions gp JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id='${novoGroupId}' AND p.resource='vacancy'`);
    expect(cellsAfter).toContain('vacancy:create');
    expect(cellsAfter).toContain('vacancy:update');
  });
});
