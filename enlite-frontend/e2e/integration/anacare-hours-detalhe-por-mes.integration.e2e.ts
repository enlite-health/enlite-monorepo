/**
 * anacare-hours-detalhe-por-mes.integration.e2e.ts @integration
 *
 * E2E REAL (sem mock de dado) da spec 037 — o detalhe do paciente em "Horas Ana Care" navega por
 * MÊS: o mês viaja na URL (`?month=`), a lista o passa ao abrir o paciente, e mudar de semana/data
 * BUSCA o mês que falta (nunca "sin turnos" por falta de busca).
 *
 * STACK: o do job `integration-e2e-anacare-hours` (frontend real + `worker-functions` real com
 * ABAC ligado + Postgres real, `ANACARE_HOURS_SOURCE=fake`). SEM `page.route` de dado: a única
 * interceptação é a de AUTH (Identity Toolkit + header `Authorization` do token `mock_*`), o mesmo
 * padrão de `anacare-hours-conferencia`. Os turnos vêm do `FakeAnaCareShiftsSource` (determinístico
 * por mês). Interação HUMANA (`e2e-humano-nao-e-fill`): click + `keyboard.type`, `selectOption`
 * no `<select>` nativo, valores LIDOS da tela — nunca `fill`/`evaluate`/`dispatchEvent`.
 *
 * MASSA: o paciente `AC-PAT-0`. Em setembro tem os dias 1..9 e 30 (a spec 037 moveu
 * `FAKE-2026-09-0-1-4` do dia 10 para o 30); em outubro tem 1..10. Logo:
 *   - semana 07–13/09 → 3 turnos (7, 8, 9);
 *   - semana 28/09–04/10 cruza os meses → 5 turnos (30/09, 01, 02, 03, 04/10).
 * `AC-PAT-0` não é usado por nenhum outro e2e de tela (conferência usa o 6; Axonico, 7/8/9).
 * Spec só LÊ: nenhuma validação é gravada; `afterAll` limpa só os fixtures de iam/users.
 *
 * ERRO de busca de mês: NÃO é provado aqui (o Fake não falha) — está nos unitários do hook e do
 * container (`useAnaCareHoursPatient.test.ts`, `AnaCareHoursDetailContainer.mes.test.tsx`) e nos prints.
 */
import { execFileSync } from 'child_process';
import { test, expect, type Page, type Route } from '@playwright/test';

const DB_URL = process.env.ANACARE_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const PATIENT = 'AC-PAT-0';
const PASSWORD = 'TestAdmin123!';

const LEITURA_UID = `adm-e2e-leitura-${RUN_ID}`;
const LEITURA_EMAIL = `${LEITURA_UID}@e2e.test`;
const GRUPO_LEITURA = `ADM E2E Leitura ${RUN_ID}`;

function psql(sql: string): string {
  try {
    return execFileSync('psql', [DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', sql], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
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

interface MockUser {
  uid: string;
  email: string;
  role: string;
  country: string;
}
const LEITURA: MockUser = { uid: LEITURA_UID, email: LEITURA_EMAIL, role: 'admin', country: 'AR' };

const tokenFor = (u: MockUser): string => 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');
function fakeIdToken(u: MockUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: u.uid, uid: u.uid, email: u.email, iss: 'https://securetoken.google.com/enlite-prd', aud: 'enlite-prd', iat: now, exp: now + 3600 };
  return 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.';
}

/** Login HUMANO (click + keyboard.type) — Identity Toolkit interceptado (padrão de auth do projeto), API real por trás do token `mock_*`. */
async function loginAs(page: Page, u: MockUser): Promise<void> {
  const idToken = fakeIdToken(u);
  const mockToken = tokenFor(u);
  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    const body =
      url.includes('signInWithPassword') || url.includes('signUp')
        ? { kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.uid, email: u.email, idToken, refreshToken: 'fake-refresh', expiresIn: '3600', registered: true }
        : { users: [{ localId: u.uid, email: u.email, emailVerified: true }] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ access_token: idToken, id_token: idToken, expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh' }),
    });
  });
  const swap = async (route: Route): Promise<void> => {
    await route.continue({ headers: { ...route.request().headers(), authorization: `Bearer ${mockToken}` } });
  };
  await page.route('**/api/**', swap);
  await page.route('**/v1/me/authz', swap);

  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
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
  await page.waitForTimeout(1_200); // 2º redirect da tela de login
}

/** Abre a lista pelo MENU, escolhe o mês no seletor (humano) e abre o paciente clicando na linha. */
async function abrirPacientePelaLista(page: Page, mes: string): Promise<void> {
  await page.getByRole('link', { name: 'Horas Ana Care' }).click();
  await expect(page).toHaveURL(/\/admin\/anacare\/horas$/);
  await expect(page.getByRole('heading', { name: 'Horas Ana Care' })).toBeVisible({ timeout: 15_000 });
  const seletorMes = page.getByLabel('Mes', { exact: true });
  await seletorMes.selectOption(mes);
  await expect(seletorMes).toHaveValue(mes);
  const linha = page.getByTestId(`anacare-hours-patient-row-${PATIENT}`);
  await expect(linha).toBeVisible({ timeout: 15_000 });
  await linha.click();
}

/**
 * Digita uma data no `<input type="date">` como um humano: clica, confere o foco, volta ao 1º
 * segmento (mês, no locale en-US fixado abaixo) e digita `MMDDYYYY`. O valor é LIDO de volta do campo.
 */
async function digitarData(page: Page, iso: string): Promise<void> {
  const [y, m, d] = iso.split('-');
  const campo = page.getByTestId('anacare-hours-week-datepicker');
  await campo.click();
  await expect(campo).toBeFocused();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(`${m}${d}${y}`);
  await expect(campo).toHaveValue(iso);
}

const linhasDeTurno = (page: Page) => page.locator('[data-testid^="anacare-hours-shift-row-"]');
const rotuloSemana = (page: Page) => page.getByTestId('anacare-hours-week-label');
const rotuloTotal = (page: Page) => page.getByText(/^Horas totales de /);

/** Conta (sem interceptar) os GET ao detalhe do paciente por mês. */
function contarRequisicoesDoMes(page: Page): (mes: string) => number {
  const vistas: string[] = [];
  page.on('request', (req) => {
    const m = new RegExp(`/api/admin/anacare-hours/months/(\\d{4}-\\d{2})/patients/${PATIENT}($|\\?)`).exec(req.url());
    if (m) vistas.push(m[1]);
  });
  return (mes: string) => vistas.filter((v) => v === mes).length;
}

function nomeDoMes(year: number, month1to12: number): string {
  const nome = new Intl.DateTimeFormat('es', { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month1to12 - 1, 1)));
  return `${nome.charAt(0).toUpperCase()}${nome.slice(1)} ${year}`;
}

test.describe('anacare-hours-detalhe-por-mes — o detalhe navega por mês @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US' });

  test.beforeAll(() => {
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${LEITURA_UID}', '${LEITURA_EMAIL}', 'E2E Leitora Detalhe por mes', 'admin', true, 'ACTIVE', '${TENANT}')`);
    const grupoId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_LEITURA}', 'e2e anacare-horas detalhe por mes — nao mexer manual') RETURNING id`);
    psql(`INSERT INTO iam.group_permissions (group_id, permission_id)
          SELECT '${grupoId}', id FROM iam.permissions WHERE resource='anacare_hours' AND action = 'read'`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${grupoId}', 'AR', '${LEITURA_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${LEITURA_UID}', '${grupoId}', '${TENANT}')`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id = '${LEITURA_UID}'`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id = '${LEITURA_UID}'`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'ADM E2E%${RUN_ID}')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'ADM E2E%${RUN_ID}')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'ADM E2E%${RUN_ID}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid = '${LEITURA_UID}'`);
  });

  test('FELIZ — abre AC-PAT-0 pela lista de setembro, a URL leva ?month=2026-09 e a semana 07–13/09 aparece COM turnos (sem buscar outubro)', async ({ page }) => {
    const requisicoes = contarRequisicoesDoMes(page);
    await loginAs(page, LEITURA);
    await abrirPacientePelaLista(page, '2026-09');

    await expect(page).toHaveURL(/\/admin\/anacare\/horas\/AC-PAT-0\?month=2026-09$/);
    await expect(page.getByRole('heading', { name: `Sin vínculo · ID ${PATIENT}` })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('anacare-hours-week-loading')).toHaveCount(0, { timeout: 15_000 });

    await digitarData(page, '2026-09-07');
    await expect(rotuloSemana(page)).toContainText('7 de septiembre');
    await expect(rotuloSemana(page)).toContainText('13 de septiembre');

    // Contagem LIDA da tela: 7, 8 e 9/09 têm 1 turno cada (a massa do Fake) — e > 0 é a prova de que não é "sin turnos".
    await expect(page.getByTestId('anacare-hours-day-group-2026-09-07')).toBeVisible({ timeout: 15_000 });
    const lidos = await linhasDeTurno(page).count();
    expect(lidos).toBeGreaterThan(0);
    expect(lidos).toBe(3);
    await expect(page.getByTestId('anacare-hours-week-empty')).toHaveCount(0);
    await expect(rotuloTotal(page)).toHaveText('Horas totales de Septiembre 2026');

    // "Sem nenhuma busca de outubro": a semana inteira é de setembro.
    expect(requisicoes('2026-09')).toBeGreaterThanOrEqual(1);
    expect(requisicoes('2026-10')).toBe(0);
  });

  test('ALTERNATIVO 1 — navegar até a semana 28/09–04/10 BUSCA outubro e mostra os turnos dos dois meses; a URL e o total seguem o mês da data selecionada; Volver mantém o mês', async ({ page }) => {
    const requisicoes = contarRequisicoesDoMes(page);
    await loginAs(page, LEITURA);
    await abrirPacientePelaLista(page, '2026-09');
    await expect(page).toHaveURL(/\/admin\/anacare\/horas\/AC-PAT-0\?month=2026-09$/);
    await expect(page.getByTestId('anacare-hours-week-loading')).toHaveCount(0, { timeout: 15_000 });

    // Próxima semana, clique a clique, até o rótulo dizer a semana que cruza os meses (lido da tela).
    for (let i = 0; i < 8; i += 1) {
      if (((await rotuloSemana(page).textContent()) ?? '').includes('28 de septiembre')) break;
      await page.getByTestId('anacare-hours-week-next').click();
    }
    await expect(rotuloSemana(page)).toContainText('28 de septiembre');
    await expect(rotuloSemana(page)).toContainText('4 de octubre');

    // Outubro foi BUSCADO (1 vez) e os 5 turnos dos dois meses estão na tela: 30/09 + 01..04/10.
    await expect.poll(() => requisicoes('2026-10'), { timeout: 15_000 }).toBe(1);
    for (const dia of ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      await expect(page.getByTestId(`anacare-hours-day-group-${dia}`)).toBeVisible({ timeout: 15_000 });
    }
    expect(await linhasDeTurno(page).count()).toBe(5);
    await expect(page.getByTestId('anacare-hours-week-empty')).toHaveCount(0);

    // A data selecionada ainda é de setembro (29/09): URL e total seguem setembro.
    await expect(page.getByTestId('anacare-hours-week-datepicker')).toHaveValue('2026-09-29');
    await expect(page).toHaveURL(/\?month=2026-09$/);
    await expect(rotuloTotal(page)).toHaveText('Horas totales de Septiembre 2026');

    // Escolher 01/10 no seletor (humano): a data passa a ser de outubro → o ?month e o total acompanham.
    const setembroAntes = requisicoes('2026-09');
    await digitarData(page, '2026-10-01');
    await expect(page).toHaveURL(/\/admin\/anacare\/horas\/AC-PAT-0\?month=2026-10$/);
    await expect(rotuloTotal(page)).toHaveText('Horas totales de Octubre 2026');
    await expect(rotuloSemana(page)).toContainText('28 de septiembre'); // mesma semana, os mesmos 5 turnos
    expect(await linhasDeTurno(page).count()).toBe(5);
    // Trocar a data DENTRO da semana não rebusca os meses já carregados.
    expect(requisicoes('2026-10')).toBe(1);
    expect(requisicoes('2026-09')).toBe(setembroAntes);

    // Volver mantém o mês da página: a lista abre em outubro.
    await page.getByTestId('anacare-hours-back').click();
    await expect(page).toHaveURL(/\/admin\/anacare\/horas\?month=2026-10$/);
    await expect(page.getByLabel('Mes', { exact: true })).toHaveValue('2026-10', { timeout: 15_000 });
  });

  test('ALTERNATIVO 2 — o link antigo (sem ?month) e os meses inválidos (2026-07, abc) abrem no mês corrente, lido da tela', async ({ page }) => {
    await loginAs(page, LEITURA);
    const agora = new Date();
    const corrente = nomeDoMes(agora.getFullYear(), agora.getMonth() + 1); // mesma régua de `currentMonthIso`: relógio local do operador

    for (const url of [`/admin/anacare/horas/${PATIENT}`, `/admin/anacare/horas/${PATIENT}?month=2026-07`, `/admin/anacare/horas/${PATIENT}?month=abc`]) {
      await page.goto(url);
      await expect(page.getByRole('heading', { name: `Sin vínculo · ID ${PATIENT}` })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('anacare-hours-week-loading')).toHaveCount(0, { timeout: 15_000 });
      await expect(rotuloTotal(page)).toHaveText(`Horas totales de ${corrente}`);
      // E é o mês corrente de verdade: a data do seletor é de hoje.
      const hoje = `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}-${String(agora.getDate()).padStart(2, '0')}`;
      await expect(page.getByTestId('anacare-hours-week-datepicker')).toHaveValue(hoje);
    }
  });
});
