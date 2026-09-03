/**
 * admission-a-bugs-dado.integration.e2e.ts @integration — spec 011, bloco A.
 *
 * Front real (Vite 5173) + API real (docker enlite-api) + Postgres real. Auth
 * REAL pelo emulador do Firebase (docker-compose.firebase.yml → USE_MOCK_AUTH=false).
 * Zero mock — nem de auth, nem de dado. Dados sintéticos; nada de paciente real.
 *
 *  A2 — Equipo Tratante e Localizaciones mostram o que a API devolve (name / addressFormatted)
 *  A3 — cobertura gravada em health_insurance_name aparece na ficha (COALESCE)
 *  A4 — e-mail do paciente aparece na identidade e carrega no drawer; editar WhatsApp o mantém
 *  A1 — editar o telefone do responsável mantém documento (tipo + número) e procedência (source)
 */
import { test, expect, type Page } from '@playwright/test';
import {
  seedPatientForBlocoA, readPrimaryResponsible, readContactEmail, readPatientCoverageColumns,
  findPatientIdByFirstName, cleanupPatientDeep, runSQL, type BlocoASeed,
} from '../helpers/patient-detail-a-helper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.blocoa.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';

/**
 * Auth REAL pelo emulador do Firebase (a API do docker roda com USE_MOCK_AUTH=false
 * e FIREBASE_AUTH_EMULATOR_HOST — docker-compose.firebase.yml). Nada é interceptado:
 * o browser faz o signIn de verdade e toda chamada /api/** vai para a API real com o
 * JWT do emulador. Molde: patient-observaciones-generales.integration.e2e.ts.
 */
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Bloco A', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
}

/** Abre a ficha e devolve o JSON REAL de GET /api/admin/patients/:id (contrato vivo). */
async function openDetail(page: Page, patientId: string): Promise<Record<string, any>> {
  const isDetail = new RegExp(`/api/admin/patients/${patientId}(\\?|$)`);
  // O bootstrap de auth do painel pode redirecionar logo depois do login e engolir
  // o primeiro goto; a segunda tentativa cai já com a sessão assentada.
  for (let attempt = 0; attempt < 2; attempt++) {
    const detail = page
      .waitForResponse((r) => r.request().method() === 'GET' && isDetail.test(r.url()), { timeout: 20_000 })
      .catch(() => null);
    await page.goto(`/admin/patients/${patientId}`);
    const res = await detail;
    if (res) {
      try {
        return ((await res.json()) as { data: Record<string, any> }).data;
      } catch {
        // Corpo descartado por navegação concorrente: desde a spec 014 (D5) criar paciente já
        // abre a ficha sozinho, e o GET dessa navegação pode ser o capturado aqui enquanto o
        // `goto` acima o interrompe ("No resource with given identifier"). Tenta de novo.
      }
    }
  }
  throw new Error(`GET /api/admin/patients/${patientId} não observado em 2 tentativas`);
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Spec 011 bloco A — a ficha mostra e não apaga dado do paciente @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let seed: BlocoASeed;
  let createdViaModalId = '';

  test.beforeAll(() => { seed = seedPatientForBlocoA(); });
  test.afterAll(() => {
    cleanupPatientDeep(seed.patientId);
    cleanupPatientDeep(createdViaModalId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('A2/A3/A4 — profissional, endereço, cobertura e e-mail visíveis (contrato real da API)', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    const data = await openDetail(page, seed.patientId);

    // Contrato vivo: as chaves que os cards leem existem na resposta real.
    expect(data.professionals[0].name).toBe(seed.professional.name);
    expect(data.addresses[0].addressFormatted).toBe(seed.addressFormatted);
    expect(data.insuranceInformed).toBe(seed.coverage);
    expect(data.contactEmail).toBe(seed.contactEmail);

    // A4 — identidade: e-mail em claro, container com máscara do Clarity.
    const identity = page.getByTestId('patient-identity-card');
    await expect(identity).toBeVisible({ timeout: 30_000 });
    const email = page.getByTestId('patient-contact-email');
    await expect(email).toHaveText(seed.contactEmail);
    expect(await email.evaluate((el) => el.closest('[data-clarity-mask="True"]') !== null)).toBe(true);
    await expect(identity).toHaveScreenshot('bloco-a-identidad-email.png', { maxDiffPixelRatio: 0.05 });

    // A2 — Equipo Tratante (aba Datos Clínicos, a inicial): nome do profissional, não "—".
    const equipe = page.getByTestId('equipe-tratante-card');
    await expect(equipe).toContainText(seed.professional.name);
    await expect(equipe).toContainText(seed.professional.phone);
    expect(await equipe.locator('table').evaluate((el) => el.closest('[data-clarity-mask="True"]') !== null)).toBe(true);
    await expect(equipe).toHaveScreenshot('bloco-a-equipo-tratante.png', { maxDiffPixelRatio: 0.05 });

    // A2 + A3 — aba Servicio Contratado: endereço de rua e cobertura.
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click(); // spec 014: escopado — checklist de completude pode render chip com o mesmo texto
    const localizacoes = page.getByTestId('localizacoes-card');
    await expect(localizacoes).toContainText(seed.addressFormatted);
    expect(await localizacoes.locator('table').evaluate((el) => el.closest('[data-clarity-mask="True"]') !== null)).toBe(true);
    const cobertura = page.getByTestId('cobertura-medica-card');
    await expect(cobertura).toContainText(seed.coverage);
    await page.screenshot({ path: testInfo.outputPath('01-servicio-contratado.png'), fullPage: true });
    await expect(localizacoes).toHaveScreenshot('bloco-a-localizaciones.png', { maxDiffPixelRatio: 0.05 });
    await expect(cobertura).toHaveScreenshot('bloco-a-cobertura.png', { maxDiffPixelRatio: 0.05 });
  });

  test('A1 — editar o telefone do responsável mantém documento e procedência no Postgres', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await openDetail(page, seed.patientId);
    const before = readPrimaryResponsible(seed.patientId);
    expect(before).toEqual({ documentType: 'DNI', documentNumber: seed.responsible.documentNumber, source: 'web_form', phone: seed.responsible.phone });

    await page.getByRole('button', { name: /Red de Apoyo/i }).click();
    await page.getByTestId('edit-support-btn').click();
    const drawer = page.getByTestId('patient-support-edit-drawer');
    await expect(drawer).toBeVisible();
    // O drawer carrega o documento em claro (lex A1: mascarar aqui seria teatro).
    await expect(page.getByTestId('psn-documentType-0')).toHaveValue('DNI');
    await expect(page.getByTestId('psn-documentNumber-0')).toHaveValue(seed.responsible.documentNumber);
    await expect(drawer).toHaveScreenshot('bloco-a-drawer-familiares.png', { maxDiffPixelRatio: 0.05 });

    await page.getByTestId('psn-phone-0').fill('+5491100000099');
    await page.getByTestId('psn-save').click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    const after = readPrimaryResponsible(seed.patientId);
    testInfo.annotations.push({ type: 'evidência', description: `A1 — antes=${JSON.stringify(before)} depois=${JSON.stringify(after)}` });
    expect(after).toEqual({ documentType: 'DNI', documentNumber: seed.responsible.documentNumber, source: 'web_form', phone: '+5491100000099' });
    await expect(page.getByTestId('familiares-card')).toContainText(seed.responsible.documentNumber);
  });

  test('A4 — o drawer geral carrega o e-mail; editar só o WhatsApp o mantém', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await openDetail(page, seed.patientId);
    expect(readContactEmail(seed.patientId)).toBe(seed.contactEmail);

    await page.getByTestId('edit-general-btn').click();
    const drawer = page.getByTestId('patient-general-edit-drawer');
    await expect(drawer).toBeVisible();
    await expect(page.getByTestId('pge-email')).toHaveValue(seed.contactEmail);
    await page.getByTestId('pge-phone').fill('+5491100000077');
    await page.getByTestId('pge-save').click();
    await expect(drawer).toHaveCount(0, { timeout: 15_000 });

    const emailAfter = readContactEmail(seed.patientId);
    testInfo.annotations.push({ type: 'evidência', description: `A4 — contact_email depois de editar WhatsApp: ${emailAfter === seed.contactEmail ? 'intacto' : emailAfter}` });
    expect(emailAfter).toBe(seed.contactEmail);
    expect(runSQL(`SELECT phone_whatsapp FROM patients WHERE id = '${seed.patientId}'`)).toBe('+5491100000077');
    await expect(page.getByTestId('patient-contact-email')).toHaveText(seed.contactEmail, { timeout: 15_000 });
  });

  test('A3 (criação) — "Nuevo paciente" com cobertura e e-mail → a ficha mostra os dois', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    const stamp = Date.now().toString().slice(-6);
    const firstName = `NuevoBlocoA${stamp}`;
    const coverage = `Swiss Medical e2e ${stamp}`;
    const email = `nuevo.${stamp}@example.test`;

    await page.goto('/admin/patients');
    await page.getByTestId('new-patient-btn').click();
    await expect(page.getByTestId('patient-create-modal')).toBeVisible();
    await page.getByTestId('pc-firstName').fill(firstName);
    await page.getByTestId('pc-lastName').fill('Modal');
    await page.getByTestId('pc-phone').fill('+5491100000031');
    await page.getByTestId('pc-email').fill(email);
    await page.getByTestId('pc-insName').fill(coverage);
    await page.getByTestId('pc-save').click();
    await expect(page.getByTestId('patient-create-modal')).toHaveCount(0, { timeout: 15_000 });

    createdViaModalId = findPatientIdByFirstName(firstName);
    expect(createdViaModalId).toMatch(/^[0-9a-f-]{36}$/);
    const cols = readPatientCoverageColumns(createdViaModalId);
    testInfo.annotations.push({ type: 'evidência', description: `A3 — colunas do paciente criado pelo modal: ${JSON.stringify(cols)}` });
    expect(cols.healthInsuranceName).toBe(coverage);

    const data = await openDetail(page, createdViaModalId);
    expect(data.insuranceInformed).toBe(coverage);
    expect(data.contactEmail).toBe(email);
    await expect(page.getByTestId('patient-contact-email')).toHaveText(email, { timeout: 30_000 });
    await page.getByTestId('patient-profile-tabs').getByRole('button', { name: /Servicio Contratado/i }).click(); // spec 014: escopado — checklist de completude pode render chip com o mesmo texto
    await expect(page.getByTestId('cobertura-medica-card')).toContainText(coverage);
  });
});
