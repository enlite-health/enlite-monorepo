/**
 * patient-status-suspendido-saida-motivo.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK: navegador real → worker-functions real (Docker) → Postgres real →
 * auth pelo mock do stack de CI (`loginComoStaffMock`: click + `keyboard.type`; token `mock_*`, padrão kanban-pacientes).
 *
 * O que prova (migration 486, decisão do Gabriel 29/09/2026 — D444): sair de SUSPENDED por
 * admin_panel/kanban exige motivo fechado (SuspensionExitReason), e a trilha grava motivo + o
 * uid de quem mudou.
 *
 *   1. feliz — Suspendido → Búsqueda COM motivo: select de motivo aparece, "Cambiar" habilita só
 *      depois de escolhido, o PUT sai, e o Historial mostra o rótulo do motivo E o uid do ator;
 *   2. alt1 — trocar de estado saindo de Suspendido SEM motivo: "Cambiar" continua DESABILITADO
 *      (o cliente nem tenta o request — mesmo padrão de `goingOnHold`);
 *   3. alt2 — Suspendido → En espera exige OS DOIS motivos (onHoldReason E suspensionExitReason);
 *      só com os dois preenchidos o botão habilita e o PUT sai.
 *
 * Nenhuma das 3 transições requer serviço/horário: `blockingCodesForStatusChange('SEARCHING'|
 * 'ON_HOLD')` só reprova quando existe SERVIÇO ATIVO sem horário (PatientQueryRepository) — um
 * paciente sem serviço contratado nenhum passa vazio, e por isso a semente não monta um.
 *
 * Pré-requisitos: stack `docker compose … up -d postgres api` com USE_MOCK_AUTH=true (worker-functions)
 * + `pnpm dev` (enlite-frontend).
 */

import { test, expect } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';

const STAFF: MockUser = { uid: 'e2e-int-admin-486-ficha', email: 'admin.486.ficha@e2e.test', role: 'admin', country: 'AR' };
const STAMP = Date.now().toString().slice(-6);

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Saída de SUSPENDED com motivo (migration 486, decisão do Gabriel 29/09/2026) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('feliz: Suspendido → Búsqueda com motivo — Historial mostra o motivo e o autor', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Feliz', lastName: `Paciente${STAMP}` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D486');
      const actorUid = STAFF.uid; // principal.id do token mock (AuthMiddleware.ts:156-157)
      await page.goto(`/admin/patients/${patientId}`);

      const select = page.getByTestId('patient-status-select');
      await expect(select).toBeVisible({ timeout: 30_000 });
      await select.selectOption('SEARCHING');

      const exitReason = page.getByTestId('patient-status-exit-reason');
      await expect(exitReason).toBeVisible();
      const save = page.getByTestId('patient-status-save');
      await expect(save).toBeDisabled();

      await exitReason.selectOption('RESUMED_SERVICE');
      await expect(save).toBeEnabled();
      await expect(page).toHaveScreenshot('d486-feliz-motivo-selecionado.png', { maxDiffPixelRatio: 0.05 });
      await save.click();
      await expect(page.getByTestId('patient-status-error')).toHaveCount(0);

      // banco: status mudou, e a history tem a linha com reason + actor_uid
      await expect.poll(() => runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`).trim()).toBe('SEARCHING');
      const histRow = runSQL(
        `SELECT old_value || '|' || new_value || '|' || COALESCE(reason,'<NULL>') || '|' || COALESCE(actor_uid,'<NULL>')
           FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC LIMIT 1`,
      );
      expect(histRow).toBe(`SUSPENDED|SEARCHING|RESUMED_SERVICE|${actorUid}`);

      // Historial EM TELA: o rótulo traduzido do motivo + o uid cru do ator.
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Historial' }).click();
      const card = page.getByTestId('patient-status-history-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText('Retomó el servicio (fin de vacaciones/internación)');
      await expect(card).toContainText(actorUid);
      await expect(page).toHaveScreenshot('d486-feliz-historial.png', { fullPage: true, maxDiffPixelRatio: 0.05 });
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt1: sair de Suspendido sem motivo — "Cambiar" fica desabilitado, nenhum PUT sai', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Alt1', lastName: `Paciente${STAMP}` });
    try {
      let putChamado = false;
      // Rede como SEGUNDA prova (a primeira, load-bearing, é o `toBeDisabled()` abaixo): um
      // botão HTML `disabled` não recebe clique nem por trás de um `route` que continuasse a
      // deixar passar — se algum dia o disabled virar só visual (CSS), isto acusa.
      await page.route('**/api/admin/patients/*/status', (route) => {
        putChamado = true;
        return route.continue();
      });
      await loginComoStaffMock(page, STAFF, 'E2E D486');
      await page.goto(`/admin/patients/${patientId}`);

      const select = page.getByTestId('patient-status-select');
      await expect(select).toBeVisible({ timeout: 30_000 });
      await select.selectOption('REPLACEMENT');

      const exitReason = page.getByTestId('patient-status-exit-reason');
      await expect(exitReason).toBeVisible();
      const save = page.getByTestId('patient-status-save');
      await expect(save).toBeDisabled();
      await expect(page).toHaveScreenshot('d486-alt1-sem-motivo-desabilitado.png', { maxDiffPixelRatio: 0.05 });

      expect(putChamado).toBe(false);
      const status = runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`).trim();
      expect(status).toBe('SUSPENDED');
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt2: Suspendido → En espera exige OS DOIS motivos (espera + saída) — só habilita com os dois', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Alt2', lastName: `Paciente${STAMP}` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D486');
      await page.goto(`/admin/patients/${patientId}`);

      const select = page.getByTestId('patient-status-select');
      await expect(select).toBeVisible({ timeout: 30_000 });
      await select.selectOption('ON_HOLD');

      const waitReason = page.getByTestId('patient-status-reason');
      const exitReason = page.getByTestId('patient-status-exit-reason');
      const save = page.getByTestId('patient-status-save');
      await expect(waitReason).toBeVisible();
      await expect(exitReason).toBeVisible();
      await expect(save).toBeDisabled();

      // só o motivo de espera: continua desabilitado (falta o de saída de SUSPENDED)
      await waitReason.selectOption('SCHOOL');
      await expect(save).toBeDisabled();

      // só o de saída (limpando o de espera não é uma opção real — o de espera é obrigatório
      // independente de SUSPENDED): com os dois, habilita.
      await exitReason.selectOption('OTHER');
      await expect(save).toBeEnabled();
      await expect(page).toHaveScreenshot('d486-alt2-dois-motivos.png', { maxDiffPixelRatio: 0.05 });
      await save.click();
      await expect(page.getByTestId('patient-status-error')).toHaveCount(0);

      await expect.poll(() => runSQL(`SELECT status, on_hold_reason FROM patients WHERE id = '${patientId}'`).trim()).toBe('ON_HOLD|SCHOOL');
      const reason = runSQL(`SELECT reason FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC LIMIT 1`).trim();
      expect(reason).toBe('OTHER');
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
