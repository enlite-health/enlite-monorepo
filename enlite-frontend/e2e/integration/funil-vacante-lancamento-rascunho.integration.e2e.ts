/**
 * funil-vacante-lancamento-rascunho.integration.e2e.ts @integration
 *
 * P11 (Fase 6, cadeia-paciente-vacante-itinerario), reescrito pela D469 (Gabriel, 02/10/2026) e pela D1/D2 do
 * estado-automatico-do-paciente (26/11/2026) — 3 testes independentes, sem `describe.serial` (DX-6.9):
 *
 * (1) `foguete-move-para-busqueda`: o foguete (`activate-recruitment`) cria a vaga em RASCUNHO
 *     (`is_draft = true`) E move o paciente do funil para Búsqueda — na API, na coluna do Kanban
 *     do paciente e na trilha (`patient_status_history.change_source = 'recruitment_activation'`);
 *     sem chamar a Talentum (o stub fica em 0 chamadas) e sem gerar match.
 * (2) `kanban-sem-arrasto-admision-busqueda-recusado` (F5): o card não é arrastável, o gesto de arrastar para Búsqueda não manda
 *     PUT nenhum e, depois de recarregar, o card segue em Admisión; o PUT /status do mesmo par, pelas origens `kanban` e
 *     `admin_panel`, é 422 PATIENT_STATUS_NOT_MANUAL (o foguete é o único gatilho).
 * (3) `foguete-com-outro-servico-sem-horario-move`: o paciente tem um 2º serviço ATIVO sem horário; o foguete do serviço
 *     COMPLETO cria a vaga e MOVE o paciente (D2: a completude é medida no serviço clicado) — toast de SUCESSO, nenhum aviso.
 */

import { test, expect } from '@playwright/test';
import {
  startTalentumStub,
  seedLaunchablePatient,
  clickFoguete,
  postContractedServiceViaApi,
  readPatientKanbanColumn,
  backendUrl,
  mockAdminUserFor,
  useLancamentoStaff,
} from '../helpers/lancamento-e2e-helper';
import { readPatientStatusApi } from '../helpers/lancamento-leituras-helper';
import { readFunnelApi } from '../helpers/lancamento-leituras-helper';
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

  // ── (2) F5: NÃO existe arrasto Admisión → Búsqueda (o foguete é o único gatilho) ───────────────────────────
  test('kanban-sem-arrasto-admision-busqueda-recusado', async ({ page, request }) => {
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
      // O wrapper do card não tem nenhum atributo de arrasto (aria-roledescription / tabindex do dnd-kit).
      const wrapper = page.getByTestId(`kanban-card-${patientId}`);
      await expect(wrapper).toHaveCount(1);
      await expect(wrapper).not.toHaveAttribute('aria-roledescription', /.+/);

      // Gesto humano de arrastar para "Búsqueda": nenhum PUT sai da página.
      const puts: string[] = [];
      page.on('request', (r) => { if (r.method() === 'PUT' && /\/status$/.test(r.url())) puts.push(r.url()); });
      await dndKitDrag(page, card, page.locator('[data-testid="kanban-column-SEARCHING"]'));
      expect(puts, 'nenhum PUT /status sai do arrasto').toEqual([]);

      const columnAfter = await readPatientKanbanColumn(page, patientId); // recarrega o board
      expect(columnAfter, 'coluna depois do arrasto').toBe('ADMISSION');
      expect(await readPatientStatusApi(request, backendUrl(), token, patientId), 'status depois do arrasto').toBe('ADMISSION');

      // O servidor também recusa, pelas duas origens: a mesma frase, sem escrever nada.
      for (const changeSource of ['kanban', 'admin_panel']) {
        const refused = await request.put(`${backendUrl()}/api/admin/patients/${patientId}/status`, {
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          data: { status: 'SEARCHING', changeSource },
        });
        expect(refused.status(), `PUT /status ${changeSource} Admisión→Búsqueda`).toBe(422);
        expect((await refused.json()).code).toBe('PATIENT_STATUS_NOT_MANUAL');
      }
      expect(await readPatientStatusApi(request, backendUrl(), token, patientId), 'continua em Admisión').toBe('ADMISSION');
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  // ── (3) foguete com outro serviço sem horário: vaga nasce E o paciente MOVE, a tela mostra sucesso (D2) ──
  test('foguete-com-outro-servico-sem-horario-move', async ({ page, request }) => {
    const LAT = -53.83;
    const LNG = -67.71;
    const token = tokenFor(MOCK_ADMIN_USER);
    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });

    try {
      // 2º serviço ATIVO sem horário: o foguete do serviço 1 mede só o serviço clicado (gate e escritor) — o outro não trava.
      await postContractedServiceViaApi(request, token, patient.patientId, {
        serviceCode: 'AT', providersNeeded: 1, careLocation: 'HOME', addressId: patient.addressId,
      });

      await loginAs(page, MOCK_ADMIN_USER);
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);

      await expect(page.getByTestId('toast-success'), 'toast de sucesso').toBeVisible({ timeout: 8_000 });
      await expect(page.getByTestId('toast-warning'), 'nenhum aviso de "paciente não moveu"').toHaveCount(0);

      const isDraft = runSQL(`SELECT is_draft FROM job_postings WHERE id = '${vacancyId}'`).trim();
      expect(isDraft, 'a vaga nasceu em rascunho').toBe('t');
      const statusAfter = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusAfter, 'paciente foi para Búsqueda').toBe('SEARCHING');
      const columnAfter = await readPatientKanbanColumn(page, patient.patientId);
      expect(columnAfter, 'card está na coluna Búsqueda').toBe('SEARCHING');
      expect(lastStatusChangeSource(patient.patientId), 'trilha do foguete').toBe('recruitment_activation');
    } finally {
      patient.cleanup();
    }
  });
});
