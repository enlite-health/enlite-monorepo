/**
 * funil-vacante-lancamento-rascunho.integration.e2e.ts @integration
 *
 * P11 (Fase 6, cadeia-paciente-vacante-itinerario) — 2 testes independentes, sem
 * `describe.serial` (DX-6.9):
 *
 * (1) `lancamento-rascunho-nao-move` (critério 3): o foguete (`activate-recruitment`) cria a
 *     vaga em RASCUNHO (`is_draft = true`) mas NÃO move o paciente — nem na API, nem na coluna
 *     do Kanban do paciente (evidência DX-6.13), nem na trilha (`patient_status_history`), nem
 *     chamando a Talentum (o stub fica em 0 chamadas), nem gerando match.
 * (2) `lancamento-kanban-manual-continua-recusado` (guarda da DX-6.4 na tela, alternativo do
 *     Kanban do paciente): arrastar o card de Admisión para Búsqueda continua 422 — a migration
 *     479 abriu a transição no catálogo só para `changeSource: 'vacancy_launch'`, nunca para o
 *     arrasto manual (`changeSource: 'kanban'`). Controle positivo: o mesmo card para
 *     Pendiente de Admisión (movimento livre dentro do funil) segue valendo.
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

  // ── (1) o foguete NÃO move o paciente (critério 3) ──────────────────────────────
  test('lancamento-rascunho-nao-move', async ({ page, request }) => {
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
      expect(statusAfter, 'status depois do foguete').toBe('ADMISSION');

      const columnAfter = await readPatientKanbanColumn(page, patient.patientId);
      expect(columnAfter, 'coluna depois do foguete').toBe('ADMISSION');
      if (process.env.PRINT_DIR) {
        const card = page.getByTestId(`patient-kanban-card-${patient.patientId}`);
        await card.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${process.env.PRINT_DIR}/kanban-depois-do-foguete.png`, fullPage: true });
      }

      const isDraft = runSQL(`SELECT is_draft FROM job_postings WHERE id = '${vacancyId}'`).trim();
      expect(isDraft, 'job_postings.is_draft depois do foguete').toBe('t');

      const h1 = countHistory(patient.patientId);
      expect(h1, 'trilha do paciente ganhou linha nova (esperado: nenhuma)').toBe(h0);

      expect(stub.calls.length, 'chamadas ao stub da Talentum').toBe(0);

      const funnel = (await readFunnelApi(request, token, vacancyId)) as {
        stages: Record<string, Array<{ workerId?: string | null }>>;
      };
      const compatibleCount = funnel.stages?.COMPATIBLE?.length ?? 0;
      expect(compatibleCount, 'stages.COMPATIBLE na criação (esperado: nenhum match)').toBe(0);

      console.log('[6.3] lancamento-rascunho-nao-move', {
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

  // ── (2) arrasto manual continua recusado (guarda da DX-6.4 na tela) ─────────────
  test('lancamento-kanban-manual-continua-recusado', async ({ page, request }) => {
    const token = tokenFor(MOCK_ADMIN_USER);
    const lastName = `LancamentoKanban-${Date.now()}`;
    const { patientId } = insertTestPatient({ status: 'ADMISSION', firstName: 'E2E', lastName });

    try {
      await loginAs(page, MOCK_ADMIN_USER);
      await page.goto('/admin/patients/kanban');
      await expect(page.locator('[data-testid="patient-kanban-board"]')).toBeVisible({ timeout: 20_000 });

      const card = page.getByTestId(`patient-kanban-card-${patientId}`);
      await expect(card).toBeVisible({ timeout: 15_000 });
      await card.scrollIntoViewIfNeeded();

      // Arrasto recusado: Admisión → Búsqueda (só o lançamento pode usar essa transição, DX-6.4).
      const searchingColumn = page.locator('[data-testid="kanban-column-SEARCHING"]');
      const [rejectedResp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'PUT' && /\/status$/.test(r.url())),
        dndKitDrag(page, card, searchingColumn),
      ]);
      expect(rejectedResp.status(), 'PUT /status arrasto manual Admisión→Búsqueda').toBe(422);

      await expect(page.getByText('Ese cambio de estado no está permitido.')).toBeVisible({ timeout: 8_000 });

      const columnAfterReject = await readPatientKanbanColumn(page, patientId);
      expect(columnAfterReject, 'coluna depois do arrasto recusado').toBe('ADMISSION');

      const statusAfterReject = await readPatientStatusApi(request, backendUrl(), token, patientId);
      expect(statusAfterReject, 'status depois do arrasto recusado').toBe('ADMISSION');

      // Controle positivo: o MESMO card, movimento livre dentro do catálogo (Admisión → Alta,
      // `patient_status_transitions` tem a linha ADMISSION|ALTA, sem guarda de changeSource)
      // continua permitido — prova que a recusa acima é da guarda da DX-6.4, não de um bloqueio
      // geral do drag. DESVIO DO PASSO: o texto do passo cita "Pendiente de Admisión" como
      // destino do controle, mas `patient_status_transitions` (conferido na stack `cadeia-f6`)
      // não tem NENHUMA linha ADMISSION↔PENDING_ADMISSION em qualquer sentido — esse arrasto
      // devolveria 422 e derrubaria o controle positivo. Alta é o único destino livre (sem
      // `changeSource` especial) do catálogo a partir de ADMISSION.
      const cardAgain = page.getByTestId(`patient-kanban-card-${patientId}`);
      await cardAgain.scrollIntoViewIfNeeded();
      const altaColumn = page.locator('[data-testid="kanban-column-ALTA"]');
      const [allowedResp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'PUT' && /\/status$/.test(r.url())),
        dndKitDrag(page, cardAgain, altaColumn),
      ]);
      expect(allowedResp.status(), 'PUT /status arrasto livre Admisión→Alta').toBe(200);

      const columnAfterAllowed = await readPatientKanbanColumn(page, patientId);
      expect(columnAfterAllowed, 'coluna depois do arrasto livre').toBe('ALTA');

      console.log('[6.3] lancamento-kanban-manual-continua-recusado', {
        patientId,
        rejectedStatus: rejectedResp.status(),
        allowedStatus: allowedResp.status(),
        columnAfterReject,
        columnAfterAllowed,
      });
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
