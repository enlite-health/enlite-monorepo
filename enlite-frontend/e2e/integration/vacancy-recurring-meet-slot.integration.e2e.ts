/**
 * vacancy-recurring-meet-slot.integration.e2e.ts @integration — D211.4
 *
 * PONTA A PONTA SEM MOCK DE API: navegador real → worker-functions real (imagem
 * desta branch, migration 291) → Postgres real → Firebase Auth EMULATOR real.
 *
 * O que prova:
 *   - na ficha da vaga, o card de Meet ganha o "horario recurrente" (día + hora + sala);
 *   - salvar grava `meet_recurring_weekday/time/link` na vaga (lido no banco) e a
 *     linha de datas mostra a pill "Todos los lunes a las 08:30" com o link da sala;
 *   - limpar os três campos e salvar zera as colunas (Merge Patch: `null` limpa);
 *   - `toHaveScreenshot` do card e da linha (visual) + vídeo/prints para a task.
 */
import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient, insertBaseVacancy, cleanupVacancies } from '../helpers/db-test-helper';

const EMULATOR = 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.slot.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const ROOM = 'https://meet.google.com/rec-urri-ngx';
const CASE_NUMBER = 99980 + Math.floor(Math.random() * 10);

function runSQL(sql: string): string {
  return execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

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
  runSQL(`INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E Slot Admin', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 45_000 });
}

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Vaga: horário recorrente da reunión de presentación (D211.4) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let patientId = '';
  let vacancyId = '';

  test.beforeAll(() => {
    const p = insertTestPatient({ firstName: 'Paciente', lastName: `Slot${Date.now().toString().slice(-5)}`, withAddress: true, addressLat: -34.6037, addressLng: -58.3816 });
    patientId = p.patientId;
    vacancyId = insertBaseVacancy({ patientId, patientAddressId: p.addressId as string, caseNumber: CASE_NUMBER, status: 'SEARCHING', isDraft: false });
  });

  test.afterAll(() => {
    cleanupVacancies([vacancyId]);
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('definir "lunes 08:30 + sala" → salva na vaga → pill na linha de datas → limpar zera', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);
    await page.goto(`/admin/vacancies/${vacancyId}`);
    // O card de Meet vive na aba "Links" da ficha
    await page.getByRole('button', { name: /^Links$/ }).click({ timeout: 30_000 });

    const card = page.getByTestId('vacancy-meet-links-card');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('meet-recurring-pill')).toHaveCount(0);
    expect(runSQL(`SELECT meet_recurring_weekday IS NULL FROM job_postings WHERE id = '${vacancyId}'`)).toBe('t');

    await page.getByTestId('meet-recurring-weekday').selectOption('1');
    await page.getByTestId('meet-recurring-time').fill('08:30');
    await page.getByTestId('meet-recurring-link').fill(ROOM);
    await page.screenshot({ path: testInfo.outputPath('01-card-recorrente-preenchido.png'), fullPage: false });
    await expect(card).toHaveScreenshot('slot-recorrente-card.png', { maxDiffPixelRatio: 0.05 });

    await page.getByTestId('meet-links-save').click();
    // Depois de salvar, `onSaved` refaz o fetch da vaga e a página remonta (o card da aba
    // Links some com o feedback). A prova é o BANCO e a pill na linha de datas.
    await expect.poll(() => runSQL(`SELECT COALESCE(meet_recurring_weekday::text, '') || '|' || COALESCE(meet_recurring_time::text, '') || '|' || COALESCE(meet_recurring_link, '') FROM job_postings WHERE id = '${vacancyId}'`), { timeout: 15_000 })
      .toBe(`1|08:30:00|${ROOM}`);

    // Tela: a linha de datas mostra a pill com o dia, a hora e o link da sala
    const pill = page.getByTestId('meet-recurring-pill');
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(pill).toContainText('lunes');
    await expect(pill).toContainText('08:30');
    await expect(pill).toHaveAttribute('href', ROOM);
    await page.screenshot({ path: testInfo.outputPath('02-pill-recorrente-na-vaga.png'), fullPage: false });
    await expect(pill).toHaveScreenshot('slot-recorrente-pill.png', { maxDiffPixelRatio: 0.05 });

    // Limpar os três → null nas colunas (Merge Patch: null limpa). A página remontou: reabrir a aba.
    await page.getByRole('button', { name: /^Links$/ }).click({ timeout: 30_000 });
    await expect(page.getByTestId('meet-recurring-weekday')).toHaveValue('1', { timeout: 15_000 });
    await page.getByTestId('meet-recurring-weekday').selectOption('');
    await page.getByTestId('meet-recurring-time').fill('');
    await page.getByTestId('meet-recurring-link').fill('');
    await page.getByTestId('meet-links-save').click();
    await expect(page.getByTestId('meet-recurring-pill')).toHaveCount(0, { timeout: 15_000 });
    expect(runSQL(`SELECT (meet_recurring_weekday IS NULL AND meet_recurring_time IS NULL AND meet_recurring_link IS NULL)::text FROM job_postings WHERE id = '${vacancyId}'`)).toBe('true');
  });

  test('recorrente incompleto não salva: erro na tela e banco intacto', async ({ page }) => {
    await loginAsRealStaff(page);
    await page.goto(`/admin/vacancies/${vacancyId}`);
    await page.getByRole('button', { name: /^Links$/ }).click({ timeout: 30_000 });
    await expect(page.getByTestId('vacancy-meet-links-card')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('meet-recurring-weekday').selectOption('3');
    await page.getByTestId('meet-links-save').click();
    await expect(page.getByTestId('meet-recurring-error')).toBeVisible();
    expect(runSQL(`SELECT meet_recurring_weekday IS NULL FROM job_postings WHERE id = '${vacancyId}'`)).toBe('t');
  });
});
