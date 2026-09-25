/**
 * admission-d-ux.integration.e2e.ts @integration — spec 014, bloco D ("o fluxo se entende sem
 * documentação").
 *
 * Front real (Vite 5173) + API real (docker enlite-api, rebuildada desta worktree) + Postgres
 * real (migrations até 298) + Firebase Emulator (auth real). Zero mock de dado. Só dado
 * sintético. Molde: admission-c-servico-contratado.integration.e2e.ts.
 *
 * Cobre: US-D1 (checklist de completude + "Listo para activar"), US-D2 (fantasmas ausentes),
 * US-D3 (rótulos es + aviso de telefone coincidente), US-D4 (drawer não perde trabalho —
 * confirmação ao fechar com mudança pendente), US-D5 (criar→ficha, kanban com dica, "Ver en
 * Kanban"), US-D6 (Nueva Vacante — seções, banner de validação por NOME de campo).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHmac } from 'crypto';
import {
  seedIncompletePatient, seedPhoneMatchPatient, readPatientPhone, readResponsiblePhone,
  cleanupPatientDeep, runSQL,
} from '../helpers/patient-detail-d-helper';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from '../helpers/db-test-helper';

// `E2E_FIREBASE_EMULATOR` aponta para o emulador de um stack isolado (`docker compose -p`); default inalterado.
const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.blocod.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

async function loginAsRealStaff(page: Page): Promise<void> {
  const signUp = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  const auth = signUp.ok ? signUp : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(auth.ok).toBe(true);
  const { localId } = (await auth.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Bloco D', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'es');
    // Molde bloco C: o banner do emulador intercepta clique — some assim que aparece.
    const strip = () => document.querySelectorAll('.firebase-emulator-warning').forEach((el) => el.remove());
    strip();
    new MutationObserver(strip).observe(document.documentElement, { childList: true, subtree: true });
  });
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await forceClick(page.getByRole('button', { name: /Iniciar sesi/i }));
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

async function forceClick(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((el: HTMLElement) => el.click());
}

async function forceFill(locator: Locator, value: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.fill(value);
}

async function openDetail(page: Page, patientId: string): Promise<void> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = page
      .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    await page.goto(`/admin/patients/${patientId}`);
    const res = await detail;
    if (res) return;
  }
  throw new Error(`GET /api/admin/patients/${patientId} não observado em 2 tentativas`);
}

/** name_trgm_bidx como o backend grava — replicado do bloco C para o caso-select achar o paciente. */
function nameTrgmBidxSql(first: string, last: string): string {
  const key = Buffer.alloc(32, 0x42);
  const normalized = `${first} ${last}`.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const padded = ` ${normalized} `;
  const hex = new Set<string>();
  for (let i = 0; i <= padded.length - 3; i++) {
    hex.add(createHmac('sha256', key).update(padded.slice(i, i + 3), 'utf8').digest().subarray(0, 8).toString('hex'));
  }
  return `ARRAY[${[...hex].sort((a, b) => a.localeCompare(b)).map((h) => `decode('${h}','hex')`).join(',')}]::bytea[]`;
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Spec 014 bloco D — o fluxo se entende sem documentação @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let incomplete: { patientId: string; stamp: string };
  let phoneMatch: { patientId: string; stamp: string; responsibleName: string; phone: string };
  let vacancyPatientId: string;
  let vacancyCaseNumber: number;
  let vacancyId: string;

  test.beforeAll(() => {
    incomplete = seedIncompletePatient();
    phoneMatch = seedPhoneMatchPatient();
    vacancyCaseNumber = 950000 + Math.floor(Math.random() * 9000);
    const patient = insertTestPatient({
      firstName: 'BlocoD', lastName: `Vacante${Date.now()}`, status: 'ADMISSION', withAddress: true,
    });
    vacancyPatientId = patient.patientId;
    runSQL(`UPDATE patients SET case_number = ${vacancyCaseNumber} WHERE id = '${vacancyPatientId}'`);
    vacancyId = insertBaseVacancy({ patientId: vacancyPatientId, patientAddressId: patient.addressId ?? '', caseNumber: vacancyCaseNumber });
  });

  test.afterAll(() => {
    cleanupPatientDeep(incomplete.patientId);
    cleanupPatientDeep(phoneMatch.patientId);
    runSQL(`DELETE FROM job_postings WHERE id = '${vacancyId}'`);
    cleanupTestPatient(vacancyPatientId);
  });

  test('1. paciente incompleto → checklist lista as faltas com link que abre o drawer certo; fantasmas ausentes; rótulos es', async ({ page }) => {
    await loginAsRealStaff(page);
    await openDetail(page, incomplete.patientId);

    // ── US-D1/D255 (QA-caça rodada 1, item conserto 2): o checklist agora separa BLOQUEIO
    // (só ADDRESS, D255) de PENDÊNCIA (os outros 3 — não bloqueiam o activate). "Para activar
    // falta:" NUNCA lista Cobertura/Servicio/Consentimiento — só Domicilio.
    const checklist = page.getByTestId('completeness-checklist');
    await expect(checklist).toBeVisible();
    await expect(checklist).toContainText('Para activar falta:');
    const blocking = page.getByTestId('completeness-item');
    await expect(blocking).toHaveCount(1);
    await expect(blocking).toContainText('Domicilio');
    await expect(checklist).toContainText('Pendiente para la admisión completa:');
    const pending = page.getByTestId('completeness-pending-item');
    await expect(pending).toHaveCount(3);
    await expect(checklist).toContainText('Domicilio');
    await expect(checklist).toContainText('Cobertura');
    await expect(checklist).toContainText('Servicio contratado');
    await expect(checklist).toContainText('Consentimiento');

    // Clicar em "Domicilio" muda para a aba certa e abre o drawer de criação de endereço.
    await forceClick(page.getByText('Domicilio', { exact: true }));
    await expect(page.getByTestId('patient-address-drawer')).toBeVisible({ timeout: 10_000 });
    await forceClick(page.getByLabel('Cerrar'));
    await expect(page.getByTestId('patient-address-drawer')).not.toBeVisible();

    // ── US-D2: fantasmas ausentes (rótulos, botões disabled, buscas readOnly) ──
    await expect(page.getByText('Género', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Orientación Sexual')).toHaveCount(0);
    await expect(page.getByText('Origen racial')).toHaveCount(0);
    await expect(page.getByText('Religión', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Desligamiento', { exact: false })).toHaveCount(0);
    await expect(page.getByPlaceholder('Buscar...')).toHaveCount(0);
    await expect(page.locator('button:disabled')).toHaveCount(0);
    // Cards que eram fantasma agora são "título + Próximamente" — sem tabela nem botão.
    await forceClick(page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Datos Clínicos' }));
    await expect(page.getByTestId('projeto-terapeutico-card')).toContainText('Próximamente');

    // ── US-D3: "WhatsApp del paciente" (nunca "Teléfono del Responsable" para o dado do paciente) ──
    await expect(page.getByText('WhatsApp del paciente', { exact: false })).toBeVisible();

    await expect(page).toHaveScreenshot('admission-d-ficha-incompleta.png', { fullPage: true, maxDiffPixelRatio: 0.08 });
  });

  test('2. completar tudo → checklist mostra "Admisión completa" (D255: ready:true supera "Listo para activar")', async ({ page }) => {
    // Completa direto no banco (o objetivo aqui é o CHECKLIST, não re-testar os drawers de A/B/C).
    runSQL(`UPDATE patients SET has_consent = true, insurance_informed = 'OSDE' WHERE id = '${incomplete.patientId}'`);
    runSQL(`
      INSERT INTO patient_addresses (patient_id, address_formatted, address_raw, display_order, source, created_at, updated_at)
      VALUES ('${incomplete.patientId}', 'Av. Corrientes 1234, CABA, AR', 'Av. Corrientes 1234, CABA', 1, 'manual', NOW(), NOW())
    `);
    const svcId = runSQL(`
      WITH ins AS (
        INSERT INTO patient_contracted_services (patient_id, service_code, active, country, created_by, updated_by)
        VALUES ('${incomplete.patientId}', 'AT', true, 'AR',
          (SELECT firebase_uid FROM users WHERE email = '${STAFF_EMAIL}'),
          (SELECT firebase_uid FROM users WHERE email = '${STAFF_EMAIL}'))
        RETURNING id
      ) SELECT id FROM ins
    `);
    expect(svcId).toBeTruthy();

    await loginAsRealStaff(page);
    await openDetail(page, incomplete.patientId);
    await expect(page.getByTestId('completeness-checklist-ready')).toBeVisible({ timeout: 15_000 });
    // D255 (QA-caça rodada 1, item 2): ready:true (missing:[]) mostra "Admisión completa" —
    // "Listo para activar" é o estado intermediário (canActivate mas ready:false), não este.
    await expect(page.getByTestId('completeness-checklist-ready')).toContainText('Admisión completa');
    await expect(page.getByTestId('completeness-checklist')).toHaveCount(0);
  });

  test('3. aviso de telefone coincidente com o responsável — "Mantener" não altera nada', async ({ page }) => {
    await loginAsRealStaff(page);
    await openDetail(page, phoneMatch.patientId);

    const warning = page.getByTestId('phone-match-warning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText(phoneMatch.responsibleName);
    await expect(page.getByTestId('move-phone-to-responsible-btn')).toBeVisible();

    const beforePatientPhone = readPatientPhone(phoneMatch.patientId);
    const beforeResponsiblePhone = readResponsiblePhone(phoneMatch.patientId);

    await forceClick(page.getByTestId('keep-phone-btn'));
    await expect(warning).toHaveCount(0);

    // "Mantener" é local — nenhum dado grava. Confere no banco, não só na tela.
    expect(readPatientPhone(phoneMatch.patientId)).toBe(beforePatientPhone);
    expect(readResponsiblePhone(phoneMatch.patientId)).toBe(beforeResponsiblePhone);
  });

  test('4. criar paciente → cai na ficha (não fica na lista)', async ({ page }) => {
    await loginAsRealStaff(page);
    await page.goto('/admin/patients');
    await expect(page.getByTestId('new-patient-btn')).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveScreenshot('admission-d-lista.png', { maxDiffPixelRatio: 0.08 });

    await forceClick(page.getByTestId('new-patient-btn'));
    await expect(page.getByTestId('patient-create-modal')).toBeVisible();
    const firstName = `BlocoDCriado${Date.now().toString().slice(-6)}`;
    await forceFill(page.getByTestId('pc-firstName'), firstName);
    await forceFill(page.getByTestId('pc-phone'), '+5491100009999');

    const create = page.waitForResponse((r) => r.request().method() === 'POST' && /\/api\/admin\/patients$/.test(r.url()));
    await forceClick(page.getByTestId('pc-save'));
    const body = (await (await create).json()) as { data: { id: string } };
    const newId = body.data.id;

    await expect(page).toHaveURL(new RegExp(`/admin/patients/${newId}$`), { timeout: 15_000 });
    await expect(page.getByText(firstName)).toBeVisible({ timeout: 10_000 });
    cleanupPatientDeep(newId);
  });

  test('5. kanban — dica de arraste visível; ficha ganha botão "Ver en Kanban"', async ({ page }) => {
    await loginAsRealStaff(page);
    await page.goto('/admin/patients/kanban');
    await expect(page.getByTestId('kanban-drag-hint')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('kanban-drag-hint')).toContainText('Arrastrá');
    await expect(page).toHaveScreenshot('admission-d-kanban.png', { maxDiffPixelRatio: 0.08 });

    await openDetail(page, phoneMatch.patientId);
    await forceClick(page.getByTestId('view-in-kanban-btn'));
    await expect(page).toHaveURL(/\/admin\/patients\/kanban$/, { timeout: 15_000 });
  });

  // 6a (modo CRIAR do wizard, seções agrupando os 22 campos) saiu — D425 item 4, "Nueva" fora
  // temporariamente, /admin/vacancies/new não é mais alcançável. O que sobra do teste 6
  // original é o banner D6.1 em modo EDIÇÃO, abaixo — nunca dependeu de /new.
  test('6b. banner de validação lista os campos por NOMBRE (lex D6.1) — modo EDIÇÃO, não depende de "Nueva"', async ({ page }) => {
    await loginAsRealStaff(page);

    // El botón "Continuar" queda DESHABILITADO en modo CREAR hasta que el formulario esté
    // completo (gate reactivo por `isComplete` — `CreateVacancyPage.tsx`), así que "enviar
    // vacío" no se puede clickear ahí. En modo EDICIÓN el botón queda SIEMPRE habilitado
    // ("dejá que el RHF valide en el submit y el banner lo muestre" — comentario del propio
    // archivo) — es el camino real y alcanzable para probar el banner. La vaga sembrada en
    // `beforeAll` (`insertBaseVacancy`, sin schedule ni meet link) llega INCOMPLETA de
    // fábrica: ni toco nada, sólo abro y envío.
    // Sincroniza pela RESPOSTA do GET da vaga (modo edição carrega assíncrono): sob carga, o
    // clique chegava antes de o formulário hidratar e o submit se perdia — verde sozinho,
    // vermelho na regressão de 4 arquivos (medido 03/09). Mesma regra da ativação no bloco C.
    const vacancyLoaded = page.waitForResponse(
      (r) => r.request().method() === 'GET' && new RegExp(`/api/admin/vacancies/${vacancyId}(\\?|$)`).test(r.url()),
      { timeout: 20_000 },
    );
    await page.goto(`/admin/vacancies/${vacancyId}/edit`);
    expect((await vacancyLoaded).ok()).toBe(true);
    await expect(page.getByTestId('create-vacancy-save-btn')).toBeEnabled({ timeout: 15_000 });

    const banner = page.getByTestId('vacancy-form-validation-error');
    // O submit é do RHF: se o clique cair num re-render, repete (no máximo 3×) até o banner aparecer.
    for (let attempt = 0; attempt < 3 && !(await banner.isVisible()); attempt++) {
      await forceClick(page.getByTestId('create-vacancy-save-btn'));
      await banner.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
    }
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('Faltan datos para crear la vacante');
    // Nombres de campo — nunca valores (lex D6.1): la vaga sembrada no tiene horario ni
    // link de Meet, então esos dos faltam de verdade.
    await expect(banner).toContainText('Horario');
    await expect(banner).toContainText('Links de Google Meet');
  });

  // ── US-D4 (lex D4 AUTORIZADO): drawer não perde trabalho ──────────────────────────────────
  test('7. drawer com mudança pendente pede confirmação ao fechar; sem mudança fecha direto', async ({ page }) => {
    await loginAsRealStaff(page);
    await openDetail(page, phoneMatch.patientId);

    // Sem edição: Esc fecha direto, sem perguntar.
    await forceClick(page.getByTestId('edit-general-btn'));
    await expect(page.getByTestId('patient-general-edit-drawer')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('discard-changes-confirm')).toHaveCount(0);
    await expect(page.getByTestId('patient-general-edit-drawer')).not.toBeVisible({ timeout: 5_000 });

    // Com edição: Esc abre a confirmação; "Seguir editando" mantém o drawer aberto e o valor.
    await forceClick(page.getByTestId('edit-general-btn'));
    await expect(page.getByTestId('patient-general-edit-drawer')).toBeVisible({ timeout: 10_000 });
    await forceFill(page.getByTestId('pge-lastName'), 'ApellidoEditadoD4');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('discard-changes-confirm')).toBeVisible({ timeout: 5_000 });
    await forceClick(page.getByTestId('discard-changes-keep-editing'));
    await expect(page.getByTestId('discard-changes-confirm')).toHaveCount(0);
    await expect(page.getByTestId('patient-general-edit-drawer')).toBeVisible();
    await expect(page.getByTestId('pge-lastName')).toHaveValue('ApellidoEditadoD4');

    // "Descartar cambios" fecha de verdade, sem salvar.
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('discard-changes-confirm')).toBeVisible({ timeout: 5_000 });
    await forceClick(page.getByTestId('discard-changes-discard'));
    await expect(page.getByTestId('patient-general-edit-drawer')).not.toBeVisible({ timeout: 5_000 });
  });
});
