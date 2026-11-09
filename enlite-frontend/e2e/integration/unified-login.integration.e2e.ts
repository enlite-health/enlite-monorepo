/**
 * unified-login @integration — o login ÚNICO e o destino por área (acesso-do-cliente, F4, T413).
 *
 * Sem mock de DADO: só o Auth do Firebase é forjado (`identitytoolkit`/`securetoken`, padrão da suíte, porque o
 * Vite do CI roda com config Firebase falsa) e o `Authorization` é trocado por `mock_*` em `/api/**` e `/v1/me/areas`
 * (`installAuthInterceptors`: a REQUEST segue para a API real e a resposta é a real). Entrada pela TELA de `/login`
 * (click + `keyboard.type`, valor lido da tela); `GET /v1/me/areas` e `GET /api/admin/auth/profile` vêm da API real
 * com banco real. Vínculos por fixture SQL (`iam.grant_area_membership`) e ficha de prestador por INSERT sintético:
 * nenhum dado pessoal nem clínico. O staff novo tem conta real no emulador (a API faz `admin.auth().getUser`).
 *
 * Casos (fase-4.md itens 2 e 3):
 *   feliz        prestador → WorkerHome
 *   alt 1        staff → /admin/dashboard
 *   alt 2        conta sem área → /no-access; só-aluno → /no-access?reason=unavailable
 *   extra        2 áreas → última usada + seletor visível
 *   extra        prestador com next=/admin → /no-access com ≤ 2 navegações (sem laço)
 *   redirect     /admin/login → /login?next=%2Fadmin
 *   staff novo   @enlite.health sem linha em `users` entra por esse caminho e termina em /admin/dashboard
 */
import { test, expect, type Page } from '@playwright/test';
import { runSQL } from '../helpers/patient-detail-c-helper';
import { installAuthInterceptors, type MockUser } from '../helpers/abac-stack-helper';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR ?? 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = process.env.E2E_FIREBASE_EMULATOR_PROJECT ?? 'demo-no-project';
const SENHA = 'TestAdmin123!';
const TENANT = '00000000-0000-0000-0000-000000000001';
const STAMP = Date.now();
const DOMINIO = `login-unico-${STAMP}.e2e.local`;
const EMAIL_STAFF_NOVO = `novo.${STAMP}@enlite.health`;

const NO_ACCESS = /\/no-access$/;
const NO_ACCESS_UNAVAILABLE = /\/no-access\?reason=unavailable$/;

const conta = (quem: string, role: string): MockUser => ({
  uid: `e2e-lu-${quem}-${STAMP}`, email: `${quem}@${DOMINIO}`, role, country: 'AR',
});

function linhaDeStaff(u: MockUser): void {
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id)
     VALUES ('${u.uid}', '${u.email}', 'Staff LoginUnico', 'recruiter', 'ACTIVE', true, '${TENANT}')
     ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email, status = 'ACTIVE', is_active = true`,
  );
}

function fichaDePrestador(u: MockUser): void {
  runSQL(`INSERT INTO workers (auth_uid, email, status, country) VALUES ('${u.uid}', '${u.email}', 'INCOMPLETE_REGISTER', 'AR')`);
}

/** O vínculo guardado de uma conta que só tem a área `learn` (sem tela ainda). */
function vinculoDeAluno(u: MockUser): void {
  runSQL(`SELECT iam.grant_area_membership(iam.ensure_person('firebase', '${u.uid}'), 'learn', 'learner', 'e2e-login-unico')`);
}

/**
 * Conta REAL no emulador, no projeto que a API consulta (`admin.auth().getUser` do auto-provisionamento; o `signUp` simples
 * cairia no projeto padrão do emulador e a API não a acharia). Devolve o uid.
 */
async function contaNoEmulador(addr: string, uid: string): Promise<string> {
  const emulator = process.env.E2E_FIREBASE_EMULATOR ?? 'http://127.0.0.1:9099';
  const projeto = process.env.E2E_API_FIREBASE_PROJECT ?? 'enlite-e2e-test';
  const res = await fetch(`${emulator}/identitytoolkit.googleapis.com/v1/projects/${projeto}/accounts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ email: addr, password: SENHA, localId: uid }),
  });
  expect(res.ok, `conta ${addr} não criada no emulador`).toBe(true);
  return ((await res.json()) as { localId: string }).localId;
}

/**
 * O `authStore` dispara `POST /api/workers/init` (sem await) em TODO login e a API cria a ficha de prestador de qualquer
 * conta com e-mail — o que daria à conta "sem área"/"só-aluno" a área `care` numa corrida com `GET /v1/me/areas` (flaky medido).
 * Aqui a escrita é BLOQUEADA (não há resposta fabricada): o caso testado é a conta que de fato não tem ficha.
 */
async function semFichaDePrestador(page: Page): Promise<void> {
  // Registrada DEPOIS do swap de `/api/**` (Playwright prioriza a rota mais recente).
  await page.route(/\/workers\/init$/, (route) => route.abort());
}

/** Entra pela tela de login, como uma pessoa: clica no campo, digita, clica no botão. */
async function entrar(page: Page, u: MockUser, caminho = '/login', semFicha = false): Promise<void> {
  await installAuthInterceptors(page, u);
  if (semFicha) await semFichaDePrestador(page);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto(caminho);
  const campoEmail = page.locator('input[type="email"]');
  await campoEmail.click();
  await expect(campoEmail).toBeFocused();
  await page.keyboard.type(u.email);
  await expect(campoEmail).toHaveValue(u.email);
  const campoSenha = page.locator('input[type="password"]');
  await campoSenha.click();
  await expect(campoSenha).toBeFocused();
  await page.keyboard.type(SENHA);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
}

test.describe('@integration login único: destino por área (F4)', () => {
  test.setTimeout(120_000);

  test.afterAll(() => {
    for (const sql of [
      `DELETE FROM users WHERE email LIKE '%@${DOMINIO}' OR email = '${EMAIL_STAFF_NOVO}'`,
      `DELETE FROM workers WHERE email LIKE '%@${DOMINIO}' OR auth_uid LIKE 'e2e-lu-%-${STAMP}'`,
    ]) {
      try { runSQL(sql); } catch { /* limpeza não esconde o resultado do teste */ }
    }
  });

  test('feliz: prestador entra por /login e cai na home do prestador', async ({ page }) => {
    const u = conta('prestador', 'worker');
    fichaDePrestador(u);

    await entrar(page, u);
    await expect(page).toHaveURL((u) => u.pathname === '/', { timeout: 30_000 });
    await expect(page.getByTestId('pending-tasks-card').or(page.getByTestId('jobs-embedded-section')).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('admin-layout')).toHaveCount(0);
  });

  test('alt 1: staff entra por /login e cai em /admin/dashboard', async ({ page }) => {
    const u = conta('staff', 'recruiter');
    linhaDeStaff(u);

    await entrar(page, u);
    await expect(page).toHaveURL(/\/admin\/dashboard\/?$/, { timeout: 30_000 });
    await expect(page.getByTestId('admin-layout')).toHaveCount(1);
  });

  test('alt 2: conta sem nenhuma área → /no-access', async ({ page }) => {
    const u = conta('sem-area', 'worker');

    await entrar(page, u, '/login', true);
    await expect(page).toHaveURL(NO_ACCESS, { timeout: 30_000 });
    await expect(page.getByTestId('no-access-page')).toBeVisible();
    await expect(page.getByTestId('admin-layout')).toHaveCount(0);
  });

  test('alt 2: conta só-aluno (área sem tela ainda) → /no-access?reason=unavailable', async ({ page }) => {
    const u = conta('so-aluno', 'worker');
    vinculoDeAluno(u);

    await entrar(page, u, '/login', true);
    await expect(page).toHaveURL(NO_ACCESS_UNAVAILABLE, { timeout: 30_000 });
    await expect(page.getByTestId('no-access-page')).toBeVisible();
  });

  test('extra: conta com 2 áreas → começa em uma, o seletor aparece e a última usada vale no próximo login', async ({ page }) => {
    const u = conta('duas-areas', 'recruiter');
    linhaDeStaff(u);
    fichaDePrestador(u);

    await entrar(page, u);
    await expect(page).toHaveURL(/\/admin\/dashboard\/?$/, { timeout: 30_000 }); // sem última usada: a primeira da ordem estável
    await expect(page.getByTestId('area-switcher-trigger')).toBeVisible({ timeout: 30_000 });

    // Troca para a área do prestador pelo seletor (grava a última usada).
    await page.getByTestId('area-switcher-trigger').click();
    await page.getByTestId('area-switcher-option-care').click();
    await expect(page).toHaveURL((u) => u.pathname === '/', { timeout: 30_000 });

    // Sessão viva, /login sem `next`: o destino é a ÚLTIMA usada, não a primeira da ordem.
    await page.goto('/login');
    await expect(page).toHaveURL((u) => u.pathname === '/', { timeout: 30_000 });
    await expect(page.getByTestId('admin-layout')).toHaveCount(0);

    // Com `next=/admin` (ela abre essa área) o `next` vale e o seletor continua visível.
    await page.goto('/login?next=%2Fadmin');
    await expect(page).toHaveURL(/\/admin\/dashboard\/?$/, { timeout: 30_000 });
    await expect(page.getByTestId('area-switcher-trigger')).toBeVisible();
  });

  test('extra: prestador com next=/admin → /no-access em ≤ 2 navegações, sem laço', async ({ page }) => {
    const u = conta('prestador-next', 'worker');
    fichaDePrestador(u);

    const navegacoes: string[] = [];
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) navegacoes.push(new URL(f.url()).pathname + new URL(f.url()).search); });

    await entrar(page, u, '/login?next=%2Fadmin');
    const antes = navegacoes.length;
    await expect(page).toHaveURL(NO_ACCESS, { timeout: 30_000 });
    await page.waitForTimeout(3_000); // laço aparece como navegação extra depois de assentar
    await expect(page).toHaveURL(NO_ACCESS);
    const depoisDoClique = navegacoes.slice(antes - 1);
    expect(depoisDoClique.length, `navegações após o login: ${depoisDoClique.join(' → ')}`).toBeLessThanOrEqual(2);
    await expect(page.getByTestId('admin-layout')).toHaveCount(0);
  });

  test('redirect: abrir /admin/login termina em /login?next=%2Fadmin', async ({ page }) => {
    await page.goto('/admin/login');
    await expect(page).toHaveURL((u) => u.pathname === '/login' && u.search === '?next=%2Fadmin', { timeout: 30_000 });
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test('staff @enlite.health NOVO entra por /admin/login e termina em /admin/dashboard (auto-provisionamento)', async ({ page }) => {
    // Papel que o auto-provisionamento concede (RECRUITER); o uid é o de uma conta REAL do emulador.
    const u: MockUser = { uid: await contaNoEmulador(EMAIL_STAFF_NOVO, `e2e-lu-novo-${STAMP}`), email: EMAIL_STAFF_NOVO, role: 'recruiter', country: 'AR' };
    expect(runSQL(`SELECT count(*) FROM users WHERE email = '${EMAIL_STAFF_NOVO}'`)).toBe('0'); // controle: não existe linha antes

    // Ordem das requests vista pela rede (observação, sem interceptar): o perfil tem de vir ANTES das áreas.
    const ordem: string[] = [];
    page.on('request', (r) => {
      const url = r.url();
      if (url.includes('/api/admin/auth/profile')) ordem.push('profile');
      else if (url.includes('/v1/me/areas')) ordem.push('areas');
    });

    await entrar(page, u, '/admin/login');
    await expect(page).toHaveURL(/\/admin\/dashboard\/?$/, { timeout: 30_000 });
    await expect(page.getByTestId('admin-layout')).toHaveCount(1);
    expect(runSQL(`SELECT count(*) FROM users WHERE email = '${EMAIL_STAFF_NOVO}'`)).toBe('1'); // o login provisionou
    expect(ordem.indexOf('profile'), `ordem das chamadas: ${ordem.join(' → ')}`).toBeGreaterThanOrEqual(0);
    expect(ordem.indexOf('profile')).toBeLessThan(ordem.indexOf('areas'));
  });
});
