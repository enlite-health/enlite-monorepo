/**
 * worker-nunca-entra-no-admin @integration — a fronteira staff × prestador vista da TELA (D294).
 *
 * Sem mock de DADO: o Auth do Firebase é forjado (`identitytoolkit`/`securetoken`, padrão da suíte: o Vite do CI roda com
 * config Firebase falsa, então login com token do emulador dá `auth/api-key-not-valid`) e só o `Authorization` é trocado por
 * `mock_*` em `/api/**` e `/v1/me/areas` (`installAuthInterceptors`); a REQUEST segue para a API real com banco real.
 * O tipo da conta vai no token (`account_type`), como o claim do token real. Login pela TELA (click + `keyboard.type`).
 *
 * Garantido aqui:
 *   1. o prestador que tenta entrar no painel (login único `/login?next=%2Fadmin`) NÃO entra: cai em /no-access, o
 *      painel nunca renderiza (acesso-do-cliente F4: next de área que a pessoa não abre → /no-access, sem laço);
 *   2. com sessão viva de prestador, toda rota /admin/* sai do painel (para o login único, ou para `/` no catch-all) —
 *      o layout do painel nunca renderiza;
 *   3. controle positivo: staff só com `account_type=staff` (sem `role`) entra e vê a sidebar.
 *
 * Variável: E2E_PG_CONTAINER (default enlite-postgres).
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { installAuthInterceptors, type MockUser } from '../helpers/abac-stack-helper';

const PG_CONTAINER = process.env.E2E_PG_CONTAINER ?? 'enlite-postgres';
const SENHA = 'TestAdmin123!';
const TENANT = '00000000-0000-0000-0000-000000000001';
const DOMINIO = 'painel-real.e2e.local';
const WORKER: MockUser = { uid: 'e2e-wnea-worker', email: `prestador@${DOMINIO}`, role: 'worker', country: 'AR' };
// Só `account_type` (sem `role`): o mock lê o tipo do token, como o claim real.
const STAFF = { uid: 'e2e-wnea-staff', email: `staff-tipo@${DOMINIO}`, account_type: 'staff', country: 'AR' } as unknown as MockUser;

// Rotas REAIS do painel (App.tsx): `/admin` é o índice (redireciona à Gestão à Vista; Usuários é `/admin/users`); caminho inexistente
// sob /admin cai no catch-all `*` e vai para `/` — também coberto, no final.
const ROTAS_DO_PAINEL = ['/admin', '/admin/access', '/admin/patients', '/admin/workers', '/admin/dashboard', '/admin/vacancies', '/admin/tags', '/admin/dedup', '/admin/nao-existe'];
/** URL de tela do painel = /admin ou /admin/<algo> que não seja o login. */
const URL_DE_TELA_DO_PAINEL = /\/admin(\/(?!login)|$)/;

function psql(sql: string): string {
  return execSync(`docker exec ${PG_CONTAINER} psql -U enlite_admin -d enlite_e2e -tAc "${sql}"`, { stdio: 'pipe' }).toString().trim();
}

/** Entra pela tela de login como uma pessoa: clica no campo, digita, clica no botão. */
async function loginNaTela(page: Page, u: MockUser, caminho: string): Promise<void> {
  await installAuthInterceptors(page, u);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto(caminho);
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(u.email);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type(SENHA);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
}

test.describe('@integration prestador com login pela tela nunca entra em /admin/* (account_type, D294)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(() => {
    psql(`DELETE FROM users WHERE email LIKE '%@${DOMINIO}'`);
    psql(`DELETE FROM workers WHERE email LIKE '%@${DOMINIO}'`);
    // Ficha de prestador sintética: a conta tem a área `care`·`worker` (abre a home), mas NÃO a do painel.
    psql(`INSERT INTO workers (auth_uid, email, status, country) VALUES ('${WORKER.uid}', '${WORKER.email}', 'INCOMPLETE_REGISTER', 'AR')`);
    psql(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
       VALUES ('${STAFF.uid}', '${STAFF.email}', 'Staff Tipo', 'recruiter', 'ACTIVE', true, '${TENANT}')
       ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, status = 'ACTIVE', is_active = true`,
    );
  });

  test.afterAll(() => {
    psql(`DELETE FROM users WHERE email LIKE '%@${DOMINIO}'`);
    psql(`DELETE FROM workers WHERE email LIKE '%@${DOMINIO}'`);
  });

  test('1. prestador tenta o painel pelo login único (next=/admin): vai a /no-access, sem laço, e o painel não renderiza', async ({ page }) => {
    await loginNaTela(page, WORKER, '/login?next=%2Fadmin');
    await expect(page).toHaveURL(/\/no-access$/, { timeout: 30000 });
    await expect(page.getByTestId('no-access-page')).toBeVisible();
    await expect(page.getByTestId('admin-layout')).toHaveCount(0);
    await page.waitForTimeout(2000); // laço de redirect apareceria como nova navegação
    await expect(page).toHaveURL(/\/no-access$/);
  });

  test('2. prestador com sessão Firebase viva: toda rota /admin/* sai do painel, que nunca renderiza', async ({ page }) => {
    // Sessão de prestador: login pelo login único, sem `next` (cai na home do prestador).
    await loginNaTela(page, WORKER, '/login');
    await expect(page).toHaveURL((u) => u.pathname === '/', { timeout: 30000 });

    for (const rota of ROTAS_DO_PAINEL) {
      await page.goto(rota);
      // Sai de /admin/*: para o login único (AdminProtectedRoute sem perfil) ou para `/` (catch-all).
      await expect(page, `rota ${rota} ficou numa URL do painel`).not.toHaveURL(URL_DE_TELA_DO_PAINEL, { timeout: 30000 });
      await expect(page.getByTestId('admin-layout'), `o layout do painel renderizou em ${rota}`).toHaveCount(0);
    }
  });

  test('3. CONTROLE POSITIVO: staff só com account_type=staff (sem role) entra e vê o painel', async ({ page }) => {
    await loginNaTela(page, STAFF, '/login?next=%2Fadmin');
    await expect(page).toHaveURL(/\/admin(?!\/login)/, { timeout: 30000 });
    await expect(page.getByTestId('admin-layout')).toHaveCount(1);
    await expect(page).toHaveScreenshot('staff-so-com-tipo-entra-no-painel.png', { maxDiffPixelRatio: 0.05 });
  });
});
