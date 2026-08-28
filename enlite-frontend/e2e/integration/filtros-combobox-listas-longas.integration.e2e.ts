/**
 * filtros-combobox-listas-longas.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK: navegador real → worker-functions real (Docker) →
 * Postgres real → Firebase Auth EMULATOR real. Nenhum `page.route`.
 *
 * O que prova (REQ-06, planning 26/08 — Javier: "en el combobox, deletreando vas
 * buscando y te va apareciendo la lista de los que coinciden"; Marcel aprovou):
 *   - nos filtros de VAGAS, Provincia/Localidad e os horários são comboboxes
 *     com busca: digitar filtra a lista, escolher aplica o filtro (a request à
 *     API leva o valor) — dados vindos do banco real (filter-options);
 *   - nos filtros de PRESTADORES, Provincia é combobox com busca.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from '../helpers/db-test-helper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.req06.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const STATE = 'Córdoba (E2E req06)';
const CITY = 'Villa Carlos Paz (E2E req06)';

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

async function loginAsRealStaff(page: Page): Promise<void> {
  const res = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  // 2º teste do arquivo reaproveita a conta: o emulador devolve 400 EMAIL_EXISTS → só loga.
  const auth = res.ok
    ? res
    : await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=any`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
      });
  expect(auth.ok, `conta de staff no emulador falhou: ${auth.status}`).toBe(true);
  const { localId } = (await auth.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) ` +
      `VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Req06', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`,
  );
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

test.use({ viewport: { width: 1600, height: 900 }, video: 'on' });

test.describe('Filtros: combobox com busca nas listas longas (REQ-06) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let patientId = '';

  test.beforeAll(() => {
    // Provincia/Localidad das vagas vêm de patient_addresses das vagas listáveis (filter-options).
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true, firstName: 'Paciente', lastName: 'Req06' });
    patientId = pid;
    runSQL(`UPDATE patient_addresses SET state = '${STATE}', city = '${CITY}' WHERE id = '${addressId}'`);
    insertBaseVacancy({ patientId, patientAddressId: addressId!, caseNumber: 90600 + Math.floor(Math.random() * 300), status: 'SEARCHING', isDraft: false });
  });

  test.afterAll(() => {
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('vagas: Provincia filtra ao digitar e aplica; horário via combobox', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await page.goto('/admin/vacancies');
    const province = page.getByTestId('vacancy-filter-province');
    await expect(province).toBeVisible({ timeout: 30_000 });

    // Abre, digita sem acento, a lista filtra para o valor do banco
    await province.click();
    await page.getByPlaceholder('Buscar...').fill('cordoba (e2e');
    await expect(page.getByRole('option', { name: STATE })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('01-vagas-provincia-digitando.png'), fullPage: true });
    await expect(page).toHaveScreenshot('req06-vagas-provincia-busca.png', { fullPage: true, maxDiffPixelRatio: 0.05 });

    const reqWait = page.waitForRequest((req) =>
      req.url().includes('/api/admin/vacancies') && !req.url().includes('filter-options') && !req.url().includes('stats') && req.url().includes('state='),
    );
    await page.getByRole('option', { name: STATE }).click();
    const req = await reqWait;
    expect(new URL(req.url()).searchParams.get('state')).toBe(STATE);
    await expect(province).toContainText(STATE);

    // Horário: 48 opções, digitar "09" filtra
    await page.getByTestId('time-from').click();
    await page.getByPlaceholder('Buscar...').fill('09');
    const times = await page.getByRole('option').allTextContents();
    expect(times.filter((t) => /^\d{2}:\d{2}$/.test(t))).toEqual(['09:00', '09:30']);
    await page.getByRole('option', { name: '09:00' }).click();
    await expect(page.getByTestId('time-from')).toContainText('09:00');
    await page.screenshot({ path: testInfo.outputPath('02-vagas-filtros-aplicados.png'), fullPage: true });
  });

  test('prestadores: Provincia é combobox com busca', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await page.goto('/admin/workers');
    const province = page.getByTestId('filter-province');
    await expect(province).toBeVisible({ timeout: 30_000 });
    await province.click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await expect(page.getByPlaceholder('Buscar...')).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('03-prestadores-provincia-combobox.png'), fullPage: true });
    await expect(page).toHaveScreenshot('req06-prestadores-provincia-combobox.png', { fullPage: true, maxDiffPixelRatio: 0.05 });
  });
});
