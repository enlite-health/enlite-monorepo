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
 * corrida). Turnos usados (mês 2026-09, conferidos por curl antes de escrever este arquivo):
 *   FAKE-2026-09-6-0-0  sin_checkin (sem check-in — 0h, "Programado, sin actuación")
 *   FAKE-2026-09-6-0-1  web_admin   (usado no ALT1 — contestar)
 *   FAKE-2026-09-6-0-2  app         (usado no FELIZ — validar individual)
 *   FAKE-2026-09-6-0-3  app         (usado no FELIZ — validar em LOTE, junto com o -4)
 *   FAKE-2026-09-6-0-4  web_admin   (usado no FELIZ — validar em LOTE)
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

// D344/protótipo: `AnaCareHoursListContainer`/`AnaCareHoursPage` nascem no mês '2026-08'
// (`initialMonth`) — usar os turnos DESSE mês evita ter que mexer no seletor de mês pra provar o
// fluxo padrão. Conferido por curl antes de escrever este arquivo (mesma forma de '2026-09', só
// muda o prefixo do id — `FakeAnaCareShiftsSource.generateMonth` é determinístico por mês).
const SHIFT_SIN_CHECKIN = 'FAKE-2026-08-6-0-0';
const SHIFT_CONTESTAR = 'FAKE-2026-08-6-0-1';
const SHIFT_VALIDAR_INDIVIDUAL = 'FAKE-2026-08-6-0-2';
const SHIFT_LOTE_A = 'FAKE-2026-08-6-0-3';
const SHIFT_LOTE_B = 'FAKE-2026-08-6-0-4';
const SHIFT_IDS_TOCADOS = [SHIFT_SIN_CHECKIN, SHIFT_CONTESTAR, SHIFT_VALIDAR_INDIVIDUAL, SHIFT_LOTE_A, SHIFT_LOTE_B];

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

    // validar 1 turno
    const validarBtn = page.getByTestId(`anacare-hours-validate-shift-${SHIFT_VALIDAR_INDIVIDUAL}`);
    await expect(validarBtn).toBeVisible({ timeout: 15_000 });
    await validarBtn.click();
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_VALIDAR_INDIVIDUAL}`)).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_VALIDAR_INDIVIDUAL}`)).toContainText('Validado por');
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_VALIDAR_INDIVIDUAL}`)).toContainText('E2E Completa AnaCare');

    // reload — persiste
    await page.reload();
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_VALIDAR_INDIVIDUAL}`)).toContainText('Validado por', { timeout: 15_000 });
    await expect(page.getByTestId(`anacare-hours-validate-shift-${SHIFT_VALIDAR_INDIVIDUAL}`)).toHaveCount(0);

    // validar EM LOTE — seleciona 2 turnos, confirma no modal
    await clickCheckbox(page, `anacare-hours-select-shift-${SHIFT_LOTE_A}`);
    await clickCheckbox(page, `anacare-hours-select-shift-${SHIFT_LOTE_B}`);
    await expect(page.getByTestId('anacare-hours-selection-bar')).toBeVisible();
    await expect(page.getByTestId('anacare-hours-selection-bar')).toContainText('2');
    await page.getByTestId('anacare-hours-selection-validate').click();
    await expect(page.getByTestId('anacare-hours-batch-modal-confirm')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('anacare-hours-batch-modal-confirm').click();
    await expect(page.getByTestId('anacare-hours-selection-bar')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_A}`)).toContainText('Validado por');
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_B}`)).toContainText('Validado por');

    // reload — o lote também persiste
    await page.reload();
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_A}`)).toContainText('Validado por', { timeout: 15_000 });
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_LOTE_B}`)).toContainText('Validado por');
  });

  test('ALT1 — contestar exige motivo de lista fechada; nota opcional digitada; status contestado persiste após reload', async ({ page }) => {
    await loginAs(page, COMPLETO);
    await page.goto(`/admin/anacare/horas/AC-PAT-6`);
    await expect(page.getByRole('heading', { name: 'Sin vínculo · ID AC-PAT-6' })).toBeVisible({ timeout: 15_000 });

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
    await expect(page.getByTestId(`anacare-hours-shift-row-${SHIFT_CONTESTAR}`)).toContainText('Contestado', { timeout: 15_000 });
    // o motivo/nota vivem numa LINHA IRMÃ (sem testid próprio, `ProviderGroup.tsx` renderiza um
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

    const linhaSemCheckin = page.getByTestId(`anacare-hours-shift-row-${SHIFT_SIN_CHECKIN}`);
    await expect(linhaSemCheckin).toBeVisible();
    // a CÉLULA da linha mostra "—" (Real E Horas, sem "real" pra medir — `ProviderGroup.tsx`
    // `showDash`), NUNCA "0.0 h" — quem soma 0h é o TOTAL exibido no resumo/lista
    // (`totalHours`/`shiftHours`, `selectors.ts`, `sinCheckinHoursMode='zero'`), não a célula.
    await expect(linhaSemCheckin).not.toContainText('0.0 h');
    await expect(linhaSemCheckin).toContainText('Sin check-in');
    await expect(linhaSemCheckin).toContainText('Programado, sin actuación');
    // continua VALIDÁVEL (pendiente) — a spec real não bloqueia validação de turno sem check-in,
    // só soma 0h; ver ProviderGroup.tsx `canValidate` (status pendiente/contestado, sem exceção
    // de origem). O bloqueio "curto" de verdade é o da célula ausente, provado no teste ALT2b.
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
    await expect(page.getByTestId(`anacare-hours-disable-reason-AC-NURSE-6-0`).first()).toContainText('Validación bloqueada');
    await expect(page.getByTestId(`anacare-hours-disable-reason-AC-NURSE-6-0`).first()).toContainText('No tiene permiso para validar o contestar turnos');
    await print(page, 'turno-bloqueado-texto-curto.png');
    await print(page, 'usuario-solo-lectura.png');

    // clicar mesmo assim (via JS não é humano; aqui só provamos que NÃO HÁ como clicar: o
    // atributo disabled do <button> impede o evento chegar ao handler)
    await expect(botaoValidar).toHaveAttribute('disabled', '');
  });
});
