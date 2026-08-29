/**
 * patient-observaciones-generales.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK DE API: navegador real → worker-functions real (Docker,
 * migration 286 aplicada) → Postgres real → Firebase Auth EMULATOR real. Nenhum `page.route`.
 *
 * O que prova (REQ-01 · D195 · lex 29/08 itens 1 e 3):
 *   - o campo "Observaciones generales" da ficha é uma ÁREA DE TEXTO (não input de 1 linha),
 *     com contador, e o card mostra o texto com as quebras de linha;
 *   - ao salvar, o backend grava `additional_comments_updated_by` = uid do staff logado e
 *     `additional_comments_updated_at` agora — na MESMA transação do PATCH — e a ficha mostra
 *     "Última edición: <data> · <nome do staff>" (nome resolvido em `users`, o uid não sai);
 *   - o container do texto leva `data-clarity-mask="True"` na ficha e no drawer (lex C1.1);
 *   - MEDIÇÃO (SUP-10 do plano): o que acontece com `diagnosis` quando SÓ as observações são
 *     editadas — registrado como evidência, não como gate.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.req01.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const STAFF_NAME = 'E2E Req01 Coordinadora';
const NOTES = 'Paciente con TEA nivel 2.\nEvitar ruidos fuertes.\nCrisis: llamar a la madre primero.';

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

async function loginAsRealStaff(page: Page): Promise<string> {
  const res = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  const auth = res.ok ? res : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', '${STAFF_NAME}', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
  return localId;
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Ficha do paciente: "Observaciones generales" texto longo + autoria (REQ-01) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let patientId = '';

  test.beforeAll(() => {
    const { patientId: pid } = insertTestPatient({ firstName: 'Paciente', lastName: `Req01${Date.now().toString().slice(-5)}`, diagnosis: 'F84.0 TEA' });
    patientId = pid;
  });

  test.afterAll(() => {
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('textarea com contador → salvar → ficha com quebras + "Última edición · nome" → autoria no banco', async ({ page }, testInfo) => {
    const uid = await loginAsRealStaff(page);
    await page.goto(`/admin/patients/${patientId}`);

    // Antes: sem autoria, texto "—"
    const notes = page.getByTestId('general-notes');
    await expect(notes).toBeVisible({ timeout: 30_000 });
    await expect(notes).toHaveAttribute('data-clarity-mask', 'True');
    await expect(page.getByTestId('general-notes-text')).toHaveText('—');
    await expect(page.getByTestId('general-notes-edited')).toHaveCount(0);
    expect(runSQL(`SELECT additional_comments_updated_by IS NULL AND additional_comments_updated_at IS NULL FROM patients WHERE id = '${patientId}'`)).toBe('t');
    const diagnosisBefore = runSQL(`SELECT diagnosis FROM patients WHERE id = '${patientId}'`);

    // Drawer: é um TEXTAREA com contador e máscara
    await page.getByTestId('edit-clinical-btn').click();
    const ta = page.getByTestId('pce-comments');
    await expect(ta).toBeVisible();
    expect(await ta.evaluate((el) => el.tagName)).toBe('TEXTAREA');
    await expect(ta).toHaveAttribute('rows', '8');
    await expect(page.getByTestId('pce-comments-counter')).toHaveText('0/4000 caracteres');
    expect(await ta.evaluate((el) => el.parentElement?.getAttribute('data-clarity-mask'))).toBe('True');
    await ta.fill(NOTES);
    await expect(page.getByTestId('pce-comments-counter')).toHaveText(`${NOTES.length}/4000 caracteres`);
    await page.screenshot({ path: testInfo.outputPath('01-drawer-textarea.png'), fullPage: false });
    await expect(page.getByTestId('patient-clinical-edit-drawer')).toHaveScreenshot('req01-drawer-textarea.png', { maxDiffPixelRatio: 0.05 });

    await page.getByTestId('pce-save').click();
    await expect(page.getByTestId('patient-clinical-edit-drawer')).toHaveCount(0, { timeout: 15_000 });

    // Ficha: texto com quebras + linha de autoria com o NOME do staff (não o uid)
    await expect(page.getByTestId('general-notes-text')).toHaveText(NOTES, { timeout: 15_000 });
    const edited = page.getByTestId('general-notes-edited');
    await expect(edited).toContainText('Última edición:');
    await expect(edited).toContainText(STAFF_NAME);
    await expect(edited).not.toContainText(uid);
    await page.screenshot({ path: testInfo.outputPath('02-ficha-observaciones.png'), fullPage: true });
    await expect(notes).toHaveScreenshot('req01-ficha-observaciones.png', { maxDiffPixelRatio: 0.05 });

    // Banco: autoria gravada com o uid do staff, agora
    const row = runSQL(`SELECT additional_comments_updated_by || '|' || (additional_comments_updated_at > NOW() - INTERVAL '2 minutes')::text || '|' || (additional_comments = E'${NOTES.replace(/\n/g, '\\n')}')::text FROM patients WHERE id = '${patientId}'`);
    expect(row).toBe(`${uid}|true|true`);

    // MEDIÇÃO SUP-10: editar SÓ as observações mexeu no diagnóstico?
    const diagnosisAfter = runSQL(`SELECT COALESCE(diagnosis, '<NULL>') FROM patients WHERE id = '${patientId}'`);
    testInfo.annotations.push({ type: 'evidência', description: `SUP-10 — diagnosis antes="${diagnosisBefore}" depois="${diagnosisAfter}"` });
    console.log(`[SUP-10] diagnosis antes="${diagnosisBefore}" depois="${diagnosisAfter}"`);
  });

  test('editar OUTRO campo clínico não reescreve a autoria das observações', async ({ page }) => {
    await loginAsRealStaff(page);
    const before = runSQL(`SELECT additional_comments_updated_at::text FROM patients WHERE id = '${patientId}'`);
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('edit-clinical-btn').click();
    await page.getByTestId('pce-device').fill('Silla de ruedas');
    await page.getByTestId('pce-save').click();
    await expect(page.getByTestId('patient-clinical-edit-drawer')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('general-notes-edited')).toContainText(STAFF_NAME, { timeout: 15_000 });
    expect(runSQL(`SELECT additional_comments_updated_at::text FROM patients WHERE id = '${patientId}'`)).toBe(before);
    expect(runSQL(`SELECT device_type FROM patients WHERE id = '${patientId}'`)).toBe('Silla de ruedas');
    // MEDIÇÃO SUP-10 (inversa): editar SÓ o aparelho mexeu nas observações?
    const notesAfter = runSQL(`SELECT COALESCE(additional_comments, '<NULL>') FROM patients WHERE id = '${patientId}'`);
    test.info().annotations.push({ type: 'evidência', description: `SUP-10 inversa — additional_comments depois de editar só device_type: "${notesAfter.slice(0, 40)}"` });
    console.log(`[SUP-10 inversa] additional_comments depois de editar só device_type = "${notesAfter.slice(0, 40)}"`);
  });
});
