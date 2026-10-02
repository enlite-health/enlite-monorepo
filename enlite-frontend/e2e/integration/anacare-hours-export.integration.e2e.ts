/**
 * anacare-hours-export.integration.e2e.ts @integration
 *
 * E2E REAL (sem mock de dado) da spec 032 — exportar as horas de UM paciente num período em xlsx
 * (2 abas) para o financeiro. Front real + `worker-functions` real (engine ABAC LIGADO,
 * `ANACARE_HOURS_SOURCE=fake`) + Postgres real. A rota de export NÃO é interceptada: a única
 * interceptação é a de AUTH (Identity Toolkit + header `Authorization` do token `mock_*`), o mesmo
 * padrão de `anacare-hours-conferencia`/`anacare-hours-detalhe-por-mes`. Interação HUMANA
 * (`e2e-humano-nao-e-fill`): click + `keyboard.type`, valores LIDOS da tela, nunca `fill`.
 *
 * STACK: o do job `integration-e2e-anacare-hours` (ver `.github/workflows/_frontend-integration.yml`).
 * Local: `ANACARE_TEST_DB_URL` e `E2E_BACKEND_URL` apontam para o Postgres/API do SEU stack.
 *
 * LEITURA DO ARQUIVO: o xlsx baixado é lido com `xlsx` (devDependency, só em `e2e/`). Linhas "Total"
 * existem nas DUAS abas — a soma exclui `r[0] === 'Total'` e o cabeçalho (senão dobra).
 *
 * MASSA: `AC-PAT-0` (setembro: dias 1..9 e 30) e `AC-PAT-6` (alternativo 1). Spec só LÊ; `afterAll`
 * limpa os fixtures de iam/users e as linhas de trilha do operador criado por esta corrida.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect, type Download, type Page, type Route } from '@playwright/test';
import * as XLSX from 'xlsx';

const DB_URL = process.env.ANACARE_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const API_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = 'TestAdmin123!';
const MES = '2026-09';
const PACIENTE = 'AC-PAT-0';
const OUTRO = 'AC-PAT-6';

const EXPORTA_UID = `exp-e2e-exporta-${RUN_ID}`;
const EXPORTA_EMAIL = `${EXPORTA_UID}@e2e.test`;
const LEITURA_UID = `exp-e2e-leitura-${RUN_ID}`;
const LEITURA_EMAIL = `${LEITURA_UID}@e2e.test`;
const GRUPO_EXPORTA = `EXP E2E Exporta ${RUN_ID}`;
const GRUPO_LEITURA = `EXP E2E Leitura ${RUN_ID}`;

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
const EXPORTA: MockUser = { uid: EXPORTA_UID, email: EXPORTA_EMAIL, role: 'admin', country: 'AR' };
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

/** Abre a lista pelo MENU e escolhe o mês no seletor (humano). */
async function abrirListaNoMes(page: Page, mes: string): Promise<void> {
  await page.getByRole('link', { name: 'Horas Ana Care' }).click();
  await expect(page).toHaveURL(/\/admin\/anacare\/horas$/);
  await expect(page.getByRole('heading', { name: 'Horas Ana Care' })).toBeVisible({ timeout: 15_000 });
  const seletorMes = page.getByLabel('Mes', { exact: true });
  await seletorMes.selectOption(mes);
  await expect(seletorMes).toHaveValue(mes);
  await expect(page.getByTestId(`anacare-hours-patient-row-${PACIENTE}`)).toBeVisible({ timeout: 15_000 });
}

/** Digita uma data num `<input type="date">` do diálogo como um humano (locale en-US: MMDDYYYY) e lê o valor de volta. */
async function digitarDataNoDialogo(page: Page, testId: string, iso: string): Promise<void> {
  const [y, m, d] = iso.split('-');
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
  await page.keyboard.type(`${m}${d}${y}`);
  await expect(campo).toHaveValue(iso);
}

/** Troca o paciente do autocomplete: limpa o campo por teclado (com paciente escolhido o combobox filtra pelo rótulo), digita o ID e escolhe a opção. */
async function escolherPaciente(page: Page, patientId: string): Promise<void> {
  const campo = page.getByTestId('anacare-hours-export-patient');
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page.keyboard.type(patientId);
  const opcao = page.getByTestId(`anacare-hours-export-patient-option-${patientId}`);
  await expect(opcao).toBeVisible();
  await opcao.click();
  await expect(campo).toHaveValue(`Sin vínculo · ID ${patientId}`);
}

/** Confirma e captura o download real; salva num tmp e devolve o nome sugerido + o workbook lido. */
async function confirmarEBaixar(page: Page): Promise<{ filename: string; wb: XLSX.WorkBook }> {
  const confirmar = page.getByTestId('anacare-hours-export-confirm');
  await expect(confirmar).toBeEnabled();
  const [download]: [Download, void] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), confirmar.click()]);
  const filename = download.suggestedFilename();
  const destino = path.join(os.tmpdir(), `anacare-export-${RUN_ID}-${filename}`);
  await download.saveAs(destino);
  const wb = XLSX.read(fs.readFileSync(destino));
  fs.rmSync(destino, { force: true });
  return { filename, wb };
}

type Linha = (string | number | undefined)[];
function linhasDa(wb: XLSX.WorkBook, aba: string): Linha[] {
  const ws = wb.Sheets[aba];
  expect(ws, `aba ${aba} existe`).toBeTruthy();
  return XLSX.utils.sheet_to_json<Linha>(ws, { header: 1, blankrows: false });
}
/** Soma a coluna `col` das linhas de dados (depois do cabeçalho `primeiraCelula`), EXCLUINDO as linhas "Total". */
function somaDaAba(linhas: Linha[], primeiraCelula: string, col: number): { soma: number; n: number } {
  const ini = linhas.findIndex((r) => r[0] === primeiraCelula);
  expect(ini, `cabeçalho ${primeiraCelula} achado`).toBeGreaterThanOrEqual(0);
  const dados = linhas.slice(ini + 1).filter((r) => r[0] !== 'Total');
  const soma = dados.reduce((acc, r) => acc + Number(r[col] ?? 0), 0);
  return { soma: Math.round(soma * 100) / 100, n: dados.length };
}

const rotuloTotal = (page: Page) => page.getByText(/^Horas totales de /);

test.describe('anacare-hours-export — exportar as horas de um paciente em xlsx @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1440, height: 900 }, locale: 'en-US', acceptDownloads: true });

  test.beforeAll(() => {
    for (const [uid, email, nome] of [
      [EXPORTA_UID, EXPORTA_EMAIL, 'E2E Exporta AnaCare'],
      [LEITURA_UID, LEITURA_EMAIL, 'E2E Leitora Export'],
    ]) {
      psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
            VALUES ('${uid}', '${email}', '${nome}', 'admin', true, 'ACTIVE', '${TENANT}')`);
    }
    for (const [grupo, uid, acoes] of [
      [GRUPO_EXPORTA, EXPORTA_UID, "'read','export'"],
      [GRUPO_LEITURA, LEITURA_UID, "'read'"],
    ]) {
      const id = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
            VALUES ('${TENANT}', '${grupo}', 'e2e anacare-horas export — nao mexer manual') RETURNING id`);
      psql(`INSERT INTO iam.group_permissions (group_id, permission_id)
            SELECT '${id}', id FROM iam.permissions WHERE resource='anacare_hours' AND action IN (${acoes})`);
      psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${id}', 'AR', '${uid}', 'e2e setup')`);
      psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${uid}', '${id}', '${TENANT}')`);
    }
    // Pré-condição lida do banco: a célula nova existe no catálogo (0 = catálogo sem sync = teste mudo).
    expect(Number(scalar(`SELECT count(*) FROM iam.permissions WHERE resource='anacare_hours' AND action='export'`))).toBe(1);
  });

  test.afterAll(() => {
    const uids = [EXPORTA_UID, LEITURA_UID];
    safeSql(`DELETE FROM resource_access_log WHERE operator_uid IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'EXP E2E%${RUN_ID}')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'EXP E2E%${RUN_ID}')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'EXP E2E%${RUN_ID}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  test('FELIZ — lista de setembro → Exportar → baixa o xlsx: soma do Sintético = soma do Analítico = total do mês lido da tela', async ({ page }) => {
    await loginAs(page, EXPORTA);
    await abrirListaNoMes(page, MES);

    await page.getByTestId('anacare-hours-export-button').click();
    await expect(page.getByTestId('anacare-hours-export-dialog')).toBeVisible();
    await expect(page.getByTestId('anacare-hours-export-desde')).toHaveValue('2026-09-01');
    await expect(page.getByTestId('anacare-hours-export-hasta')).toHaveValue('2026-09-30');

    const campo = page.getByTestId('anacare-hours-export-patient');
    await campo.click();
    await expect(campo).toBeFocused();
    await page.keyboard.type(PACIENTE);
    await page.getByTestId(`anacare-hours-export-patient-option-${PACIENTE}`).click();
    await expect(campo).toHaveValue(`Sin vínculo · ID ${PACIENTE}`);

    const { filename, wb } = await confirmarEBaixar(page);
    // Prova o `exposedHeaders` (nome via X-Export-Filename entre origens) — sem hífen nas partes.
    expect(filename).toBe('Sin_vinculo_ID_ACPAT0-2026-09-01-2026-09-30.xlsx');
    await expect(page.getByTestId('anacare-hours-export-dialog')).toHaveCount(0);

    expect(wb.SheetNames).toEqual(['Sintético', 'Analítico']);
    const sintetico = linhasDa(wb, 'Sintético');
    const analitico = linhasDa(wb, 'Analítico');
    expect(sintetico.some((r) => r[0] === 'Documento confidencial')).toBe(true);
    expect(sintetico.find((r) => r[0] === 'Paciente')?.[1]).toBe(`Sin vínculo · ID ${PACIENTE}`);
    const sinte = somaDaAba(sintetico, 'Prestador', 2);
    const anali = somaDaAba(analitico, 'Fecha', 7);
    expect(sinte.n, 'prestadores no Sintético (zero = não li nada)').toBeGreaterThan(0);
    expect(anali.n, 'turnos no Analítico (zero = não li nada)').toBeGreaterThan(0);
    expect(sinte.soma).toBeGreaterThan(0);

    // Número LIDO DA TELA: detalhe do mesmo paciente, mesmo mês (clica a linha na lista, que ainda está em setembro).
    await page.getByTestId(`anacare-hours-patient-row-${PACIENTE}`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/anacare/horas/${PACIENTE}\\?month=${MES}$`));
    await expect(page.getByTestId('anacare-hours-week-loading')).toHaveCount(0, { timeout: 15_000 });
    await expect(rotuloTotal(page)).toHaveText('Horas totales de Septiembre 2026');
    const textoTela = await rotuloTotal(page).locator('xpath=following-sibling::*[1]').innerText();
    const tela = Number.parseFloat(textoTela);
    expect(Number.isNaN(tela), `número lido da tela: "${textoTela}"`).toBe(false);

    console.log(`[export-e2e] tela=${tela} sintetico=${sinte.soma} analitico=${anali.soma}`);
    expect(sinte.soma).toBeCloseTo(anali.soma, 2);
    expect(Math.abs(sinte.soma - tela)).toBeLessThanOrEqual(0.05 + 1e-9); // a tela mostra 1 casa (arredonda o total de 2 casas do arquivo)

    // Trilha: 1 linha por clique, só com IDs (sem nome).
    const trilha = scalar(
      `SELECT count(*) FROM resource_access_log WHERE operator_uid='${EXPORTA_UID}' AND resource_id='${PACIENTE}' AND action='export_xlsx:ambos:2026-09-01:2026-09-30'`,
    );
    expect(Number(trilha)).toBe(1);
  });

  test('ALTERNATIVO 1 — no detalhe de AC-PAT-0 troca o paciente no autocomplete: baixa o de AC-PAT-6 e a URL não muda (+ bordas do período)', async ({ page }) => {
    await loginAs(page, EXPORTA);
    await abrirListaNoMes(page, MES);
    await page.getByTestId(`anacare-hours-patient-row-${PACIENTE}`).click();
    const urlDetalhe = new RegExp(`/admin/anacare/horas/${PACIENTE}\\?month=${MES}$`);
    await expect(page).toHaveURL(urlDetalhe);
    await expect(page.getByTestId('anacare-hours-week-loading')).toHaveCount(0, { timeout: 15_000 });

    await page.getByTestId('anacare-hours-export-button').click();
    await expect(page.getByTestId('anacare-hours-export-dialog')).toBeVisible();
    // Pré-preenchido pelo detalhe: paciente e mês.
    await expect(page.getByTestId('anacare-hours-export-patient')).toHaveValue(`Sin vínculo · ID ${PACIENTE}`);
    await expect(page.getByTestId('anacare-hours-export-desde')).toHaveValue('2026-09-01');
    await expect(page.getByTestId('anacare-hours-export-hasta')).toHaveValue('2026-09-30');

    // Bordas baratas (mesmo diálogo, sem custo de stack): Hasta < Desde e 63 dias desabilitam com o motivo.
    await digitarDataNoDialogo(page, 'anacare-hours-export-hasta', '2026-08-31');
    await expect(page.getByTestId('anacare-hours-export-reason')).toHaveText('Revise las fechas: «Hasta» no puede ser anterior a «Desde».');
    await expect(page.getByTestId('anacare-hours-export-confirm')).toBeDisabled();
    await digitarDataNoDialogo(page, 'anacare-hours-export-hasta', '2026-09-30');
    await digitarDataNoDialogo(page, 'anacare-hours-export-desde', '2026-07-30'); // 30/07..30/09 = 63 dias
    await expect(page.getByTestId('anacare-hours-export-reason')).toHaveText('El período no puede superar los 62 días.');
    await expect(page.getByTestId('anacare-hours-export-confirm')).toBeDisabled();
    await digitarDataNoDialogo(page, 'anacare-hours-export-desde', '2026-09-01');
    await expect(page.getByTestId('anacare-hours-export-reason')).toHaveCount(0);

    await escolherPaciente(page, OUTRO);
    const { filename, wb } = await confirmarEBaixar(page);
    expect(filename).toBe('Sin_vinculo_ID_ACPAT6-2026-09-01-2026-09-30.xlsx');
    expect(linhasDa(wb, 'Sintético').find((r) => r[0] === 'Paciente')?.[1]).toBe(`Sin vínculo · ID ${OUTRO}`);
    expect(linhasDa(wb, 'Analítico').find((r) => r[0] === 'Paciente')?.[1]).toBe(`Sin vínculo · ID ${OUTRO}`);
    expect(somaDaAba(linhasDa(wb, 'Analítico'), 'Fecha', 7).n, 'turnos de AC-PAT-6 (zero = não li nada)').toBeGreaterThan(0);

    // Trocar no diálogo NÃO navega: continua no detalhe do paciente de antes.
    await expect(page).toHaveURL(urlDetalhe);
    await expect(page.getByRole('heading', { name: `Sin vínculo · ID ${PACIENTE}` })).toBeVisible();
  });

  test('ALTERNATIVO 2 — conta sem anacare_hours:export: botão desabilitado com o motivo na lista e no detalhe; a API devolve 403', async ({ page }) => {
    await loginAs(page, LEITURA);
    await abrirListaNoMes(page, MES);

    const botao = page.getByTestId('anacare-hours-export-button');
    await expect(botao).toBeVisible();
    await expect(botao).toBeDisabled();
    await expect(page.getByTestId('anacare-hours-export-disabled-reason')).toHaveText('No tiene permiso para exportar las horas.');

    await page.getByTestId(`anacare-hours-patient-row-${PACIENTE}`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/anacare/horas/${PACIENTE}\\?month=${MES}$`));
    await expect(botao).toBeDisabled();
    await expect(page.getByTestId('anacare-hours-export-disabled-reason')).toHaveText('No tiene permiso para exportar las horas.');

    // Chamada direta (sem a tela): o back também nega — a célula é do servidor, não do botão.
    const resp = await page.request.get(`${API_URL}/api/admin/anacare-hours/patients/${PACIENTE}/export?desde=2026-09-01&hasta=2026-09-30`, {
      headers: { authorization: `Bearer ${tokenFor(LEITURA)}` },
    });
    expect(resp.status()).toBe(403);
    expect(Number(scalar(`SELECT count(*) FROM resource_access_log WHERE operator_uid='${LEITURA_UID}' AND action LIKE 'export_xlsx%'`))).toBe(0);
  });
});
