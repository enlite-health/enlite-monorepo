/**
 * patient-status-aguardando-financeiro.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK: navegador real → worker-functions real (Docker) →
 * Postgres real → Firebase Auth EMULATOR real. Nenhum `page.route`.
 *
 * O que prova (D195, 26/08 — "o estado leva o nome do motivo real da espera"):
 *   - o estado de paciente PENDING_ADMISSION aparece como "Esperando financiero"
 *     na coluna do Kanban de pacientes E no badge da ficha (antes: "Esperando
 *     Activación" no Kanban e "En Admisión" na ficha — dois nomes para o mesmo estado);
 *   - o status de VAGA "Activación Pendiente" não é tocado (fora deste teste).
 *
 * Pré-requisitos: stack `docker compose … up -d postgres firebase-emulator api`
 * (worker-functions) + `pnpm dev` com VITE_FIREBASE_AUTH_EMULATOR=http://localhost:9099.
 */

import { test, expect, type Page } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';

// `E2E_FIREBASE_EMULATOR` aponta para o emulador de um stack isolado (`docker compose -p`); default inalterado.
const EMULATOR = process.env.E2E_FIREBASE_EMULATOR || 'http://127.0.0.1:9099';
const EMULATOR_PROJECT = 'demo-no-project';
const STAFF_EMAIL = `e2e.d195.${Date.now()}@enlite.health`;
const STAFF_PASSWORD = 'TestAdmin123!';
const PATIENT_LAST = `D195-${Date.now().toString().slice(-5)}`;

function runSQL(sql: string): string {
  return execSync(
    `docker exec ${process.env.E2E_PG_CONTAINER || 'enlite-postgres'} psql -U enlite_admin -d enlite_e2e -tAc "${sql.replace(/"/g, '\\"')}"`,
    { encoding: 'utf-8' },
  ).trim();
}

/** Staff real: conta no emulador + claim de papel + linha em `users`; login pela UI. */
async function loginAsRealStaff(page: Page): Promise<void> {
  const res = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=any`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD, returnSecureToken: true }),
  });
  expect(res.ok, `signUp no emulador falhou: ${res.status}`).toBe(true);
  const { localId } = (await res.json()) as { localId: string };
  const claims = await fetch(`${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/${EMULATOR_PROJECT}/accounts:update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role: 'admin' }) }),
  });
  expect(claims.ok).toBe(true);
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, email_verified) ` +
      `VALUES ('${localId}', '${STAFF_EMAIL}', 'E2E D195', 'admin', true, true) ON CONFLICT (firebase_uid) DO NOTHING`,
  );

  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'es'));
  await page.goto('/admin/login');
  await page.locator('input[type="email"]').fill(STAFF_EMAIL);
  await page.locator('input[type="password"]').fill(STAFF_PASSWORD);
  await page.getByRole('button', { name: /Iniciar sesi/i }).click();
  await expect(page).not.toHaveURL(/login/, { timeout: 30_000 });
}

test.use({ viewport: { width: 1600, height: 900 }, video: 'on' });

test.describe('Estado do paciente PENDING_ADMISSION = "Esperando financiero" (D195) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  let patientId = '';

  test.beforeAll(() => {
    patientId = insertTestPatient({ status: 'PENDING_ADMISSION', firstName: 'Paciente', lastName: PATIENT_LAST, withAddress: true }).patientId;
  });

  test.afterAll(() => {
    cleanupTestPatient(patientId);
    runSQL(`DELETE FROM users WHERE email = '${STAFF_EMAIL}'`);
  });

  test('Kanban de pacientes e ficha mostram "Esperando financiero" (nunca mais "Esperando Activación"/"En Admisión")', async ({ page }, testInfo) => {
    await loginAsRealStaff(page);

    // ── Kanban de pacientes ────────────────────────────────────────────────
    await page.goto('/admin/patients/kanban');
    await expect(page.getByText(`Paciente ${PATIENT_LAST}`)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Esperando financiero', { exact: true })).toBeVisible();
    await expect(page.getByText('Esperando Activación')).toHaveCount(0);
    await expect(page).toHaveScreenshot('d195-kanban-esperando-financiero.png', { fullPage: true, maxDiffPixelRatio: 0.05 });
    await page.screenshot({ path: testInfo.outputPath('01-kanban-esperando-financiero.png'), fullPage: true });

    // ── Ficha do paciente ─────────────────────────────────────────────────
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByText(`Paciente ${PATIENT_LAST}`).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('Esperando financiero', { exact: true })).toBeVisible();
    await expect(page.getByText('En Admisión', { exact: true })).toHaveCount(0);
    await expect(page).toHaveScreenshot('d195-ficha-esperando-financiero.png', { fullPage: true, maxDiffPixelRatio: 0.05 });
    await page.screenshot({ path: testInfo.outputPath('02-ficha-esperando-financiero.png'), fullPage: true });
  });
});
