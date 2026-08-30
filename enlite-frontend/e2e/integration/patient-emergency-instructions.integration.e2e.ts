/**
 * patient-emergency-instructions.integration.e2e.ts @integration — REQ-01 · D211.2
 *
 * PONTA A PONTA SEM MOCK DE API: navegador real → worker-functions real (Docker, migration 294)
 * → Postgres real → Firebase Auth EMULATOR real. Nenhum `page.route`.
 *
 * O que prova:
 *   - o drawer clínico ganha "Instrucciones de emergencia" (textarea + contador, `data-clarity-mask`);
 *   - salvar grava o texto + autoria (uid do staff, agora) na MESMA transação e a ficha mostra o
 *     texto com quebras e "Última edición: <data> · <nome>";
 *   - editar SÓ outro campo não toca o texto nem a autoria (Merge Patch);
 *   - `toHaveScreenshot` do drawer e do bloco da ficha.
 * A redação por permissão é provada no unitário (sem engine nesta base — D113).
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.emerg.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const STAFF_NAME = 'E2E Emergencia Coordinadora';
const TEXT = 'Crisis: llamar al 107.\nAvisar a la madre antes de mover.\nNo dar medicación sin indicación.';

function runSQL(sql: string): string {
  return execSync(`docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' }).trim();
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

test.describe('Ficha do paciente: "Instrucciones de emergencia" + autoria (D211.2) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let patientId = '';

  test.beforeAll(() => {
    patientId = insertTestPatient({ firstName: 'Paciente', lastName: `Emerg${Date.now().toString().slice(-5)}`, diagnosis: 'F84.0 TEA' }).patientId;
  });
  test.afterAll(() => {
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('drawer com textarea + contador → salvar → ficha com o texto e "Última edición · nome" → autoria no banco', async ({ page }, testInfo) => {
    const uid = await loginAsRealStaff(page);
    await page.goto(`/admin/patients/${patientId}`);
    const box = page.getByTestId('emergency-instructions');
    await expect(box).toBeVisible({ timeout: 30_000 });
    await expect(box).toHaveAttribute('data-clarity-mask', 'True');
    await expect(page.getByTestId('emergency-instructions-text')).toHaveText('—');
    await expect(page.getByTestId('emergency-instructions-edited')).toHaveCount(0);

    await page.getByTestId('edit-clinical-btn').click();
    const ta = page.getByTestId('pce-emergency');
    await expect(ta).toBeVisible();
    await expect(ta.locator('xpath=..')).toHaveAttribute('data-clarity-mask', 'True');
    await expect(page.getByTestId('pce-emergency-counter')).toHaveText('0/4000 caracteres');
    await ta.fill(TEXT);
    await expect(page.getByTestId('pce-emergency-counter')).toHaveText(`${TEXT.length}/4000 caracteres`);
    await page.screenshot({ path: testInfo.outputPath('01-drawer-instrucciones-emergencia.png') });
    await expect(page.getByTestId('patient-clinical-edit-drawer')).toHaveScreenshot('emerg-drawer.png', { maxDiffPixelRatio: 0.05 });
    await page.getByTestId('pce-save').click();
    await expect(page.getByTestId('patient-clinical-edit-drawer')).toHaveCount(0, { timeout: 15_000 });

    await expect(page.getByTestId('emergency-instructions-text')).toHaveText(TEXT, { timeout: 15_000 });
    const edited = page.getByTestId('emergency-instructions-edited');
    await expect(edited).toContainText(STAFF_NAME);
    await expect(edited).toContainText(/Última edición/);
    await page.screenshot({ path: testInfo.outputPath('02-ficha-instrucciones-emergencia.png') });
    await expect(box).toHaveScreenshot('emerg-ficha.png', { maxDiffPixelRatio: 0.05 });

    const row = runSQL(`SELECT emergency_instructions_updated_by || '|' || (emergency_instructions_updated_at > NOW() - INTERVAL '2 minutes')::text || '|' || (emergency_instructions = E'${TEXT.replace(/\n/g, '\\n')}')::text || '|' || COALESCE(diagnosis, '<NULL>') FROM patients WHERE id = '${patientId}'`);
    expect(row).toBe(`${uid}|true|true|F84.0 TEA`);
  });

  test('editar OUTRO campo clínico não reescreve o texto nem a autoria das instruções', async ({ page }) => {
    await loginAsRealStaff(page);
    const before = runSQL(`SELECT emergency_instructions_updated_at::text FROM patients WHERE id = '${patientId}'`);
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('edit-clinical-btn').click();
    await page.getByTestId('pce-device').fill('Silla de ruedas');
    await page.getByTestId('pce-save').click();
    await expect(page.getByTestId('patient-clinical-edit-drawer')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId('emergency-instructions-edited')).toContainText(STAFF_NAME, { timeout: 15_000 });
    expect(runSQL(`SELECT emergency_instructions_updated_at::text FROM patients WHERE id = '${patientId}'`)).toBe(before);
    expect(runSQL(`SELECT (emergency_instructions = E'${TEXT.replace(/\n/g, '\\n')}')::text FROM patients WHERE id = '${patientId}'`)).toBe('true');
  });
});
