/**
 * funil-vacante-lancamento-rascunho.integration.e2e.ts @integration
 *
 * P11 (Fase 6, cadeia-paciente-vacante-itinerario), reescrito pela D469 (Gabriel, 02/10/2026) —
 * 2 testes independentes, sem `describe.serial` (DX-6.9):
 *
 * (1) `foguete-move-para-busqueda`: o foguete (`activate-recruitment`) cria a vaga em RASCUNHO
 *     (`is_draft = true`) E move o paciente do funil para Búsqueda — na API, na coluna do Kanban
 *     do paciente e na trilha (`patient_status_history.change_source = 'recruitment_activation'`);
 *     sem chamar a Talentum (o stub fica em 0 chamadas) e sem gerar match.
 * (2) `kanban-arrasto-admision-busqueda-funciona`: arrastar o card de Admisión para Búsqueda
 *     passa (200) e grava `change_source = 'kanban'`. Controle negativo: o PUT /status do select
 *     da ficha (`changeSource: 'admin_panel'`) continua 422 para o mesmo par.
 */

import { test, expect } from '@playwright/test';
import {
  startTalentumStub,
  seedLaunchablePatient,
  clickFoguete,
  readPatientKanbanColumn,
  backendUrl,
  mockAdminUserFor,
  useLancamentoStaff,
} from '../helpers/lancamento-e2e-helper';
import { readPatientStatusApi } from '../helpers/funnel-move-e2e-helper';
import { readFunnelApi } from '../helpers/compativeis-e2e-helper';
import { loginAs, tokenFor } from '../helpers/abac-stack-helper';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { lastStatusChangeSource } from '../helpers/cadeia-completa-e2e-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';

const MOCK_ADMIN_USER = mockAdminUserFor('rascunho');

/** Conta TODAS as linhas de `patient_status_history` do paciente (não filtra `change_source`). */
function countHistory(patientId: string): number {
  return Number(runSQL(`SELECT count(*) FROM patient_status_history WHERE patient_id = '${patientId}'`).trim());
}

test.describe('funil-vacante lancamento rascunho @integration', () => {
  test.use({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  test.setTimeout(90_000);

  // `loginAs` faz login de verdade (Firebase Auth Emulator interceptado, mas o profile vai ao
  // backend REAL) — sem a linha em `users`, o profile falha e a tela empurra de volta pro
  // login (molde `_prints-antes-fase-6...ts` P1, `beforeAll`).
  useLancamentoStaff(MOCK_ADMIN_USER, 'E2E Lancamento Rascunho F6');

  // ── (1) o foguete MOVE o paciente para Búsqueda (D469) ──────────────────────────
  test('foguete-move-para-busqueda', async ({ page, request }) => {
    // Coordenada própria do arquivo (DX-6.9) — distinta da usada por P1/P10/P24.
    const LAT = -53.81;
    const LNG = -67.73;

    const token = tokenFor(MOCK_ADMIN_USER);
    const stub = await startTalentumStub();
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });

    try {
      await loginAs(page, MOCK_ADMIN_USER);

      const statusBefore = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusBefore, 'status antes do foguete').toBe('ADMISSION');

      const columnBefore = await readPatientKanbanColumn(page, patient.patientId);
      expect(columnBefore, 'coluna antes do foguete').toBe('ADMISSION');

      const h0 = countHistory(patient.patientId);

      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);

      const statusAfter = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusAfter, 'status depois do foguete').toBe('SEARCHING');

      const columnAfter = await readPatientKanbanColumn(page, patient.patientId);
      expect(columnAfter, 'coluna depois do foguete').toBe('SEARCHING');
      if (process.env.PRINT_DIR) {
        const card = page.getByTestId(`patient-kanban-card-${patient.patientId}`);
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.PRINT_DIR}/kanban-depois-do-foguete.png`, fullPage: true });
      }

      const isDraft = runSQL(`SELECT is_draft FROM job_postings WHERE id = '${vacancyId}'`).trim();
      expect(isDraft, 'job_postings.is_draft depois do foguete').toBe('t');

      const h1 = countHistory(patient.patientId);
      expect(h1, 'trilha do paciente ganhou exatamente 1 linha (o movimento do foguete)').toBe(h0 + 1);
      expect(lastStatusChangeSource(patient.patientId), 'change_source da linha do foguete').toBe('recruitment_activation');

      expect(stub.calls.length, 'chamadas ao stub da Talentum').toBe(0);

      const funnel = (await readFunnelApi(request, token, vacancyId)) as {
        stages: Record<string, Array<{ workerId?: string | null }>>;
      };
      const compatibleCount = funnel.stages?.COMPATIBLE?.length ?? 0;
      expect(compatibleCount, 'stages.COMPATIBLE na criação (esperado: nenhum match)').toBe(0);

      console.log('[d469] foguete-move-para-busqueda', {
        vacancyId,
        patientId: patient.patientId,
        statusBefore,
        statusAfter,
        columnBefore,
        columnAfter,
        isDraft,
        h0,
        h1,
        stubCalls: stub.calls.length,
        compatibleCount,
      });
    } finally {
      await stub.close();
      patient.cleanup();
    }
  });

  // ── (2) arrasto Admisión → Búsqueda funciona (D469) ─────────────────────────────
  test('kanban-arrasto-admision-busqueda-funciona', async ({ page, request }) => {
    const token = tokenFor(MOCK_ADMIN_USER);
    const lastName = `LancamentoKanban-${Date.now()}`;
    const { patientId } = insertTestPatient({ status: 'ADMISSION', firstName: 'E2E', lastName });
    const { patientId: controlId } = insertTestPatient({ status: 'ADMISSION', firstName: 'E2E', lastName: `${lastName}-ctl` });

    try {
      await loginAs(page, MOCK_ADMIN_USER);
      await page.goto('/admin/patients/kanban');
      await expect(page.locator('[data-testid="patient-kanban-board"]')).toBeVisible({ timeout: 20_000 });

      const card = page.getByTestId(`patient-kanban-card-${patientId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.scrollIntoViewIfNeeded();

      const searchingColumn = page.locator('[data-testid="kanban-column-SEARCHING"]');
      const [movedResp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'PUT' && /\/status$/.test(r.url())),
        dndKitDrag(page, card, searchingColumn),
      ]);
      expect(movedResp.status(), 'PUT /status arrasto Admisión→Búsqueda').toBe(200);

      const columnAfter = await readPatientKanbanColumn(page, patientId);
      expect(columnAfter, 'coluna depois do arrasto').toBe('SEARCHING');
      const statusAfter = await readPatientStatusApi(request, backendUrl(), token, patientId);
      expect(statusAfter, 'status depois do arrasto').toBe('SEARCHING');
      expect(lastStatusChangeSource(patientId), 'change_source do arrasto').toBe('kanban');

      // Controle negativo: o MESMO par pelo select da ficha (`admin_panel`) continua recusado.
      const refused = await request.put(`${backendUrl()}/api/admin/patients/${controlId}/status`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { status: 'SEARCHING', changeSource: 'admin_panel' },
      });
      expect(refused.status(), 'PUT /status admin_panel Admisión→Búsqueda').toBe(422);
      const statusControl = await readPatientStatusApi(request, backendUrl(), token, controlId);
      expect(statusControl, 'paciente de controle continua em Admisión').toBe('ADMISSION');

      console.log('[d469] kanban-arrasto-admision-busqueda-funciona', {
        patientId,
        movedStatus: movedResp.status(),
        columnAfter,
        statusAfter,
        refusedStatus: refused.status(),
      });
    } finally {
      cleanupTestPatient(patientId);
      cleanupTestPatient(controlId);
    }
  });
});
