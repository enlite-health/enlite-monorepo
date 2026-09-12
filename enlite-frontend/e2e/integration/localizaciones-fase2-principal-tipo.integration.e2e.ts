/**
 * localizaciones-fase2-principal-tipo.integration.e2e.ts @integration — card "Localizaciones",
 * spec 019 (D310 item c): endereço PRINCIPAL própria (`is_default`) + TIPO por parentesco
 * (`address_type` reaproveitada) — tasks 5.7/5.8.
 *
 * Front real (Vite) + API real (docker `019e2e-api`) + Postgres real. Auth REAL pelo emulador do
 * Firebase (mesmo molde de `localizaciones-fase1.integration.e2e.ts`). Zero mock de dado.
 *
 * Régua "e2e humano" (nunca fill()): cada gesto é click() + keyboard.type() ou selectOption()
 * REAL (nativo do <select>, não `evaluate`) — a asserção lê o valor que FICOU na tela.
 *
 * 5.7 — cria endereço (nasce principal, sem checkbox); marca um segundo endereço como principal
 *       (troca visível na lista); edita o tipo do 1º para "Casa de la madre"; edita de novo para
 *       "Otro" com texto livre digitado tecla por tecla; aviso "Sin principal" quando nenhum é.
 * 5.8 — `toHaveScreenshot` do card com selo Principal + tipo + aviso "Sin principal".
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient } from '../helpers/db-test-helper';
import { cleanupPatientDeep, runSQL } from '../helpers/patient-detail-a-helper';
import { instalarFakeDeGestos, CABA_CORRIENTES } from '../helpers/google-places-fake-gestos';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.localizaciones2.${Date.now()}@enlite.health`;
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Localizaciones2', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

async function abrirTabServicioContratado(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click();
}

/** Escolhe `place` no autocomplete pelo GESTO real (seta + Enter) — nunca `fill()` no place inteiro. */
async function escolherPlace(page: Page, texto: string): Promise<void> {
  const campoEndereco = page.getByTestId('pad-address');
  await campoEndereco.click();
  await campoEndereco.pressSequentially(texto, { delay: 60 });
  await campoEndereco.press('ArrowDown');
  await campoEndereco.press('Enter');
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Card Localizaciones — Fase 2, PRINCIPAL + TIPO (spec 019) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  const pacientes: string[] = [];
  test.afterAll(() => {
    pacientes.forEach(cleanupPatientDeep);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('5.7 — cria (nasce principal), marca outro como principal, edita tipo → "Casa de la madre" → "Otro" (texto livre)', async ({ page }, testInfo) => {
    await instalarFakeDeGestos(page, CABA_CORRIENTES);
    await loginAsRealStaff(page);
    const { patientId } = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'LocFase2', lastName: `Humano${Date.now()}`, withAddress: false });
    pacientes.push(patientId);

    await abrirTabServicioContratado(page, patientId);
    const card = page.getByTestId('localizacoes-card');

    // ── 1) Criar o 1º endereço — nasce principal SEM marcar o checkbox (regra de nascimento). ──
    await page.getByTestId('new-address-btn').click();
    const drawer = page.getByTestId('patient-address-drawer');
    await expect(drawer).toBeVisible();
    await escolherPlace(page, 'Av. Corrientes 1234');
    await expect(page.getByTestId('pad-address')).toHaveValue(CABA_CORRIENTES.formatted_address, { timeout: 10_000 });
    const post1 = page.waitForResponse((r) => r.request().method() === 'POST' && /\/addresses$/.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await post1).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    await expect(card).toContainText('Principal', { timeout: 20_000 });

    // ── 2) Criar um 2º endereço (não nasce principal — já existe um). ──────────────────────────
    await page.getByTestId('new-address-btn').click();
    await expect(drawer).toBeVisible();
    await escolherPlace(page, 'Av. Corrientes 1234');
    await expect(page.getByTestId('pad-address')).toHaveValue(CABA_CORRIENTES.formatted_address, { timeout: 10_000 });
    const post2 = page.waitForResponse((r) => r.request().method() === 'POST' && /\/addresses$/.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await post2).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    let rows = runSQL(`SELECT id, is_default FROM patient_addresses WHERE patient_id = '${patientId}' AND archived_at IS NULL ORDER BY created_at ASC`);
    testInfo.annotations.push({ type: 'evidência', description: `após 2 criações: ${rows}` });

    // ── 3) Marcar o 2º endereço como principal — CLIQUE no link inline "Marcar como principal". ──
    const marcarLinks = card.getByTestId(/^address-mark-primary-/);
    await expect(marcarLinks).toHaveCount(1, { timeout: 10_000 }); // só o não-principal tem o link
    const patchPromise = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/addresses\//.test(r.url()));
    await marcarLinks.first().click();
    expect((await patchPromise).status()).toBe(200);
    await expect(card.getByTestId(/^address-primary-badge-/)).toHaveCount(1, { timeout: 10_000 });

    rows = runSQL(`SELECT id, is_default FROM patient_addresses WHERE patient_id = '${patientId}' AND archived_at IS NULL ORDER BY created_at ASC`);
    testInfo.annotations.push({ type: 'evidência', description: `após trocar o principal: ${rows}` });
    const linhas = rows.split('\n').filter((l) => l.trim());
    const principaisAtivos = linhas.filter((l) => l.endsWith('|t')).length;
    expect(principaisAtivos).toBe(1);

    // ── 4) Editar o TIPO do 1º endereço da lista (a lista ordena Principal primeiro — spec 019 —
    //      então é o que acabou de virar principal no passo 3) → "Casa de la madre". ──────────────
    const editButtons = card.locator('[data-testid^="edit-address-"]');
    await editButtons.first().click();
    await expect(drawer).toBeVisible();
    const tipoSelect = page.getByTestId('pad-type');
    await tipoSelect.click();
    await tipoSelect.selectOption('casa_madre');
    await expect(tipoSelect).toHaveValue('casa_madre');
    const patchTipo1 = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/addresses\//.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await patchTipo1).status()).toBe(200);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    await expect(card).toContainText('Casa de la madre', { timeout: 20_000 });

    // ── 5) Editar de novo → "Otro", com texto livre digitado TECLA POR TECLA (nunca fill). ──────
    await editButtons.first().click();
    await expect(drawer).toBeVisible();
    await tipoSelect.click();
    await tipoSelect.selectOption('otro');
    await expect(tipoSelect).toHaveValue('otro');
    const campoOtro = page.getByTestId('pad-type-other');
    await campoOtro.click();
    await expect(campoOtro).toBeFocused();
    await campoOtro.pressSequentially('Casa de una prima', { delay: 40 });
    await expect(campoOtro).toHaveValue('Casa de una prima');
    await expect(page.getByTestId('pad-type-other-counter')).toHaveText('17/40');
    const patchTipo2 = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/addresses\//.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await patchTipo2).status()).toBe(200);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });
    await expect(card).toContainText('Otro', { timeout: 20_000 });

    rows = runSQL(`SELECT address_type, address_type_other FROM patient_addresses WHERE patient_id = '${patientId}' AND archived_at IS NULL AND address_type = 'otro'`);
    testInfo.annotations.push({ type: 'evidência', description: `tipo final do endereço editado: ${rows}` });
    expect(rows).toContain('otro');
    expect(rows).toContain('Casa de una prima');

    await expect(card).toHaveScreenshot('localizaciones-fase2-principal-tipo.png', { maxDiffPixelRatio: 0.05 });
  });

  test('5.8 (aviso) — arquivar o único endereço principal via SQL e conferir "Sin principal"', async ({ page }, testInfo) => {
    await instalarFakeDeGestos(page, CABA_CORRIENTES);
    await loginAsRealStaff(page);
    const { patientId } = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'LocFase2', lastName: `Aviso${Date.now()}`, withAddress: false });
    pacientes.push(patientId);

    await abrirTabServicioContratado(page, patientId);
    await page.getByTestId('new-address-btn').click();
    const drawer = page.getByTestId('patient-address-drawer');
    await expect(drawer).toBeVisible();
    await escolherPlace(page, 'Av. Corrientes 1234');
    await expect(page.getByTestId('pad-address')).toHaveValue(CABA_CORRIENTES.formatted_address, { timeout: 10_000 });
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && /\/addresses$/.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await post).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    // Único jeito hoje de chegar a "nenhum principal" (rota de arquivar pela ficha é pendência
    // separada, OP-04 — ver LocalizacoesCard.tsx) — desmarca via SQL direto, como o teste da
    // fase 1 faz para o caso "sem endereço nenhum". Aqui simula uma linha ativa sem NENHUMA
        // marcada principal (`is_default = false` em todas), condição que o front já sabe detectar.
    runSQL(`UPDATE patient_addresses SET is_default = false WHERE patient_id = '${patientId}'`);
    await page.reload();
    await abrirTabServicioContratado(page, patientId);
    const card = page.getByTestId('localizacoes-card');
    await expect(card.getByTestId('address-no-principal-warning')).toContainText('Sin principal', { timeout: 20_000 });

    testInfo.annotations.push({ type: 'evidência', description: `aviso Sin principal renderizado para patient ${patientId}` });
    await expect(card).toHaveScreenshot('localizaciones-fase2-sin-principal.png', { maxDiffPixelRatio: 0.05 });
  });
});
