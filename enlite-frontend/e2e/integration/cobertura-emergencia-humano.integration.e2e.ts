/**
 * 417 / D301 (respostas da Ana Joulie, 08/09) — um HUMANO, contra o stack REAL (frontend + API + Postgres +
 * emulador), zero mock: click + `keyboard.type` + valor lido da TELA.
 *
 * O que se prova:
 *   1. feliz — na ficha, "Cobertura Médica" → Editar → agrega DOIS contatos de emergência da cobertura
 *      (ambulância e profissional direto), salva; o card lista os dois; no banco há 2 linhas e o telefone
 *      NÃO está em claro (`phone_encrypted` ≠ o número digitado — lex C1);
 *   2. alternativo — tira um contato e salva: o card e o banco ficam com UM;
 *   3. alternativo (Ana, item 1) — o PDF do projeto: com serviço de CUIDADORES leva o bloco "Emergencia de
 *      la cobertura médica" com o contato e as seções fixas VIII/IX; com o MESMO projeto e o serviço
 *      passado a AT, as seções VIII/IX saem com o rótulo "no aplicable" e sem o texto do cuidador;
 *   4. foto do card com os contatos (`toHaveScreenshot`).
 */
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { seedActivatablePatient, cleanupPatientDeep, runSQL } from '../helpers/patient-detail-c-helper';

const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.cov.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const TEL_AMBULANCIA = '0800 417 0001';
const TEL_PROFISSIONAL = '11 5555 0417';

async function loginComoHumano(page: Page): Promise<void> {
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Cobertura', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').click();
  await page.keyboard.type(STAFF_EMAIL);
  await page.locator('input[type="password"]').click();
  await page.keyboard.type(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

/** A cobertura vive na aba "Servicio Contratado" (D286: container `patient_coverage`); o humano clica na aba. */
async function abrirAbaServicio(page: Page): Promise<void> {
  await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Servicio Contratado' }).click();
}

async function digitar(page: Page, testId: string, texto: string): Promise<void> {
  const campo = page.getByTestId(testId);
  await campo.click();
  await expect(campo).toBeFocused();
  await page.keyboard.type(texto);
  await expect(campo).toHaveValue(texto);
}

const contatosNoBanco = (patientId: string) => runSQL(`SELECT string_agg(kind || '=' || name || '=' || phone_encrypted, '|' ORDER BY sort_order) FROM patient_coverage_emergency_contacts WHERE patient_id = '${patientId}'`).trim();

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on', acceptDownloads: true });

test.describe('417/D301 — contatos de emergência da cobertura e o PDF por serviço: um HUMANO no stack real @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(300_000);

  let seed: { patientId: string; addressId: string; stamp: string };
  let serviceId: string;
  let versionId: string;

  test.beforeAll(() => {
    seed = seedActivatablePatient(710000); // faixa própria (710000–719999)
    serviceId = runSQL(`INSERT INTO patient_contracted_services (patient_id, service_code, weekly_hours, address_id, created_by, updated_by) VALUES ('${seed.patientId}', 'CAREGIVER', 20, '${seed.addressId}', 'e2e-417', 'e2e-417') RETURNING id`).split('\n')[0].trim();
    expect(serviceId).toMatch(/^[0-9a-f-]{36}$/);
  });
  test.afterAll(() => {
    runSQL(`DELETE FROM patients WHERE id = '${seed.patientId}'`); // versão imutável: o pai sai primeiro
    cleanupPatientDeep(seed.patientId);
  });

  test('feliz: Editar cobertura → dois contatos digitados → o card lista os dois; no banco 2 linhas com o telefone CIFRADO', async ({ page }) => {
    await loginComoHumano(page);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaServicio(page);
    const card = page.getByTestId('cobertura-medica-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId('coverage-emergency-contacts')).toContainText('—');

    await page.getByTestId('edit-coverage-btn').click();
    const drawer = page.getByTestId('patient-coverage-edit-drawer');
    await expect(drawer).toBeVisible();
    // lex C10: o aviso do dever de informar está no ponto da coleta.
    await expect(page.getByTestId('pcv-contacts-notice')).toContainText('se imprimen en el Proyecto Terapéutico');
    await expect(page.getByTestId('pcv-contacts-empty')).toBeVisible();

    await page.getByTestId('pcv-contact-add').click();
    await expect(page.getByTestId('pcv-contact-kind-0')).toHaveValue('AMBULANCE');
    await expect(page.getByTestId('pcv-save')).toBeDisabled(); // linha vazia = inválida
    await digitar(page, 'pcv-contact-name-0', 'Ambulancia Sintética 417');
    await digitar(page, 'pcv-contact-phone-0', TEL_AMBULANCIA);
    await expect(page.getByTestId('pcv-save')).toBeEnabled();

    await page.getByTestId('pcv-contact-add').click();
    await page.getByTestId('pcv-contact-kind-1').selectOption('DIRECT_PROFESSIONAL');
    await expect(page.getByTestId('pcv-contact-kind-1')).toHaveValue('DIRECT_PROFESSIONAL');
    await digitar(page, 'pcv-contact-name-1', 'Dra. Sintética 417');
    await digitar(page, 'pcv-contact-phone-1', TEL_PROFISSIONAL);

    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes(`/patients/${seed.patientId}/coverage`));
    await page.getByTestId('pcv-save').click();
    expect((await patch).status()).toBe(200);
    await expect(drawer).toHaveCount(0);

    // O card mostra os dois, com o tipo por extenso.
    const row = card.getByTestId('coverage-emergency-contacts');
    await expect(row).toContainText(`Ambulancia: Ambulancia Sintética 417 · ${TEL_AMBULANCIA}`);
    await expect(row).toContainText(`Profesional directo: Dra. Sintética 417 · ${TEL_PROFISSIONAL}`);
    await expect(card).toHaveScreenshot('cobertura-card-com-contatos.png', {
      mask: [page.locator('.firebase-emulator-warning')],
      maxDiffPixelRatio: 0.02,
    });

    // 🔒 lex C1: no banco há 2 linhas e o número digitado NÃO está em claro em nenhuma coluna.
    const banco = contatosNoBanco(seed.patientId);
    expect(banco.split('|')).toHaveLength(2);
    expect(banco).toContain('AMBULANCE=Ambulancia Sintética 417=');
    expect(banco).toContain('DIRECT_PROFESSIONAL=Dra. Sintética 417=');
    expect(banco).not.toContain(TEL_AMBULANCIA);
    expect(banco).not.toContain(TEL_PROFISSIONAL);
    expect(runSQL(`SELECT DISTINCT country FROM patient_coverage_emergency_contacts WHERE patient_id = '${seed.patientId}'`).trim()).toBe('AR');
  });

  test('alternativo: tirar a ambulância e salvar → o card e o banco ficam SÓ com o profissional', async ({ page }) => {
    await loginComoHumano(page);
    await page.goto(`/admin/patients/${seed.patientId}`);
    await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 30_000 });
    await abrirAbaServicio(page);
    const card = page.getByTestId('cobertura-medica-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('edit-coverage-btn').click();
    await expect(page.getByTestId('pcv-contact-name-0')).toHaveValue('Ambulancia Sintética 417');
    await page.getByTestId('pcv-contact-remove-0').click();
    await expect(page.getByTestId('pcv-contact-name-0')).toHaveValue('Dra. Sintética 417');
    const patch = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/coverage'));
    await page.getByTestId('pcv-save').click();
    expect((await patch).status()).toBe(200);
    await expect(page.getByTestId('patient-coverage-edit-drawer')).toHaveCount(0);
    const row = card.getByTestId('coverage-emergency-contacts');
    await expect(row).not.toContainText('Ambulancia Sintética 417');
    await expect(row).toContainText('Profesional directo: Dra. Sintética 417');
    expect(contatosNoBanco(seed.patientId).split('|')).toHaveLength(1);
  });

  test('alternativo (Ana, item 1): o PDF com serviço de CUIDADORES leva o contato da cobertura e as seções fixas; com o serviço passado a AT, as seções saem "no aplicable"', async ({ page }) => {
    // A versão do projeto entra por SQL (o fluxo humano de criar/editar tem spec próprio); o export é humano.
    const obj = runSQL(`SELECT id FROM therapeutic_specific_objectives WHERE active ORDER BY sort_order LIMIT 1`).trim();
    const act = runSQL(`SELECT id FROM therapeutic_activities WHERE active ORDER BY sort_order LIMIT 1`).trim();
    const pat = runSQL(`SELECT id FROM pathology_types WHERE active ORDER BY sort_order LIMIT 1`).trim();
    versionId = runSQL(`INSERT INTO patient_therapeutic_projects (patient_id, major, minor, contracted_service_id, modality, diagnoses, clinical_context, general_objective, specific_objectives, activities, pathology_types, start_date, end_date, created_by)
      VALUES ('${seed.patientId}', 1, 0, '${serviceId}', 'ONLINE', '[{"uri":"http://id.who.int/icd/entity/e2e-417","title":"Diagnóstico sintético 417"}]', 'Contexto sintético 417', 'Objetivo sintético 417',
        (SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM therapeutic_specific_objectives WHERE id = '${obj}'),
        (SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM therapeutic_activities WHERE id = '${act}'),
        (SELECT jsonb_build_array(jsonb_build_object('id', id, 'label', label)) FROM pathology_types WHERE id = '${pat}'),
        '2026-09-01', '2026-12-31', 'e2e-417') RETURNING id`).split('\n')[0].trim();
    expect(versionId).toMatch(/^[0-9a-f-]{36}$/);

    await loginComoHumano(page);
    await page.goto(`/admin/patients/${seed.patientId}`);
    const exportar = async (): Promise<string> => {
      await expect(page.getByTestId('projeto-terapeutico-card')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('projeto-terapeutico-card').getByTestId('tpv-modality')).toContainText('On-line');
      await page.getByTestId(`tp-view-${versionId}`).click();
      const drawer = page.getByTestId('therapeutic-project-drawer');
      await expect(drawer).toHaveAttribute('data-mode', 'view');
      const download = page.waitForEvent('download');
      await page.getByTestId('therapeutic-project-export-btn').click();
      const file = await download;
      const parsed = await pdfParse(readFileSync((await file.path())!));
      await page.getByTestId('therapeutic-project-close').click();
      await expect(drawer).toHaveCount(0);
      return parsed.text.replace(/\s+/g, ' ');
    };

    const cuidador = await exportar();
    expect(cuidador).toContain('Modalidad: On-line');
    expect(cuidador).toContain('Emergencia de la cobertura médica: Profesional directo: Dra. Sintética 417 - 11 5555 0417');
    expect(cuidador).toContain('Familiar / persona responsable: —'); // sem responsável semeado: o campo existe e sai vazio, separado do da cobertura
    expect(cuidador).toContain('El cuidador NO debe');
    expect(cuidador).toContain('Por cuestiones Terapéuticas');
    expect(cuidador).not.toContain('no aplicable a este servicio');

    // O MESMO projeto, com o serviço vinculado passado a Acompañante Terapéutico.
    runSQL(`UPDATE patient_contracted_services SET service_code = 'AT' WHERE id = '${serviceId}'`);
    await page.reload();
    const at = await exportar();
    expect(at).toContain('Servicio solicitado: Acompañante Terapéutico');
    expect(at.split('no aplicable a este servicio').length - 1).toBe(2);
    expect(at).not.toContain('El cuidador NO debe');
    expect(at).not.toContain('Por cuestiones Terapéuticas');
    expect(at).toContain('Profesional directo: Dra. Sintética 417'); // o contato continua: é da cobertura, não do serviço
  });
});
