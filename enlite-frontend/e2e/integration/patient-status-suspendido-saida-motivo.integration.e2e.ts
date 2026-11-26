/**
 * patient-status-suspendido-saida-motivo.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK DE DADO: navegador real → worker-functions real (Docker) → Postgres real →
 * auth pelo mock do stack de CI (`loginComoStaffMock`: click + `keyboard.type`; token `mock_*`, padrão kanban-pacientes).
 *
 * O que prova (migration 486, decisão do Gabriel 29/09/2026 — D444; reescrito na F5 de estado-automatico-do-paciente, que tirou o select
 * livre): sair de SUSPENDED por uma ação humana exige motivo fechado (SuspensionExitReason), e a trilha grava motivo + o uid de quem agiu.
 *
 *   1. feliz — Suspendido → "Retomar" COM motivo: o campo de motivo aparece, "Confirmar" habilita só depois de escolhido, a ação sai, o estado
 *      é RE-DERIVADO (Búsqueda, sem itinerário) com origem `resume`, e o Historial mostra o rótulo do motivo E o uid do ator;
 *   2. alt1 — "Retomar" sem motivo: "Confirmar" continua DESABILITADO e nenhuma chamada de escrita sai (o cliente nem tenta);
 *   3. alt2 — Suspendido → "Pausar" exige OS DOIS motivos (espera + saída); só com os dois o botão habilita e a ação sai.
 *
 * Nenhuma das transições requer serviço/horário (paciente sem serviço contratado algum passa vazio na completude).
 * Gestos humanos: `click`, foco, `keyboard.type`; valores lidos da tela. Sem `page.route` de dado.
 *
 * Pré-requisitos: stack `docker compose … up -d postgres api` com USE_MOCK_AUTH=true (worker-functions) + `pnpm dev` (enlite-frontend).
 */

import { test, expect } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';

const STAFF: MockUser = { uid: 'e2e-int-admin-486-ficha', email: 'admin.486.ficha@e2e.test', role: 'admin', country: 'AR' };
const STAMP = Date.now().toString().slice(-6);
const MOTIVO_RETOMOU = 'Retomó el servicio (fin de vacaciones/internación)'; // RESUMED_SERVICE

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Saída de SUSPENDED com motivo (migration 486, decisão do Gabriel 29/09/2026) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('feliz: Suspendido → Retomar com motivo — Historial mostra o motivo e o autor', async ({ page }, testInfo) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Feliz', lastName: `Paciente${STAMP} QA` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D486');
      const actorUid = STAFF.uid; // principal.id do token mock (AuthMiddleware.ts:156-157)
      await page.goto(`/admin/patients/${patientId}`);

      // F5: não há select livre — só as ações que o servidor lista.
      await expect(page.getByTestId('patient-status-select')).toHaveCount(0);
      await page.getByTestId('patient-status-action-retomar').click({ timeout: 30_000 });

      const exitReason = page.getByTestId('patient-status-action-exit-reason');
      await expect(exitReason).toBeVisible();
      const confirmar = page.getByTestId('patient-status-action-confirm');
      await expect(confirmar).toBeDisabled();

      await escolherNoCombo(page, exitReason, MOTIVO_RETOMOU);
      await expect(confirmar).toBeEnabled();
      await testInfo.attach('motivo-selecionado', { body: await page.screenshot(), contentType: 'image/png' });
      await confirmar.click();
      await expect(page.getByTestId('patient-status-action-error')).toHaveCount(0);
      await expect(page.getByTestId('patient-status-badge')).toContainText('Búsqueda', { timeout: 20_000 }); // re-derivado, lido da TELA

      // banco: status mudou, e a history tem a linha com reason + actor_uid + origem `resume`
      await expect.poll(() => runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`).trim()).toBe('SEARCHING');
      const histRow = runSQL(
        `SELECT old_value || '|' || new_value || '|' || change_source || '|' || COALESCE(reason,'<NULL>') || '|' || COALESCE(actor_uid,'<NULL>')
           FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).trim();
      expect(histRow).toBe(`SUSPENDED|SEARCHING|resume|RESUMED_SERVICE|${actorUid}`);

      // Historial EM TELA: o rótulo traduzido do motivo + o uid cru do ator.
      await page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Historial' }).click();
      const card = page.getByTestId('patient-status-history-card');
      await expect(card).toBeVisible();
      await expect(card).toContainText(MOTIVO_RETOMOU);
      await expect(card).toContainText(actorUid);
      await testInfo.attach('historial', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt1: Retomar sem motivo de saída — "Confirmar" fica desabilitado, nenhuma escrita sai', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Alt1', lastName: `Paciente${STAMP} QA` });
    try {
      const escritas: string[] = [];
      page.on('request', (r) => {
        if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method()) && /\/api\/admin\/patients\//.test(r.url())) escritas.push(`${r.method()} ${r.url()}`);
      });
      await loginComoStaffMock(page, STAFF, 'E2E D486');
      await page.goto(`/admin/patients/${patientId}`);

      await page.getByTestId('patient-status-action-retomar').click({ timeout: 30_000 });
      await expect(page.getByTestId('patient-status-action-exit-reason')).toBeVisible();
      await expect(page.getByTestId('patient-status-action-confirm')).toBeDisabled();

      expect(escritas, 'nenhuma escrita sai da ficha').toEqual([]);
      expect(runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`).trim()).toBe('SUSPENDED');
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt2: Suspendido → Pausar exige OS DOIS motivos (espera + saída) — só habilita com os dois', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Alt2', lastName: `Paciente${STAMP} QA` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D486');
      await page.goto(`/admin/patients/${patientId}`);

      await page.getByTestId('patient-status-action-pausar').click({ timeout: 30_000 });
      const waitReason = page.getByTestId('patient-status-action-reason');
      const exitReason = page.getByTestId('patient-status-action-exit-reason');
      const confirmar = page.getByTestId('patient-status-action-confirm');
      await expect(waitReason).toBeVisible();
      await expect(exitReason).toBeVisible();
      await expect(confirmar).toBeDisabled();

      // só o motivo de espera: continua desabilitado (falta o de saída de SUSPENDED)
      await escolherNoCombo(page, waitReason, 'Escuela'); // SCHOOL
      await expect(confirmar).toBeDisabled();

      // com os dois, habilita
      await escolherNoCombo(page, exitReason, 'Otro'); // OTHER
      await expect(confirmar).toBeEnabled();
      await confirmar.click();
      await expect(page.getByTestId('patient-status-action-error')).toHaveCount(0);

      await expect.poll(() => runSQL(`SELECT status, on_hold_reason FROM patients WHERE id = '${patientId}'`).trim()).toBe('ON_HOLD|SCHOOL');
      const reason = runSQL(`SELECT reason FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`).trim();
      expect(reason).toBe('OTHER');
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
