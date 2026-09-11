/**
 * permissoes-busca-grupos-humano.integration.e2e.ts @integration
 *
 * PR-8a — `018-grupos-fixos-busca` (US-19, US-21; FR-701, FR-702, FR-720).
 * Prova contra o backend/DB REAIS (stack isolado `-p e2e-018-pr8a`, porta
 * 8092/5438 — NÃO o `enlite-postgres`/8080 de outra worktree):
 *
 *  1. feliz: no grupo Recrutador (agora customizável pela mig 432), buscar
 *     "familia" filtra a grade para só as células de família; marcar "Ver" e
 *     salvar grava no banco.
 *  2. alt: busca sem nenhum resultado mostra a mensagem — não uma grade vazia.
 *  3. alt: Recrutador aceita edição (lápis, arquivar); Acesso Master continua
 *     travado (marcador "Sistema", sem lápis, sem arquivar) — a mesma regra
 *     de sempre, só que agora só 2 dos 5 grupos do seed a carregam.
 *
 * Digitação HUMANA (click + keyboard.type — nunca fill/evaluate, memória
 * `e2e-humano-nao-e-fill`); backend com `PERMISSION_CATALOG_SYNC_ENABLED=true`
 * (o override do stack) para o catálogo trazer `patient_family:*` — sem isso
 * a busca por "familia" não teria o que mostrar (invariante "sync antes de
 * enforçar" não se aplica aqui, mas o catálogo tem de existir para aparecer).
 */

import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';

const BACKEND_URL = 'http://localhost:8092';
const DB_URL = process.env.PR8A_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5438/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const GESTORA_UID = `e2e-pr8a-gestora-${RUN_ID}`;
const GESTORA_EMAIL = `${GESTORA_UID}@e2e.test`;
const OWN_GROUP_NAME = `E2E PR8A Own ${RUN_ID}`;
const PASSWORD = 'TestAdmin123!';

let ownGroupId = '';
let recrutadorId = '';
let acessoMasterId = '';

// ── SQL helper — psql direto no Postgres do MEU stack (porta 5438). Não reusa
// `db-test-helper.ts` (fixo em `enlite-postgres`) nem o `DB_URL` de outra
// worktree — a mesma decisão de `admin-access-panel.integration.e2e.ts`. ────
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

// ── Auth mock (molde admin-access-panel.integration.e2e.ts) ─────────────────

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
  // `/v1/me/authz` fora de `/api/**` de propósito (D115 §7) — sem este 2º
  // route o request sai com o JWT do identitytoolkit, USE_MOCK_AUTH recusa, e
  // o painel de acessos nem abre.
  await page.route('**/v1/me/authz', swapToken);
}

async function loginAs(page: Page, u: MockUser): Promise<void> {
  await installAuthInterceptors(page, u);
  await page.goto('/admin/login');
  // Digitação HUMANA: click + keyboard.type, nunca fill() (memória
  // e2e-humano-nao-e-fill) — o valor final é lido de volta da própria tela.
  const email = page.locator('input[type="email"]');
  await email.click();
  await page.keyboard.type(u.email);
  await expect(email).toHaveValue(u.email);
  const senha = page.locator('input[type="password"]');
  await senha.click();
  await page.keyboard.type(PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

// DoD (definicao-de-pronto-frontend): vídeo do fluxo humano, para anexar à
// task — SÓ neste spec (não no `use` global do playwright.config.ts, que
// gravaria todo o resto do projeto `integration`). Tem de ficar no nível do
// ARQUIVO — dentro do `describe` força um worker novo (Playwright recusa).
test.use({ video: 'on' });

test.describe('Permissões — grupos fixos e busca (PR-8a) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${GESTORA_UID}', '${GESTORA_EMAIL}', 'E2E PR8A Gestora', 'admin', true, 'ACTIVE', '${TENANT}')`);

    // Grupo PRÓPRIO da gestora (não o Recrutador nem o Acesso Master — os dois
    // seguem intocados como fixture do seed 206, só lidos/editados pelo teste).
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

    recrutadorId = scalar(`SELECT id FROM iam.permission_groups WHERE tenant_id='${TENANT}' AND name='Recrutador'`);
    acessoMasterId = scalar(`SELECT id FROM iam.permission_groups WHERE tenant_id='${TENANT}' AND name='Acesso Master'`);
    if (!recrutadorId || !acessoMasterId) {
      throw new Error('seed 206 não achado — Recrutador/Acesso Master deveriam existir desde a fundação');
    }
    // limpa qualquer marca residual de rodada anterior nas células que este
    // spec vai marcar no Recrutador (idempotência entre execuções locais).
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id='${recrutadorId}'
          AND permission_id IN (SELECT id FROM iam.permissions WHERE resource='patient_family' AND action='read')`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id IN ('${ownGroupId}', '${recrutadorId}')`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id = '${GESTORA_UID}'`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id='${ownGroupId}'`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id='${ownGroupId}'`);
    safeSql(`DELETE FROM iam.permission_groups WHERE id='${ownGroupId}'`);
    // deixa o Recrutador REAL como achou — sem a célula que este spec marcou.
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id='${recrutadorId}'
          AND permission_id IN (SELECT id FROM iam.permissions WHERE resource='patient_family' AND action='read')`);
    safeSql(`DELETE FROM users WHERE firebase_uid = '${GESTORA_UID}'`);
  });

  const GESTORA: MockUser = { uid: GESTORA_UID, email: GESTORA_EMAIL, role: 'admin', country: 'AR' };

  test('1. feliz — Recrutador (customizável): buscar "familia" filtra a grade; marcar Ver; salvar grava no banco', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${recrutadorId}`);
    await expect(page.getByRole('heading', { name: 'Recrutador' })).toBeVisible({ timeout: 15_000 });

    // Recrutador é customizável desde a mig 432 (FR-701): o lápis existe.
    await expect(page.getByTestId('g-name-editar')).toBeVisible();
    await expect(page.getByText('· Sistema')).toHaveCount(0);

    // antes de buscar: worker:read (não relacionado a família) está na grade.
    await expect(page.getByLabel(/^worker:read/).first()).toBeVisible({ timeout: 10_000 });

    const busca = page.getByRole('searchbox', { name: 'Buscar permisos' });
    await busca.click();
    await page.keyboard.type('familia');
    await expect(busca).toHaveValue('familia');

    // worker sumiu da grade — a busca filtrou; família apareceu.
    await expect(page.getByLabel(/^worker:read/)).toHaveCount(0);
    const verFamilia = page.getByLabel(/^patient_family:read/).first();
    await expect(verFamilia).toBeVisible({ timeout: 10_000 });

    await expect(page.getByTestId('screen-tree')).toHaveScreenshot('permissoes-busca-familia.png', { maxDiffPixelRatio: 0.02 });

    // O checkbox real é `sr-only` (a caixa VISÍVEL é o `<div>` estilizado ao
    // lado) — mesmo padrão de `admin-access-panel.integration.e2e.ts:350`:
    // `force: true` despacha o clique de verdade no input, só pulando a
    // checagem de "está por cima" que o CSS de propósito viola.
    await verFamilia.click({ force: true });
    await page.getByRole('button', { name: 'Guardar células' }).click();
    await expect(page.getByRole('status')).toContainText('Guardado.', { timeout: 10_000 });

    const count = scalar(`SELECT COUNT(*) FROM iam.group_permissions gp
        JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE gp.group_id='${recrutadorId}' AND p.resource='patient_family' AND p.action='read'`);
    expect(count).toBe('1');

    // limpa a busca (backspace humano) — a célula continua marcada, e o resto
    // da grade (worker etc.) volta a aparecer: a busca nunca tocou o `Set`.
    await busca.click();
    for (let i = 0; i < 'familia'.length; i += 1) await page.keyboard.press('Backspace');
    await expect(busca).toHaveValue('');
    await expect(page.getByLabel(/^worker:read/).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel(/^patient_family:read/).first()).toBeChecked();
  });

  test('2. alt — busca sem nenhum resultado mostra a mensagem, não uma grade vazia muda', async ({ page }) => {
    await loginAs(page, GESTORA);
    await page.goto(`/admin/access/groups/${recrutadorId}`);
    await expect(page.getByRole('heading', { name: 'Recrutador' })).toBeVisible({ timeout: 15_000 });

    const busca = page.getByRole('searchbox', { name: 'Buscar permisos' });
    await busca.click();
    await page.keyboard.type('zzz-nao-existe-no-catalogo-de-verdade');
    await expect(page.getByText('Ningún permiso coincide con la búsqueda.')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('screen-tree')).toHaveCount(0);

    await expect(page.getByTestId('screen-tree-no-results')).toHaveScreenshot('permissoes-busca-sem-resultado.png', { maxDiffPixelRatio: 0.02 });
  });

  test('3. alt — Recrutador aceita edição; Acesso Master continua travado (is_system)', async ({ page }) => {
    await loginAs(page, GESTORA);

    await page.goto(`/admin/access/groups/${recrutadorId}`);
    await expect(page.getByRole('heading', { name: 'Recrutador' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('g-name-editar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archivar grupo' })).toBeVisible();

    await page.goto(`/admin/access/groups/${acessoMasterId}`);
    await expect(page.getByRole('heading', { name: 'Acesso Master' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('· Sistema')).toBeVisible();
    await expect(page.getByTestId('g-name-editar')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Archivar grupo' })).toHaveCount(0);

    const isSystemDb = scalar(`SELECT is_system FROM iam.permission_groups WHERE id='${acessoMasterId}'`);
    expect(isSystemDb).toBe('t');
    const recrutadorDb = scalar(`SELECT is_system FROM iam.permission_groups WHERE id='${recrutadorId}'`);
    expect(recrutadorDb).toBe('f');
  });
});
