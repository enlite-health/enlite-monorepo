/**
 * localizaciones-fase1.integration.e2e.ts @integration — card "Localizaciones" (painel admin,
 * ficha do paciente), Fase 1.
 *
 * Front real (Vite 5173) + API real (docker enlite-api) + Postgres real. Auth REAL pelo emulador
 * do Firebase (molde: admission-b-campos.integration.e2e.ts). Zero mock de dado — só dado
 * sintético. O autocomplete do Google é um FAKE que reproduz os GESTOS medidos contra o Google
 * real (mesmo `google-places-fake-gestos.ts` usado no B2; ver o cabeçalho daquele arquivo para o
 * porquê de não usar `google-maps-fake.ts` nem o Google de verdade aqui).
 *
 * T1/T2 — a Zona (`neighborhood`) do drawer de criação é pré-preenchida com a MESMA regra do
 *         servidor quando o place escolhido traz um componente de zona, e NUNCA sobrescreve o
 *         que a operadora já digitou.
 * T3    — a lista mostra só Tipo | Dirección (2 linhas) | lápis; o endereço Principal leva o
 *         selo "Principal"; uma linha sem endereço nenhum mostra o alerta "Sin dirección cargada".
 *
 *  feliz — criar endereço (escolha do Google com zona) → Zona pré-preenchida → salva → lista
 *          mostra Tipo "Principal" com selo + Dirección em 2 linhas.
 *  alt 1 — a operadora digita a Zona ANTES de escolher da lista; a escolha traz outra zona; o
 *          valor digitado sobrevive (T2 nunca sobrescreve).
 *  alt 2 — uma linha semeada no banco sem `address_formatted` nem `address_raw` aparece como
 *          "Sin dirección cargada" (T3), sem ação falsa.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient } from '../helpers/db-test-helper';
import { readAddresses, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-b-helper';
import { instalarFakeDeGestos, CABA_CORRIENTES, CABA_CORRIENTES_CON_ZONA } from '../helpers/google-places-fake-gestos';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.localizaciones1.${Date.now()}@enlite.health`;
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Localizaciones', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
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

test.describe('Card Localizaciones — Fase 1 (T1/T2/T3) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  const pacientes: string[] = [];
  test.afterAll(() => {
    pacientes.forEach(cleanupPatientDeep);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('feliz — escolher da lista pré-preenche a Zona; a lista mostra Tipo (selo Principal) + Dirección em 2 linhas', async ({ page }, testInfo) => {
    await instalarFakeDeGestos(page, CABA_CORRIENTES_CON_ZONA);
    await loginAsRealStaff(page);
    const { patientId } = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'LocFase1', lastName: `Feliz${Date.now()}`, withAddress: false });
    pacientes.push(patientId);

    await abrirTabServicioContratado(page, patientId);
    const card = page.getByTestId('localizacoes-card');
    await expect(card).toContainText('Sin datos cargados');

    await page.getByTestId('new-address-btn').click();
    const drawer = page.getByTestId('patient-address-drawer');
    await expect(drawer).toBeVisible();

    await escolherPlace(page, 'Av. Corrientes 1234');
    await expect(page.getByTestId('pad-address')).toHaveValue(CABA_CORRIENTES_CON_ZONA.formatted_address, { timeout: 10_000 });

    // T1/T2 — a Zona nasceu preenchida SOZINHA, sem a operadora digitar nada.
    await expect(page.getByTestId('pad-neighborhood')).toHaveValue('San Nicolás');

    await page.getByTestId('pad-type').selectOption('primary');
    const post = page.waitForResponse((r) => r.request().method() === 'POST' && /\/addresses$/.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await post).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    // T3 — Tipo com selo Principal + Dirección em 2 linhas (linha 1 até a 1ª vírgula, linha 2 = Zona).
    await expect(card).toContainText('Av. Corrientes 1234', { timeout: 20_000 });
    await expect(card).toContainText('San Nicolás');
    await expect(card.getByTestId(/address-primary-badge-/)).toHaveText('Principal');

    const rows = readAddresses(patientId);
    testInfo.annotations.push({ type: 'evidência', description: `feliz — patient_addresses: ${JSON.stringify(rows)}` });
    expect(rows).toHaveLength(1);
    expect(rows[0].neighborhood).toBe('San Nicolás');

    await expect(card).toHaveScreenshot('localizaciones-fase1-feliz.png', { maxDiffPixelRatio: 0.05 });
  });

  test('alt 1 — a operadora digita a Zona ANTES de escolher; a escolha traz outra zona, e o valor digitado sobrevive', async ({ page }, testInfo) => {
    await instalarFakeDeGestos(page, CABA_CORRIENTES_CON_ZONA);
    await loginAsRealStaff(page);
    const { patientId } = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'LocFase1', lastName: `Alt1${Date.now()}`, withAddress: false });
    pacientes.push(patientId);

    await abrirTabServicioContratado(page, patientId);
    await page.getByTestId('new-address-btn').click();
    const drawer = page.getByTestId('patient-address-drawer');
    await expect(drawer).toBeVisible();

    // A operadora já escreveu a zona dela ANTES de mexer no endereço.
    await page.getByTestId('pad-neighborhood').fill('Zona Que a Operadora Digitou');

    await escolherPlace(page, 'Av. Corrientes 1234');
    await expect(page.getByTestId('pad-address')).toHaveValue(CABA_CORRIENTES_CON_ZONA.formatted_address, { timeout: 10_000 });

    // A escolha TRAZ zona ("San Nicolás"), mas o campo não muda — T2 nunca sobrescreve.
    await expect(page.getByTestId('pad-neighborhood')).toHaveValue('Zona Que a Operadora Digitou');

    const post = page.waitForResponse((r) => r.request().method() === 'POST' && /\/addresses$/.test(r.url()));
    await page.getByTestId('pad-save').click();
    expect((await post).status()).toBe(201);
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    const card = page.getByTestId('localizacoes-card');
    await expect(card).toContainText('Zona Que a Operadora Digitou', { timeout: 20_000 });
    await expect(card).not.toContainText('San Nicolás');

    const rows = readAddresses(patientId);
    testInfo.annotations.push({ type: 'evidência', description: `alt1 — patient_addresses: ${JSON.stringify(rows)}` });
    expect(rows[0].neighborhood).toBe('Zona Que a Operadora Digitou');
  });

  test('alt 2 — linha sem address_formatted nem address_raw aparece como "Sin dirección cargada", sem ação falsa', async ({ page }) => {
    await loginAsRealStaff(page);
    const { patientId } = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'LocFase1', lastName: `Alt2${Date.now()}`, withAddress: false });
    pacientes.push(patientId);
    // Linha real de banco sem NENHUM texto de endereço — o caso que a régua "sem ação falsa" cobre
    // (ex.: registro legado do ClickUp que nunca teve o campo preenchido).
    runSQL(`INSERT INTO patient_addresses (patient_id, address_type, address_formatted, address_raw, display_order, source, created_at, updated_at) VALUES ('${patientId}', 'secondary', NULL, NULL, 1, 'clickup', NOW(), NOW())`);

    await abrirTabServicioContratado(page, patientId);
    const card = page.getByTestId('localizacoes-card');
    await expect(card.getByTestId(/address-missing-/)).toHaveText('Sin dirección cargada');
    // Sem ação falsa: o lápis abre a edição da LOGÍSTICA (zona/corredor/acesso), nunca promete
    // consertar o texto do endereço em si — ele continua "—" dentro do próprio drawer.
    await card.getByTestId(/edit-address-/).click();
    await expect(page.getByTestId('pad-address-readonly')).toContainText('—');
    await page.keyboard.press('Escape');
  });
});
