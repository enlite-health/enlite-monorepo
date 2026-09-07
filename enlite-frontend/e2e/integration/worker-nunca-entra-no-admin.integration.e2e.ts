/**
 * worker-nunca-entra-no-admin @integration — a fronteira staff × prestador vista da TELA (D294).
 *
 * Sem mock em nenhuma camada: conta criada no Firebase Auth (emulador) com o claim
 * `account_type` gravado pela API administrativa, login pelo FORMULÁRIO do painel,
 * `/api/admin/auth/profile` respondido pela API real com banco real.
 *
 * Garantido aqui:
 *   1. o prestador que faz login no painel vê "acesso negado" e continua em /admin/login;
 *   2. com sessão Firebase viva (logado pelo app do prestador), toda rota /admin/* sai do painel
 *      (para /admin/login, ou para `/` no catch-all) — o layout do painel nunca renderiza;
 *   3. controle positivo: staff só com `account_type=staff` (sem `role`) entra e vê a sidebar.
 *
 * Variáveis: E2E_FIREBASE_EMULATOR (default http://127.0.0.1:9099), E2E_PG_CONTAINER
 * (default enlite-postgres). O helper NÃO pula quando o emulador falta: falha.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR ?? 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = process.env.E2E_FIREBASE_EMULATOR_PROJECT ?? 'demo-no-project';
const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'enlite-postgres';
const PASSWORD = 'Teste@123-real-auth';
const TENANT = '00000000-0000-0000-0000-000000000001';
const DOMINIO = 'painel-real.e2e.local';
const WORKER_EMAIL = `prestador@${DOMINIO}`;
const STAFF_EMAIL = `staff-tipo@${DOMINIO}`;

// Rotas REAIS do painel (App.tsx): `/admin` é a lista de usuários (index); caminho inexistente
// sob /admin cai no catch-all `*` e vai para `/` — também coberto, no final.
const ROTAS_DO_PAINEL = ['/admin', '/admin/access', '/admin/patients', '/admin/workers', '/admin/dashboard', '/admin/vacancies', '/admin/tags', '/admin/dedup', '/admin/nao-existe'];
/** URL de tela do painel = /admin ou /admin/<algo> que não seja o login. */
const URL_DE_TELA_DO_PAINEL = /\/admin(\/(?!login)|$)/;

function psql(sql: string): string {
  return execSync(`docker exec ${PG_CONTAINER} psql -U enlite_admin -d enlite_e2e -tAc "${sql}"`, { stdio: 'pipe' }).toString().trim();
}

async function contaNoEmulador(email: string, claims: Record<string, string>): Promise<string> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
  });
  const body = signUp.ok
    ? await signUp.json()
    : await (await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: PASSWORD, returnSecureToken: true }),
      })).json();
  const uid = body.localId as string;
  const upd = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId: uid, customAttributes: JSON.stringify(claims) }),
  });
  if (!upd.ok) throw new Error(`claim não gravado no emulador: ${upd.status}`);
  return uid;
}

async function loginNoPainel(page: Page, email: string): Promise<void> {
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"]').click();
}

test.describe('@integration prestador com login REAL nunca entra em /admin/* (account_type, D294)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    const emu = await fetch(EMULATOR).catch(() => null);
    if (!emu) throw new Error(`emulador do Firebase não responde em ${EMULATOR} — este spec exige token REAL`);

    psql(`DELETE FROM users WHERE email LIKE '%@${DOMINIO}'`);
    await contaNoEmulador(WORKER_EMAIL, { role: 'worker', account_type: 'worker' });
    const staffUid = await contaNoEmulador(STAFF_EMAIL, { account_type: 'staff', country: 'AR' });
    psql(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
       VALUES ('${staffUid}', '${STAFF_EMAIL}', 'Staff Tipo', 'recruiter', 'ACTIVE', true, '${TENANT}')
       ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, status = 'ACTIVE', is_active = true`,
    );
  });

  test.afterAll(() => {
    psql(`DELETE FROM users WHERE email LIKE '%@${DOMINIO}'`);
  });

  test('1. prestador no formulário do painel: "acesso negado", fica em /admin/login, painel não renderiza', async ({ page }) => {
    await loginNoPainel(page, WORKER_EMAIL);
    await expect(page.getByText(/Acesso negado|Acceso denegado|no posee permisos|não possui permissões/i)).toBeVisible({ timeout: 30000 });
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByTestId('admin-layout')).toHaveCount(0);
    await expect(page).toHaveScreenshot('prestador-negado-no-login-do-painel.png', { maxDiffPixelRatio: 0.02 });
  });

  test('2. prestador com sessão Firebase viva: toda rota /admin/* sai do painel, que nunca renderiza', async ({ page }) => {
    // Sessão de prestador: login pelo app do prestador (mesmo Firebase, mesma persistência).
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(WORKER_EMAIL);
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"]').click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 30000 });

    for (const rota of ROTAS_DO_PAINEL) {
      await page.goto(rota);
      // Sai de /admin/*: para /admin/login (AdminProtectedRoute sem perfil) ou para `/` (catch-all).
      await expect(page, `rota ${rota} ficou numa URL do painel`).not.toHaveURL(URL_DE_TELA_DO_PAINEL, { timeout: 30000 });
      await expect(page.getByTestId('admin-layout'), `o layout do painel renderizou em ${rota}`).toHaveCount(0);
    }
  });

  test('3. CONTROLE POSITIVO: staff só com account_type=staff (sem role) entra e vê o painel', async ({ page }) => {
    await loginNoPainel(page, STAFF_EMAIL);
    await expect(page).toHaveURL(/\/admin(?!\/login)/, { timeout: 30000 });
    await expect(page.getByTestId('admin-layout')).toHaveCount(1);
    await expect(page).toHaveScreenshot('staff-so-com-tipo-entra-no-painel.png', { maxDiffPixelRatio: 0.05 });
  });
});
