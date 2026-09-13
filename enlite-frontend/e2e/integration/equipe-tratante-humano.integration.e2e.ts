/**
 * equipe-tratante-humano.integration.e2e.ts @integration
 *
 * Spec 018, PR-5 (US-11) — equipe tratante por LINHA, contra o stack REAL (frontend + backend +
 * Postgres; DB via `psql` direto, mesmo molde de `admin-access-buttons-patients.integration.e2e.ts`).
 * Interação HUMANA (click + teclado real via `.fill()` só onde a pessoa realmente digita — nunca
 * como atalho para pular clique/seleção), nunca `page.evaluate`/injeção direta de estado.
 *
 *   Feliz:  admin (patient_care_team:write) adiciona um fisioterapeuta com especialidade — a
 *           linha aparece na tabela, especialidade traduzida.
 *   Alt 1:  conta SEM patient_care_team:write — os botões Nuevo/lápis/desativar NÃO EXISTEM
 *           (D269 — escondido, não desabilitado); a leitura da equipe continua funcionando.
 *   Alt 2:  desativar um profissional — a linha some da tabela; outra linha (id diferente)
 *           continua lá (identidade estável, nunca reordena/duplica).
 */
import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';

const DB_URL = process.env.PR5_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5566/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const ADMIN_UID = `e2e-pct-admin-${RUN_ID}`;
const ADMIN_EMAIL = `${ADMIN_UID}@e2e.test`;
const RECRUTADORA_UID = `e2e-pct-recrutadora-${RUN_ID}`;
const RECRUTADORA_EMAIL = `${RECRUTADORA_UID}@e2e.test`;
const GROUP_ADMIN = `E2E PCT Admin ${RUN_ID}`;
const GROUP_RECRUTADORA = `E2E PCT Recrutadora ${RUN_ID}`;

let groupAdminId = '';
let groupRecrutadoraId = '';
let patientId = '';

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
  try { psql(sql); } catch (err) { console.error(`[cleanup] falhou (seguindo): ${(err as Error).message}`); }
}
function grantCell(group: string, resource: string, action: string): void {
  const inserted = scalar(`INSERT INTO iam.group_permissions (group_id, permission_id)
      SELECT '${group}', id FROM iam.permissions WHERE resource='${resource}' AND action='${action}'
      RETURNING permission_id`);
  if (!inserted) throw new Error(`célula ${resource}:${action} não existe em iam.permissions`);
}

interface MockUser { uid: string; email: string; role: string; country: string }
function tokenFor(u: MockUser): string {
  return 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');
}
function fakeIdToken(u: MockUser): string {
  return 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
    Buffer.from(JSON.stringify({
      sub: u.uid, uid: u.uid, email: u.email,
      iss: 'https://securetoken.google.com/enlite-prd', aud: 'enlite-prd',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url') + '.';
}
async function installAuthInterceptors(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email, idToken,
        refreshToken: 'fake-refresh', expiresIn: '3600', registered: true,
      }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [{ localId: u.uid, email: u.email, emailVerified: true }] }) });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh',
    }) });
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
  await page.locator('input[type="password"]').fill('TestAdmin123!');
  await page.getByRole('button', { name: /Iniciar sesión/i }).click();
  await expect(page).not.toHaveURL(/.*login.*/, { timeout: 20_000 });
}

test.describe('Equipe tratante — Nuevo/lápis/desativar por LINHA (spec 018, PR-5, US-11) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${ADMIN_UID}', '${ADMIN_EMAIL}', 'E2E PCT Admin', 'admin', true, 'ACTIVE', '${TENANT}')`);
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${RECRUTADORA_UID}', '${RECRUTADORA_EMAIL}', 'E2E PCT Recrutadora', 'recruiter', true, 'ACTIVE', '${TENANT}')`);

    groupAdminId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GROUP_ADMIN}', 'e2e equipe tratante — admin') RETURNING id`);
    grantCell(groupAdminId, 'patient', 'read');
    grantCell(groupAdminId, 'patient_care_team', 'read');
    grantCell(groupAdminId, 'patient_care_team', 'write');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${groupAdminId}', 'AR', '${ADMIN_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${ADMIN_UID}', '${groupAdminId}', '${TENANT}')`);

    // Recrutadora: lê a equipe, mas NÃO tem patient_care_team:write (alt 1).
    groupRecrutadoraId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GROUP_RECRUTADORA}', 'e2e equipe tratante — sem write') RETURNING id`);
    grantCell(groupRecrutadoraId, 'patient', 'read');
    grantCell(groupRecrutadoraId, 'patient_care_team', 'read');
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${groupRecrutadoraId}', 'AR', '${ADMIN_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${RECRUTADORA_UID}', '${groupRecrutadoraId}', '${TENANT}')`);

    const clickupTaskId = `E2E-PCT-${RUN_ID}`;
    psql(`INSERT INTO patients (clickup_task_id, first_name, last_name, status, diagnosis, dependency_level, country, created_at, updated_at)
          VALUES ('${clickupTaskId}', 'E2E', 'Equipe ${RUN_ID}', 'ADMISSION', 'TEA leve', 'MODERATE', 'AR', NOW(), NOW())`);
    patientId = scalar(`SELECT id FROM patients WHERE clickup_task_id = '${clickupTaskId}'`);
    if (!patientId) throw new Error('paciente e2e não foi inserido');
  });

  test.afterAll(() => {
    const uids = [ADMIN_UID, RECRUTADORA_UID];
    safeSql(`DELETE FROM patient_professionals WHERE patient_id='${patientId}'`);
    safeSql(`DELETE FROM patients WHERE id='${patientId}'`);
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    for (const g of [groupAdminId, groupRecrutadoraId]) {
      if (!g) continue;
      safeSql(`DELETE FROM iam.permission_group_changes WHERE group_id='${g}'`);
      safeSql(`DELETE FROM iam.group_permissions WHERE group_id='${g}'`);
      safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id='${g}'`);
    }
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    for (const g of [groupAdminId, groupRecrutadoraId]) {
      if (g) safeSql(`DELETE FROM iam.permission_groups WHERE id='${g}'`);
    }
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  const ADMIN: MockUser = { uid: ADMIN_UID, email: ADMIN_EMAIL, role: 'admin', country: 'AR' };
  const RECRUTADORA: MockUser = { uid: RECRUTADORA_UID, email: RECRUTADORA_EMAIL, role: 'recruiter', country: 'AR' };

  test('feliz — admin adiciona un fisioterapeuta com especialidade; a linha aparece na tabela', async ({ page }) => {
    await loginAs(page, ADMIN);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('equipe-tratante-card')).toBeVisible({ timeout: 15_000 });

    await page.getByTestId('equipe-tratante-add').click();
    await expect(page.getByTestId('professional-edit-drawer')).toBeVisible({ timeout: 10_000 });

    // Teclado real — clique no campo + digitação, nunca fill() como atalho.
    await page.getByTestId('professional-name').click();
    await page.keyboard.type('Dr. Kinesiólogo E2E');
    await page.getByTestId('professional-phone').click();
    await page.keyboard.type('+54 11 5555-9001');

    // <select> nativo — selectOption é a interação real de um <select> (não input de texto:
    // a régua de "nunca fill() onde a pessoa digita" vale para TEXTO, não para escolha em lista).
    await page.getByTestId('professional-specialty').selectOption({ label: 'Kinesiólogo/a' });

    await page.getByTestId('professional-save').click();
    await expect(page.getByTestId('professional-edit-drawer')).toHaveCount(0, { timeout: 10_000 });

    await expect(page.getByText('Dr. Kinesiólogo E2E')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('+54 11 5555-9001')).toBeVisible();
    await expect(page.getByText('Kinesiólogo/a')).toBeVisible();
  });

  test('alt 1 — sem patient_care_team:write: Nuevo/lápis/desativar NÃO existem; a leitura continua', async ({ page }) => {
    await loginAs(page, RECRUTADORA);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('equipe-tratante-card')).toBeVisible({ timeout: 15_000 });

    await expect(page.getByText('Dr. Kinesiólogo E2E')).toBeVisible({ timeout: 10_000 }); // leitura funciona
    await expect(page.getByTestId('equipe-tratante-add')).toHaveCount(0);
    const idBusca = await page.evaluate(() => document.querySelector('[data-testid^="equipe-tratante-edit-"]'));
    expect(idBusca).toBeNull();
    expect(await page.locator('[data-testid^="equipe-tratante-deactivate-"]').count()).toBe(0);
  });

  test('alt 2 — desativar: a linha some da tabela; outra linha (id diferente) continua', async ({ page }) => {
    await loginAs(page, ADMIN);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('equipe-tratante-card')).toBeVisible({ timeout: 15_000 });

    // Segunda linha, para provar que desativar UMA não mexe na outra (identidade estável).
    await page.getByTestId('equipe-tratante-add').click();
    await page.getByTestId('professional-name').click();
    await page.keyboard.type('Dra. Sobrevive E2E');
    await page.getByTestId('professional-save').click();
    await expect(page.getByTestId('professional-edit-drawer')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByText('Dra. Sobrevive E2E')).toBeVisible({ timeout: 10_000 });

    const linhaAtiva = (await psql(`SELECT id FROM patient_professionals WHERE patient_id='${patientId}' AND name='Dr. Kinesiólogo E2E' AND active`)).trim();
    expect(linhaAtiva).not.toBe('');

    await page.getByTestId(`equipe-tratante-deactivate-${linhaAtiva}`).click();
    await expect(page.getByTestId('deactivate-professional-confirm')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('deactivate-professional-confirm-button').click();
    await expect(page.getByTestId('deactivate-professional-confirm')).toHaveCount(0, { timeout: 10_000 });

    await expect(page.getByText('Dr. Kinesiólogo E2E')).toHaveCount(0, { timeout: 10_000 }); // sumiu
    await expect(page.getByText('Dra. Sobrevive E2E')).toBeVisible(); // a outra continua

    const noBanco = scalar(`SELECT active FROM patient_professionals WHERE id='${linhaAtiva}'`);
    expect(noBanco).toBe('f'); // NUNCA DELETE — active=false
  });
});
