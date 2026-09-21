/**
 * worker-birthdate-admin-edit.integration.e2e.ts @integration
 *
 * T6.4 (spec 025, Fase 6, D402 item 4) — prova, contra o backend e o banco REAIS (stack isolado
 * `spec025`, engine ABAC LIGADO), que a edição de `birthDate` pelo admin está atrás da célula
 * `worker_pii:write`:
 *
 *   1. staff COM `worker_pii:write` (+ `worker:update` + `worker_pii:read`) edita o campo via
 *      TECLADO (click + keyboard.type, não `fill()` — `e2e-humano-nao-e-fill`), salva, RECARREGA
 *      a página e lê o valor de volta da TELA (não do estado local nem da resposta da API).
 *   2. staff SEM `worker_pii:write` (mas COM `worker:update` + `worker_pii:read` — o botão
 *      "Editar" existe) abre o mesmo drawer e o campo `we-birthDate` NÃO existe no DOM.
 *
 * Mesmo padrão de auth/seed de `admin-access-buttons-workers.integration.e2e.ts` (JWT fake no
 * Identity Toolkit, `/api/**` trocado por `mock_*`, KMS em modo teste — `enc()` só faz
 * base64, `USE_KMS_ENCRYPTION=false`). Stack próprio (`docker-compose.spec025.yml`, ver o
 * cabeçalho desse arquivo para subir): Postgres 5540, API 8290, front 5195 — nunca 8089/5439/5173,
 * que outra sessão pode estar usando.
 *
 * ⚠️ Nenhum valor de data de nascimento REAL — as duas datas usadas (`1958-06-12` inicial,
 * `1990-05-15` a nova) são sintéticas, escolhidas só por serem plausíveis (idade 18-100).
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';

const DB_URL = process.env.SPEC025_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5540/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const COM_CELULA_UID = `e2e-bd-com-${RUN_ID}`;
const COM_CELULA_EMAIL = `${COM_CELULA_UID}@e2e.test`;
const SEM_CELULA_UID = `e2e-bd-sem-${RUN_ID}`;
const SEM_CELULA_EMAIL = `${SEM_CELULA_UID}@e2e.test`;

const GRUPO_COM = `E2E BD Com Write ${RUN_ID}`;
const GRUPO_SEM = `E2E BD Sem Write ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

const DATA_INICIAL = '1958-06-12'; // sintética
const DATA_NOVA = '1990-05-15'; // sintética

let grupoComId = '';
let grupoSemId = '';
let workerComId = '';
let workerSemId = '';

// ── SQL helper — psql direto em 5540 (stack próprio da spec 025) ────────────────────────────

function psql(sql: string): string {
  try {
    return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '|', '-c', sql], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch (err: any) {
    throw new Error(`DB error: ${err.stderr?.toString() ?? err.message} | sql=${sql}`);
  }
}
const scalar = (sql: string): string => psql(sql).trim().split('\n')[0] ?? '';
function safeSql(sql: string): void {
  try { psql(sql); } catch (err) { console.error(`[cleanup] falhou (seguindo): ${(err as Error).message}`); }
}

/** Célula existe no catálogo? Falha alto (não silencioso) se não existir. */
function grantCell(group: string, resource: string, action: string): void {
  const inserted = scalar(`INSERT INTO iam.group_permissions (group_id, permission_id)
      SELECT '${group}', id FROM iam.permissions WHERE resource='${resource}' AND action='${action}'
      RETURNING permission_id`);
  if (!inserted) throw new Error(`célula ${resource}:${action} não existe em iam.permissions`);
}

/** KMSEncryptionService em modo teste (USE_KMS_ENCRYPTION=false) só decodifica base64. */
function enc(v: string): string {
  return `'${Buffer.from(v, 'utf8').toString('base64')}'`;
}

// ── Auth mock (idêntico a admin-access-buttons-workers.integration.e2e.ts) ──────────────────

interface MockUser { uid: string; email: string; role: string; country: string }

const tokenFor = (u: MockUser): string => 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');

const fakeIdToken = (u: MockUser): string =>
  'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
  Buffer.from(JSON.stringify({
    sub: u.uid, uid: u.uid, email: u.email,
    iss: 'https://securetoken.google.com/enlite-prd', aud: 'enlite-prd',
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url') + '.';

async function installAuthInterceptors(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    const body = url.includes('signInWithPassword') || url.includes('signUp')
      ? { kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email, idToken, refreshToken: 'fake-refresh', expiresIn: '3600', registered: true }
      : { users: [{ localId: u.uid, email: u.email, emailVerified: true }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
    });
  });
  const swapToken = async (route: Route): Promise<void> => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${mockToken}` } });
  };
  await page.route('**/api/**', swapToken);
  await page.route('**/v1/me/authz', swapToken);
}

/** Login HUMANO: clica no campo, digita, clica no botão (`e2e-humano-nao-e-fill`). */
async function loginAs(page: Page, u: MockUser): Promise<void> {
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
}

const COM_CELULA: MockUser = { uid: COM_CELULA_UID, email: COM_CELULA_EMAIL, role: 'admin', country: 'AR' };
const SEM_CELULA: MockUser = { uid: SEM_CELULA_UID, email: SEM_CELULA_EMAIL, role: 'admin', country: 'AR' };

/**
 * Semeia um prestador mínimo, com birth_date_encrypted já preenchida (base64 — modo teste).
 * `phoneDigit` distingue os dois prestadores da mesma corrida (RUN_ID igual, só o PREFIXO
 * `com-`/`sem-` muda — `.slice(-N)` na string toda pegava só o RUN_ID e colidia, achado real
 * medido nesta sessão: `idx_workers_phone_unique` rejeitou o segundo INSERT).
 */
function seedWorker(uidSuffix: string, phoneDigit: string, withBirthDate: boolean): string {
  const authUid = `e2e-bd-worker-${uidSuffix}`;
  const email = `e2e.bd.worker.${uidSuffix}@test.local`;
  const phone = `+5491100015${phoneDigit}${RUN_ID.slice(-3)}`;
  const birthCol = withBirthDate ? `, birth_date_encrypted` : '';
  const birthVal = withBirthDate ? `, ${enc(DATA_INICIAL)}` : '';
  const id = scalar(`INSERT INTO workers (
          auth_uid, email, phone, status, country, occupation,
          first_name_encrypted, last_name_encrypted${birthCol},
          created_at, updated_at
        ) VALUES (
          '${authUid}', '${email}', '${phone}', 'REGISTERED', 'AR', 'AT',
          ${enc('E2E')}, ${enc(`Prestador BD ${uidSuffix}`)}${birthVal},
          NOW(), NOW()
        ) RETURNING id`);
  if (!id) throw new Error(`prestador e2e ${uidSuffix} não foi inserido`);
  return id;
}

test.describe('Edição de birthDate pelo admin, atrás de worker_pii:write (spec 025, T6.4) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${COM_CELULA_UID}', '${COM_CELULA_EMAIL}', 'E2E BD Com Cel', 'admin', true, 'ACTIVE', '${TENANT}')`);
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${SEM_CELULA_UID}', '${SEM_CELULA_EMAIL}', 'E2E BD Sem Cel', 'admin', true, 'ACTIVE', '${TENANT}')`);

    // Caso 1: worker:update + worker_pii:read + worker_pii:write — edita de verdade.
    grupoComId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_COM}', 'e2e spec025 T6.4 — nao mexer manual') RETURNING id`);
    grantCell(grupoComId, 'worker', 'read');
    grantCell(grupoComId, 'worker', 'update');
    grantCell(grupoComId, 'worker_pii', 'read');
    grantCell(grupoComId, 'worker_pii', 'write');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${grupoComId}', 'AR', '${COM_CELULA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${COM_CELULA_UID}', '${grupoComId}', '${TENANT}')`);

    // Caso 2: worker:update + worker_pii:read, SEM worker_pii:write — o botão "Editar" existe
    // (worker:update + worker_pii:read = dossiê visível), o campo de data não.
    grupoSemId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_SEM}', 'e2e spec025 T6.4 — nao mexer manual') RETURNING id`);
    grantCell(grupoSemId, 'worker', 'read');
    grantCell(grupoSemId, 'worker', 'update');
    grantCell(grupoSemId, 'worker_pii', 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
          VALUES ('${grupoSemId}', 'AR', '${SEM_CELULA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${SEM_CELULA_UID}', '${grupoSemId}', '${TENANT}')`);

    workerComId = seedWorker(`com-${RUN_ID}`, '1', /* withBirthDate */ true);
    workerSemId = seedWorker(`sem-${RUN_ID}`, '2', /* withBirthDate */ false);
  });

  test.afterAll(() => {
    const uids = [COM_CELULA_UID, SEM_CELULA_UID];
    for (const wid of [workerComId, workerSemId]) {
      if (wid) {
        safeSql(`DELETE FROM worker_profile_changes_audit WHERE worker_id='${wid}'`);
        safeSql(`DELETE FROM worker_service_areas WHERE worker_id='${wid}'`);
        safeSql(`DELETE FROM workers WHERE id='${wid}'`);
      }
    }
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    for (const gid of [grupoComId, grupoSemId]) {
      if (gid) {
        safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id='${gid}'`);
        safeSql(`DELETE FROM iam.user_groups WHERE group_id='${gid}'`);
        safeSql(`DELETE FROM iam.group_permissions WHERE group_id='${gid}'`);
        safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id='${gid}'`);
        safeSql(`DELETE FROM iam.permission_groups WHERE id='${gid}'`);
      }
    }
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  test('1. COM worker_pii:write: edita a data via teclado, salva, recarrega e vê o valor lido da TELA', async ({ page }) => {
    await loginAs(page, COM_CELULA);
    await page.goto(`/admin/workers/${workerComId}`);
    await expect(page.getByTestId('worker-personal-card')).toBeVisible({ timeout: 15_000 });

    // O valor ATUAL (semeado) aparece na ficha, só-leitura, antes de editar.
    await expect(page.getByTestId('worker-personal-card')).toContainText('12/06/1958');

    await page.getByTestId('worker-edit-button').click();
    const campo = page.getByTestId('we-birthDate');
    await expect(campo).toBeVisible({ timeout: 10_000 });
    await expect(campo).toHaveValue(DATA_INICIAL);

    // Edição: clica no campo (foco real) e ENTÃO preenche a data nova.
    // ⚠️ Desvio MEDIDO do padrão `e2e-humano-nao-e-fill` (click + keyboard.type), registrado
    // aqui e no relatório da task: `<input type="date">` é um controle SEGMENTADO (dia/mês/ano
    // como três campos internos), e a ORDEM visual dos segmentos depende do locale do navegador
    // — tentei `click()` + `Control+A` + `Backspace` + `keyboard.type()` dos 3 segmentos em
    // ordem ano→mês→dia (com o contexto forçado para `en-CA`, que EXIBE yyyy-mm-dd) e o
    // resultado real, medido nesta sessão, foi `.value` = "0515-12-09" — os dígitos caíram no
    // segmento errado. Isso não é specífico deste componente: os DOIS outros `<input
    // type="date">` já existentes no repo (`pc-birthDate`, `pge-serviceStartDate`, em
    // `admission-b-campos.integration.e2e.ts`) já usam `.fill('yyyy-MM-dd')` pelo MESMO motivo —
    // é o jeito documentado do Playwright de preencher esses 3 tipos especiais de input
    // (date/time/color) via o próprio controle nativo do navegador (dispara `input`/`change`
    // reais, não `evaluate()`/injeção de `.value`), não uma tecla de atalho pra pular validação.
    // O que seguiu sendo testado de verdade — clicar no botão certo, o backend gravar, a TELA
    // (depois de um `reload()`) mostrar o valor novo — é a prova que este teste pede.
    await campo.click();
    await campo.fill(DATA_NOVA);
    await expect(campo).toHaveValue(DATA_NOVA);

    await page.getByTestId('we-save').click();
    await expect(page.getByTestId('worker-edit-modal')).not.toBeVisible({ timeout: 10_000 });

    // Recarrega a página inteira — a prova não é o estado do form em memória, é o que a
    // ficha volta a mostrar depois de uma navegação nova, lida do backend real.
    await page.reload();
    await expect(page.getByTestId('worker-personal-card')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('worker-personal-card')).toContainText('15/05/1990');
    await expect(page.getByTestId('worker-personal-card')).not.toContainText('12/06/1958');
  });

  test('2. SEM worker_pii:write (mas com worker:update + worker_pii:read): o campo NÃO existe no DOM', async ({ page }) => {
    await loginAs(page, SEM_CELULA);
    await page.goto(`/admin/workers/${workerSemId}`);
    await expect(page.getByTestId('worker-personal-card')).toBeVisible({ timeout: 15_000 });

    // O botão "Editar" EXISTE (worker:update + worker_pii:read) — a régua é do CAMPO, não do drawer.
    await expect(page.getByTestId('worker-edit-button')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('worker-edit-button').click();
    await expect(page.getByTestId('worker-edit-modal')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('we-firstName')).toBeVisible();

    await expect(page.getByTestId('we-birthDate')).toHaveCount(0);
    await expect(page.getByText('Dossier', { exact: true })).toHaveCount(0);
  });
});
