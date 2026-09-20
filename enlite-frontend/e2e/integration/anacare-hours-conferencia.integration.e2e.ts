/**
 * anacare-hours-conferencia.integration.e2e.ts @integration
 *
 * E2E REAL (sem mock de API) da tela "Conferência de horas do Ana Care" (fase 1, spec
 * `anacare-conferencia-de-horas`) — frontend real + `worker-functions` real (engine ABAC LIGADO,
 * `ANACARE_HOURS_SOURCE=fake`) + Postgres real. Login humano (click + keyboard.type,
 * `abac-stack-helper.ts`); interação com a TELA sempre humana (click + keyboard.type, nunca
 * `fill()`/`forceFill`/`evaluate` — memória `e2e-humano-nao-e-fill`).
 *
 * STACK (default, já de pé nesta worktree — ver docs/relatório da task):
 *   API      http://localhost:8080  (container `enlite-api`, projeto docker `worker-functions`)
 *   Postgres postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e
 *   Vite     http://localhost:5173  — SEM VITE_FIREBASE_AUTH_EMULATOR (padrão do projeto
 *            `integration`, ver `dev-server-do-integration-igual-ao-ci` na memória): os specs de
 *            integração interceptam identitytoolkit.googleapis.com por page.route; com o emulador
 *            ligado o SDK chamaria localhost:9099 e o login nunca completaria.
 *   API precisa dos envs: ANACARE_HOURS_SOURCE=fake, PERMISSION_ENGINE_ENABLED=true,
 *   PERMISSION_ENFORCED_ROUTES=admin.patients, PERMISSION_CATALOG_SYNC_ENABLED=true — rebuild com
 *   `docker compose -p worker-functions -f docker-compose.yml -f docker-compose.test.yml -f
 *   <override>.yml up -d --build --no-deps api` (a imagem é da worktree que a buildou).
 *
 * DADOS: adapter FALSO (`FakeAnaCareShiftsSource`) — 10 pacientes sintéticos × 2 prestadores × 5
 * turnos, DETERMINÍSTICO por mês. Usamos só o paciente `AC-PAT-6` (evita colidir com os pacientes
 * 1/2 que o e2e de API do backend, `anacare-hours-api.e2e.test.ts`, também usa e LIMPA a cada
 * corrida). Turnos usados — `FAKE-<mês>-6-0-{0..4}` (sin_checkin/web_admin/app/app/web_admin, na
 * mesma ordem determinística de `buildOriginSequence`) — **`<mês>` NÃO é mais cravado** (Tarefa 3,
 * 16/09, revisto 20/09: a tela abre no MÊS CORRENTE, `currentMonthIso`); o arquivo calcula o mesmo
 * mês em runtime (`currentMonthIsoForE2E`), senão o teste quebraria assim que rodasse noutro mês.
 *
 * Isolamento entre corridas: RUN_ID no uid/e-mail dos 2 staff + no nome do grupo; `afterAll`
 * limpa `shift_hours_validation` dos turnos tocados (por sourceShiftId) e os fixtures de iam —
 * nunca `TRUNCATE`/`DELETE` largo (outras sessões usam o mesmo Postgres).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { test, expect, type Page, type Route } from '@playwright/test';

/**
 * O caminho anterior era ABSOLUTO da máquina do autor (`/Users/gabrielstein-dev/...`) — no
 * runner do CI esse diretório não existe e a escrita do print falha com ENOENT (mesma classe de
 * bug documentada em `admissao-cid11-ux-audit.integration.e2e.ts`). `ANACARE_HOURS_EVIDENCE_DIR`
 * mantém o print saindo em `ebrain/medicoes/anacare-conferencia-horas-f1/` para quem rodar local
 * com essa env; sem ela, cai num diretório RELATIVO ao repo que existe em qualquer runner. O
 * `mkdir` é preguiçoso — só na primeira captura, nunca ao carregar o módulo.
 */
const PRINTS_DIR =
  process.env.ANACARE_HOURS_EVIDENCE_DIR ?? path.resolve(process.cwd(), 'e2e', '__evidence__', 'anacare-conferencia-horas-f1');
let printsDirEnsured = false;
const print = (page: Page, name: string) => {
  if (!printsDirEnsured) {
    fs.mkdirSync(PRINTS_DIR, { recursive: true });
    printsDirEnsured = true;
  }
  return page.screenshot({ path: path.join(PRINTS_DIR, name), fullPage: true });
};

const DB_URL = process.env.ANACARE_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TENANT = '00000000-0000-0000-0000-000000000001';
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const COMPLETO_UID = `ach-e2e-completo-${RUN_ID}`;
const COMPLETO_EMAIL = `${COMPLETO_UID}@e2e.test`;
const LEITURA_UID = `ach-e2e-leitura-${RUN_ID}`;
const LEITURA_EMAIL = `${LEITURA_UID}@e2e.test`;

const GRUPO_COMPLETO = `ACH E2E Completo ${RUN_ID}`;
const GRUPO_LEITURA = `ACH E2E Leitura ${RUN_ID}`;

/**
 * Tarefa 3 (16/09, revisto 20/09): `AnaCareHoursListContainer`/`AnaCareHoursPatientPage` não têm
 * mais mês cravado — nascem no MÊS CORRENTE (`currentMonthIso`, `selectors.ts`). Um `'2026-08'`
 * fixo aqui quebraria assim que o teste rodasse num mês diferente (o adapter falso só tem turnos
 * do mês pedido). Por isso o e2e calcula o MESMO mês que o app vai pedir, e monta os ids
 * sintéticos (`FakeAnaCareShiftsSource.generateMonth`, determinístico por mês) em cima dele.
 */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}
/**
 * Mesma régua de `currentMonthIso` (`selectors.ts`, decisão do Gabriel, 20/09): relógio do
 * OPERADOR LOGADO (fuso local), `getFullYear`/`getMonth` — NUNCA `getUTC*`. Réplica local, não
 * import — este arquivo é intencionalmente autocontido (ver nota da massa acima).
 */
function currentMonthIsoForE2E(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}`;
}
const MONTH = currentMonthIsoForE2E();
const [MONTH_YEAR, MONTH_NUM] = MONTH.split('-').map(Number);
const DIM = daysInMonth(MONTH_YEAR, MONTH_NUM);

/** Mesma fórmula de `FakeAnaCareShiftsSource.generateMonth`: `day = (shiftIndex % dim) + 1`. Paciente `AC-PAT-6` (p=6) × prestador 0 (pr=0) → `shiftIndex = 60 + s`. */
function shiftDateForIndexS(s: number): string {
  const shiftIndex = 6 * 2 * 5 + 0 * 5 + s; // p=6, PROVIDERS_PER_PATIENT=2, SHIFTS_PER_PROVIDER=5, pr=0
  const day = (shiftIndex % DIM) + 1;
  return `${MONTH}-${pad2(day)}`;
}

const SHIFT_SIN_CHECKIN = `FAKE-${MONTH}-6-0-0`;
const SHIFT_CONTESTAR = `FAKE-${MONTH}-6-0-1`;
const SHIFT_VALIDAR_INDIVIDUAL = `FAKE-${MONTH}-6-0-2`;
const SHIFT_LOTE_A = `FAKE-${MONTH}-6-0-3`;
const SHIFT_LOTE_B = `FAKE-${MONTH}-6-0-4`;
const SHIFT_IDS_TOCADOS = [SHIFT_SIN_CHECKIN, SHIFT_CONTESTAR, SHIFT_VALIDAR_INDIVIDUAL, SHIFT_LOTE_A, SHIFT_LOTE_B];

const DATE_SIN_CHECKIN = shiftDateForIndexS(0);
const DATE_CONTESTAR = shiftDateForIndexS(1);
const DATE_VALIDAR_INDIVIDUAL = shiftDateForIndexS(2);
const DATE_LOTE_A = shiftDateForIndexS(3);
const DATE_LOTE_B = shiftDateForIndexS(4);

// ── Eixo por DIA (16/09, revisto 20/09) — `DEFAULT_WEEK_START` ESPELHA a fórmula de
// `AnaCareHoursDetailPage.tsx:110-111`: se o mês exibido (`MONTH`) contém HOJE, abre na semana de
// hoje; senão, na semana do dia 1º do mês. A premissa antiga (semana do turno MAIS ANTIGO do
// paciente) só batia com o app por acidente: enquanto o mês padrão era o ANTERIOR, só o segundo
// ramo do app era alcançável e os dois valores coincidiam. Esta branch trocou o padrão pro mês
// CORRENTE — os ramos divergem (medido: 2 semanas) — por isso o cálculo aqui tem de replicar o
// app, não o turno mais antigo. Cálculo de navegação replica `startOfWeekMonday`/
// `groupShiftsByDayInWeek` (`selectors.ts`) — nunca um número cravado, senão quebra quando o
// mês/ano mudar.
function startOfWeekMonday(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const isoWeekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (isoWeekday - 1));
  return date.toISOString().slice(0, 10);
}
function weeksBetweenMondays(fromMondayIso: string, toMondayIso: string): number {
  const from = Date.parse(`${fromMondayIso}T00:00:00Z`);
  const to = Date.parse(`${toMondayIso}T00:00:00Z`);
  return Math.round((to - from) / (7 * 24 * 60 * 60 * 1000));
}
/** Mesma régua de `todayIsoLocal` (`selectors.ts`, decisão do Gabriel, 20/09) — fuso LOCAL, nunca `toISOString()` (UTC). Réplica local, não import (arquivo autocontido). */
function todayIsoLocalForE2E(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}
const DEFAULT_WEEK_START = startOfWeekMonday(
  MONTH === todayIsoLocalForE2E().slice(0, 7) ? todayIsoLocalForE2E() : `${MONTH}-01`,
);

/**
 * Navegador de semana COM ESTADO — a página só sabe "próxima"/"anterior" (relativo ao que está
 * na tela), então o teste precisa rastrear em qual semana ele DEIXOU a UI pra calcular quantos
 * cliques faltam pra semana do PRÓXIMO turno-alvo (nunca assumir 0 cliques = "já está lá"). Um
 * `irPara` calculando sempre a partir de `DEFAULT_WEEK_START` estaria ERRADO depois do primeiro
 * `irPara` desta instância (a página já não está mais na semana padrão) — por isso o estado.
 */
function criarNavegadorDeSemana(page: Page): { irPara: (dateIso: string) => Promise<void>; resetarAposReloadOuMount: () => void } {
  let atual = DEFAULT_WEEK_START;
  return {
    async irPara(dateIso: string): Promise<void> {
      const alvo = startOfWeekMonday(dateIso);
      const delta = weeksBetweenMondays(atual, alvo);
      if (delta > 0) {
        for (let i = 0; i < delta; i += 1) await page.getByTestId('anacare-hours-week-next').click();
      } else if (delta < 0) {
        for (let i = 0; i < -delta; i += 1) await page.getByTestId('anacare-hours-week-prev').click();
      }
      atual = alvo;
    },
    resetarAposReloadOuMount(): void {
      // Mount novo (`goto`/`reload`) sempre reabre na semana PADRÃO (`weekStart` é estado de
      // componente, não persiste) — o rastreador precisa saber disso pra não contar cliques que a
      // página já perdeu.
      atual = DEFAULT_WEEK_START;
    },
  };
}

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
const COMPLETO: MockUser = { uid: COMPLETO_UID, email: COMPLETO_EMAIL, role: 'admin', country: 'AR' };
const LEITURA: MockUser = { uid: LEITURA_UID, email: LEITURA_EMAIL, role: 'admin', country: 'AR' };
const PASSWORD = 'TestAdmin123!';

const tokenFor = (u: MockUser): string => 'mock_' + Buffer.from(JSON.stringify(u), 'utf-8').toString('base64');

function fakeIdToken(u: MockUser): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: u.uid,
    uid: u.uid,
    email: u.email,
    iss: 'https://securetoken.google.com/enlite-prd',
    aud: 'enlite-prd',
    iat: now,
    exp: now + 3600,
  };
  return 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' + Buffer.from(JSON.stringify(payload)).toString('base64url') + '.';
}

/** Login HUMANO (click + keyboard.type, `e2e-humano-nao-e-fill`) — Identity Toolkit interceptado (é o padrão de auth do projeto), API real por trás do token `mock_*`. */
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
  await page.waitForTimeout(1_200); // 2º redirect da tela de login (mesma pegadinha do admin-access-cells-visual)
}

/**
 * O atom `Checkbox` é `sr-only` (a caixa visível é o `<div>` irmão dentro do `<label>`) — sem `id`
 * nesta tela, o `<label>` não tem `for`, então não dá pra mirar por `label[for=...]` (molde do
 * `admin-access-cells-visual`). O que um humano clica de verdade é a ÁREA do `<label>` — subir até
 * o ancestral e clicar nele, nunca `force: true` no input escondido.
 */
async function clickCheckbox(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).locator('xpath=ancestor::label[1]').click();
}

/** Abre a tela pelo MENU (não por goto direto) — prova que o item existe e que a rota está atrás do gate. */
async function abrirPeloMenu(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Horas Ana Care' }).click();
  await expect(page).toHaveURL(/\/admin\/anacare\/horas$/);
  await expect(page.getByRole('heading', { name: 'Horas Ana Care' })).toBeVisible({ timeout: 15_000 });
}

test.describe('Conferência de horas do Ana Care — E2E real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(() => {
    // Limpa validações remanescentes dos turnos que este arquivo toca (rodada anterior pode ter
    // deixado sujeira se um teste quebrou no meio) — ANTES de semear, não durante.
    safeSql(`DELETE FROM shift_hours_validation WHERE source = 'anacare' AND source_shift_id IN ('${SHIFT_IDS_TOCADOS.join("','")}')`);

    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${COMPLETO_UID}', '${COMPLETO_EMAIL}', 'E2E Completa AnaCare', 'admin', true, 'ACTIVE', '${TENANT}')`);
    psql(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, status, tenant_id)
          VALUES ('${LEITURA_UID}', '${LEITURA_EMAIL}', 'E2E Leitora AnaCare', 'admin', true, 'ACTIVE', '${TENANT}')`);

    const grupoCompletoId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_COMPLETO}', 'e2e anacare-horas — nao mexer manual') RETURNING id`);
    psql(`INSERT INTO iam.group_permissions (group_id, permission_id)
          SELECT '${grupoCompletoId}', id FROM iam.permissions WHERE resource='anacare_hours' AND action IN ('read','validate')`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${grupoCompletoId}', 'AR', '${COMPLETO_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${COMPLETO_UID}', '${grupoCompletoId}', '${TENANT}')`);

    const grupoLeituraId = scalar(`INSERT INTO iam.permission_groups (tenant_id, name, description)
          VALUES ('${TENANT}', '${GRUPO_LEITURA}', 'e2e anacare-horas — nao mexer manual') RETURNING id`);
    psql(`INSERT INTO iam.group_permissions (group_id, permission_id)
          SELECT '${grupoLeituraId}', id FROM iam.permissions WHERE resource='anacare_hours' AND action = 'read'`);
    psql(`INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason) VALUES ('${grupoLeituraId}', 'AR', '${COMPLETO_UID}', 'e2e setup')`);
    psql(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ('${LEITURA_UID}', '${grupoLeituraId}', '${TENANT}')`);
  });

  test.afterAll(() => {
    safeSql(`DELETE FROM shift_hours_validation WHERE source = 'anacare' AND source_shift_id IN ('${SHIFT_IDS_TOCADOS.join("','")}')`);
    const uids = [COMPLETO_UID, LEITURA_UID];
    safeSql(`DELETE FROM iam.permission_audit_log WHERE user_id IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.user_groups WHERE user_id IN ('${uids.join("','")}')`);
    safeSql(`DELETE FROM iam.group_country_scopes WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'ACH E2E%${RUN_ID}')`);
    safeSql(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name LIKE 'ACH E2E%${RUN_ID}')`);
    safeSql(`DELETE FROM iam.permission_groups WHERE name LIKE 'ACH E2E%${RUN_ID}'`);
    safeSql(`DELETE FROM users WHERE firebase_uid IN ('${uids.join("','")}')`);
  });

  test('FELIZ — entra pelo menu, abre o paciente, valida um turno e valida em lote; status persiste após reload', async ({ page }) => {
    await loginAs(page, COMPLETO);
    await abrirPeloMenu(page);

    // lista: paciente sem vínculo mostra "Sin vínculo · ID AC-PAT-6" (regra dura da spec)
    const linha = page.getByTestId('anacare-hours-patient-row-AC-PAT-6');
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await expect(linha).toContainText('Sin vínculo · ID AC-PAT-6');
    await print(page, 'lista.png');
    await linha.click();
    await expect(page).toHaveURL(/\/admin\/anacare\/horas\/AC-PAT-6$/);
    await expect(page.getByRole('heading', { name: 'Sin vínculo · ID AC-PAT-6' })).toBeVisible({ timeout: 15_000 });
    await print(page, 'detalhe.png');

    // Eixo por DIA (16/09, revisto 20/09): a semana visível ao abrir é a de HOJE quando o mês
    // exibido (MONTH) contém hoje; senão, a do dia 1º do mês (`AnaCareHoursDetailPage.tsx:110-111`)
    // — pode não ser a de NENHUM destes 4 turnos específicos. O navegador com estado sabe em qual
    // semana a UI está e calcula os cliques.
    const semana = criarNavegadorDeSemana(page);
    await semana.irPara(DATE_VALIDAR_INDIVIDUAL);

    // validar 1 turno
    const validarBtn = page.getByTestId(`anacare-hours-validate-shift-${SHIFT_VALIDAR_INDIVIDUAL}`);
    await expect(validarBtn).toBeVisible({ timeout: 15_000 });
    await validarBtn.click();
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_VALIDAR_INDIVIDUAL}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_VALIDAR_INDIVIDUAL}`)).toContainText('Validado por');
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_VALIDAR_INDIVIDUAL}`)).toContainText('E2E Completa AnaCare');

    // reload — volta pra semana PADRÃO; navega de novo até a do turno pra provar que persistiu.
    await page.reload();
    semana.resetarAposReloadOuMount();
    await semana.irPara(DATE_VALIDAR_INDIVIDUAL);
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_VALIDAR_INDIVIDUAL}`)).toContainText('Validado por', { timeout: 15_000 });
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_VALIDAR_INDIVIDUAL}`)).toHaveCount(0);

    // validar EM LOTE — seleciona 2 turnos que podem cair em semanas DIFERENTES (LOTE_A/LOTE_B).
    // A seleção é estado do PACIENTE, não da semana visível, então sobrevive à navegação (ver
    // `AnaCareHoursDetailPage` — `selectedShiftIds` não reseta ao trocar `weekStart`).
    await semana.irPara(DATE_LOTE_A);
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_A}`)).toBeVisible({ timeout: 15_000 });
    await clickCheckbox(page, `anacare-hours-select-shift-${SHIFT_LOTE_A}`);
    await semana.irPara(DATE_LOTE_B);
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_B}`)).toBeVisible({ timeout: 15_000 });
    await clickCheckbox(page, `anacare-hours-select-shift-${SHIFT_LOTE_B}`);
    await expect(page.getByTestId('anacare-hours-selection-bar')).toBeVisible();
    await expect(page.getByTestId('anacare-hours-selection-bar')).toContainText('2');
    await page.getByTestId('anacare-hours-selection-validate').click();
    await expect(page.getByTestId('anacare-hours-batch-modal-confirm')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('anacare-hours-batch-modal-confirm').click();
    await expect(page.getByTestId('anacare-hours-selection-bar')).toHaveCount(0, { timeout: 15_000 });
    // ainda na semana do LOTE_B (não navegou de volta)
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_B}`)).toContainText('Validado por');

    // reload — o lote também persiste, nas DUAS semanas.
    await page.reload();
    semana.resetarAposReloadOuMount();
    await semana.irPara(DATE_LOTE_A);
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_A}`)).toContainText('Validado por', { timeout: 15_000 });
    await semana.irPara(DATE_LOTE_B);
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_B}`)).toContainText('Validado por', { timeout: 15_000 });
  });

  // Tarefa 2 (16/09) — ALT3: navegar de semana troca os turnos exibidos SEM disparar fetch novo;
  // só "Actualizar" refaz a busca. Conta requests reais à rota do mês (nunca mock de rede — regra
  // do arquivo), não é suposição sobre o código.
  test('ALT3 — navegação de semana não busca de novo; "Actualizar" refaz a MESMA chamada', async ({ page }) => {
    await loginAs(page, COMPLETO);

    let patientMonthRequests = 0;
    const patientMonthUrlRe = new RegExp(`/api/admin/anacare-hours/months/${MONTH}/patients/AC-PAT-6($|\\?)`);
    page.on('request', (req) => {
      if (patientMonthUrlRe.test(req.url())) patientMonthRequests += 1;
    });

    await page.goto(`/admin/anacare/horas/AC-PAT-6`);
    await expect(page.getByRole('heading', { name: 'Sin vínculo · ID AC-PAT-6' })).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => patientMonthRequests, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    const afterMount = patientMonthRequests;

    // navega até a semana do turno "sin check-in" — pode ser bem mais adiante no mês — sem
    // disparar fetch.
    await criarNavegadorDeSemana(page).irPara(DATE_SIN_CHECKIN);
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_SIN_CHECKIN}`)).toBeVisible({ timeout: 15_000 });
    expect(patientMonthRequests).toBe(afterMount);

    // "Actualizar" refaz exatamente 1 chamada a mais.
    await page.getByTestId('anacare-hours-refresh').click();
    await expect.poll(() => patientMonthRequests, { timeout: 15_000 }).toBe(afterMount + 1);
  });

  test('ALT1 — contestar exige motivo de lista fechada; nota opcional digitada; status contestado persiste após reload', async ({ page }) => {
    await loginAs(page, COMPLETO);
    await page.goto(`/admin/anacare/horas/AC-PAT-6`);
    await expect(page.getByRole('heading', { name: 'Sin vínculo · ID AC-PAT-6' })).toBeVisible({ timeout: 15_000 });
    const semana = criarNavegadorDeSemana(page);
    await semana.irPara(DATE_CONTESTAR);

    const contestarBtn = page.getByTestId(`anacare-hours-contest-shift-${SHIFT_CONTESTAR}`);
    await expect(contestarBtn).toBeVisible({ timeout: 15_000 });
    await contestarBtn.click();

    const modal = page.getByTestId('anacare-hours-contest-modal');
    await expect(modal).toBeVisible();

    // motivos de lista fechada visíveis
    const reasonSelect = page.getByTestId('anacare-hours-contest-reason');
    await expect(reasonSelect).toBeVisible();
    const opcoes = await reasonSelect.locator('option').allTextContents();
    // 1ª option é o placeholder ("Seleccione un motivo…") — as 4 de verdade são as demais.
    expect(opcoes.slice(1)).toEqual(['No asistió', 'Horario distinto al registrado', 'Horas mal cargadas', 'Otro']);
    await print(page, 'modal-contestar-motivos.png');

    // confirmar sem motivo é recusado (botão desabilitado)
    await expect(page.getByTestId('anacare-hours-contest-confirm')).toBeDisabled();

    await reasonSelect.selectOption('horario_distinto');
    const notaInput = page.getByTestId('anacare-hours-contest-note');
    await notaInput.click();
    await page.keyboard.type('Horario cargado a mano, no coincide con lo real');
    await expect(notaInput).toHaveValue('Horario cargado a mano, no coincide con lo real');

    await expect(page.getByTestId('anacare-hours-contest-confirm')).toBeEnabled();
    await page.getByTestId('anacare-hours-contest-confirm').click();
    await expect(modal).toHaveCount(0, { timeout: 15_000 });

    const linhaContestada = page.getByTestId(`anacare-hours-shift-row-${SHIFT_CONTESTAR}`);
    await expect(linhaContestada).toContainText('Contestado');
    // contestado GANHA "Validar" de novo (pode ser validado depois) — mas "Contestar" some
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_CONTESTAR}`)).toBeVisible();
    await expect(page.getByTestId(`anacare-hours-contest-shift-${SHIFT_CONTESTAR}`)).toHaveCount(0);

    await page.reload();
    // reload volta pra semana PADRÃO — navega de novo até a semana do turno contestado.
    semana.resetarAposReloadOuMount();
    await semana.irPara(DATE_CONTESTAR);
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_CONTESTAR}`)).toContainText('Contestado', { timeout: 15_000 });
    // o motivo/nota vivem numa LINHA IRMÃ (sem testid próprio, `DayGroup.tsx` renderiza um
    // segundo <TableRow> logo abaixo quando `status==='contestado'`) — o motivo é sempre visível;
    // a nota só aparece com `patient_clinical:read`, célula que o usuário COMPLETO deste e2e NÃO
    // tem (só anacare_hours:read/validate) — "Nota restringida" é o comportamento CORRETO (D344).
    await expect(page.getByText('Horario distinto al registrado')).toBeVisible();
    await expect(page.getByText('Nota restringida')).toBeVisible();
  });

  test('ALT2a — turno sin check-in soma 0h e mostra a origem + "Programado, sin actuación"', async ({ page }) => {
    await loginAs(page, COMPLETO);
    await page.goto(`/admin/anacare/horas/AC-PAT-6`);
    await expect(page.getByRole('heading', { name: 'Sin vínculo · ID AC-PAT-6' })).toBeVisible({ timeout: 15_000 });
    await criarNavegadorDeSemana(page).irPara(DATE_SIN_CHECKIN);

    const linhaSemCheckin = page.getByTestId(`anacare-hours-shift-row-${SHIFT_SIN_CHECKIN}`);
    await expect(linhaSemCheckin).toBeVisible({ timeout: 15_000 });
    // a CÉLULA da linha mostra "—" (Check-in, Check-out E Horas — `DayGroup.tsx` `showDash`),
    // NUNCA "0.0 h" — quem soma 0h é o TOTAL exibido no resumo/cabeçalho do dia
    // (`totalHours`/`shiftHours`, `selectors.ts`, `sinCheckinHoursMode='zero'`), não a célula.
    await expect(linhaSemCheckin).not.toContainText('0.0 h');
    await expect(linhaSemCheckin).toContainText('Sin check-in');
    await expect(linhaSemCheckin).toContainText('Programado, sin actuación');
    // continua VALIDÁVEL (pendiente) — a spec real não bloqueia validação de turno sem check-in,
    // só soma 0h; ver `DayGroup.tsx` `ShiftRow` (status pendiente/contestado, sem exceção de
    // origem). O bloqueio "curto" de verdade é o da célula ausente, provado no teste ALT2b.
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_SIN_CHECKIN}`)).toBeVisible();
  });

  test('ALT2b — usuário só com anacare_hours:read NÃO consegue validar nem contestar (célula ausente, motivo curto visível)', async ({ page }) => {
    await loginAs(page, LEITURA);
    await abrirPeloMenu(page);

    const linha = page.getByTestId('anacare-hours-patient-row-AC-PAT-6');
    await expect(linha).toBeVisible({ timeout: 15_000 });
    await linha.click();
    await expect(page).toHaveURL(/\/admin\/anacare\/horas\/AC-PAT-6$/);
    await expect(page.getByRole('heading', { name: 'Sin vínculo · ID AC-PAT-6' })).toBeVisible({ timeout: 15_000 });
    await criarNavegadorDeSemana(page).irPara(DATE_SIN_CHECKIN);

    // sem a célula validate: os checkboxes EXISTEM (a seleção em si não depende da célula — quem
    // trava é a AÇÃO), mas vêm todos DESABILITADOS — provado pelo primeiro (turno sin_checkin,
    // pendiente, portanto selecionável em tese).
    // o input real é `sr-only` (a caixa visível é o <div> ao lado, ver atom Checkbox) — não dá
    // pra checar visibilidade dele, só o atributo.
    const primeiroCheckbox = page.getByTestId(`anacare-hours-select-shift-${SHIFT_SIN_CHECKIN}`);
    await expect(primeiroCheckbox).toBeAttached({ timeout: 15_000 });
    await expect(primeiroCheckbox).toBeDisabled();
    const botaoValidar = page.getByTestId(`anacare-hours-validate-shift-${SHIFT_SIN_CHECKIN}`);
    await expect(botaoValidar).toBeVisible({ timeout: 15_000 });
    await expect(botaoValidar).toBeDisabled();
    // testid agora é por DIA (eixo do detalhe, 16/09), não mais por prestador (`AC-NURSE-6-0`).
    const disableReason = page.getByTestId(`anacare-hours-disable-reason-day-${DATE_SIN_CHECKIN}`).first();
    await expect(disableReason).toContainText('Validación bloqueada');
    await expect(disableReason).toContainText('No tiene permiso para validar o contestar turnos');
    await print(page, 'turno-bloqueado-texto-curto.png');
    await print(page, 'usuario-solo-lectura.png');

    // clicar mesmo assim (via JS não é humano; aqui só provamos que NÃO HÁ como clicar: o
    // atributo disabled do <button> impede o evento chegar ao handler)
    await expect(botaoValidar).toHaveAttribute('disabled', '');
  });
});
