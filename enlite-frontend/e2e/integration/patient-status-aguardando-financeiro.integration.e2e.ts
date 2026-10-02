/**
 * patient-status-aguardando-financeiro.integration.e2e.ts @integration
 *
 * PONTA A PONTA, com login MOCK: navegador real → worker-functions real (Docker) →
 * Postgres real. O login é o do stack de CI (`loginComoStaffMock`: click + `keyboard.type`,
 * token `mock_*`, `/auth/profile` mockado); o resto (Kanban, ficha, API, banco) é real.
 * Antes o login era real no emulador do Firebase (`fill()`) e nunca saía de `/admin/login` no CI.
 *
 * O que prova (D195, 26/08 — "o estado leva o nome do motivo real da espera"):
 *   - o estado de paciente PENDING_ADMISSION aparece como "Esperando financiero"
 *     na coluna do Kanban de pacientes E no badge da ficha (antes: "Esperando
 *     Activación" no Kanban e "En Admisión" na ficha — dois nomes para o mesmo estado);
 *   - o status de VAGA "Activación Pendiente" não é tocado (fora deste teste).
 *
 * Pré-requisitos: stack `docker compose … up -d postgres api` com USE_MOCK_AUTH=true
 * (worker-functions) + `pnpm dev` (enlite-frontend).
 */

import { test, expect } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';

const STAFF: MockUser = { uid: 'e2e-int-admin-d195', email: 'admin.d195@e2e.test', role: 'admin', country: 'AR' };
const PATIENT_LAST = `D195-${Date.now().toString().slice(-5)}`;

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
  });

  test('Kanban de pacientes e ficha mostram "Esperando financiero" (nunca mais "Esperando Activación"/"En Admisión")', async ({ page }, testInfo) => {
    await loginComoStaffMock(page, STAFF, 'E2E D195');

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
