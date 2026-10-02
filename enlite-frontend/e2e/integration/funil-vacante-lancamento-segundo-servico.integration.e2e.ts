/**
 * funil-vacante-lancamento-segundo-servico.integration.e2e.ts @integration
 *
 * P13 (Fase 6, cadeia-paciente-vacante-itinerario) — 1 teste, critério 6:
 *
 * `lancamento-segundo-servico-nao-regride`:
 *   6. o paciente `ACTIVE` (já com um serviço em atendimento — é o que o próprio status
 *      `ACTIVE` representa) ganha um 2º serviço novo; o foguete + lançamento (`/talentum` →
 *      "Publicar en Talentum") desse 2º serviço NÃO regride o paciente — ele continua `ACTIVE`
 *      (API e coluna do Kanban do paciente), a trilha `vacancy_launch` fica em 0, e o gancho
 *      (`VacancyLaunchHook.movePatientIfInFunnel`) registra `patient: 'unchanged'` (fora do
 *      funil de Admissão — `isAdmissionFunnelStatus('ACTIVE')` é falso, DX-6.3). O match SEM
 *      convite roda igual (controle positivo de que o gancho rodou: sem ele "não moveu" seria
 *      indistinguível de "não rodou").
 *
 * DX-6.3: `seedLaunchablePatient({ status: 'ACTIVE', ... })` cria pelo helper só UM serviço via
 * API (o que o foguete usa) — medido que basta: `ActivateRecruitmentUseCase` só lê a completude
 * do PRÓPRIO serviço (endereço + horário) e o `insurance_informed` do paciente; não consulta
 * outros serviços nem o `status` do paciente para decidir se recruta. Não foi preciso semear um
 * 1º serviço adicional com horário + vaga fechada — o `status: 'ACTIVE'` já É o que representa
 * "serviço em atendimento" para o gancho (`movePatientIfInFunnel` só olha `target.patientStatus`).
 *
 * Único mock de navegador: `/generate-ai-content` (Gemini custaria) — instalado DEPOIS do login
 * (mesma ordem do P12: `swapToken` do `loginAs` vence rotas registradas antes dele).
 * `publish-talentum` NUNCA é mockado: vai ao backend, que vai ao stub da Talentum (porta 9914).
 *
 * Helpers: `lancamento-e2e-helper.ts` (P4), `funnel-move-e2e-helper.ts` (P12),
 * `compativeis-e2e-helper.ts` (`readFunnelApi`, Fase 5), `abac-stack-helper.ts`/
 * `vacancy-notes-e2e-helper.ts` (staff mock).
 */

import { test, expect } from '@playwright/test';
import {
  startTalentumStub,
  seedLaunchablePatient,
  seedWorkersNear,
  clickFoguete,
  completeDraftViaWizard,
  publishOnTalentumPage,
  readPatientKanbanColumn,
  countLaunchTrail,
  backendUrl,
  mockAdminUserFor,
  useLancamentoStaff,
  loginAndMockAi,
  LANCAMENTO_VIEWPORT_ES_AR,
  type FunnelStageItem,
} from '../helpers/lancamento-e2e-helper';
import { readPatientStatusApi } from '../helpers/lancamento-leituras-helper';
import { readFunnelApi } from '../helpers/lancamento-leituras-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { cleanupTestWorker } from '../helpers/db-test-helper';

const MOCK_ADMIN_USER = mockAdminUserFor('2svc');

test.describe('funil-vacante lancamento segundo servico @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  test.setTimeout(120_000);

  useLancamentoStaff(MOCK_ADMIN_USER, 'E2E Lancamento 2o Servico F6');

  test('lancamento-segundo-servico-nao-regride', async ({ page, request }) => {
    // Coordenada própria do arquivo (DX-6.9) — a mesma que o texto do passo dá.
    const LAT = -51.623;
    const LNG = -69.2168;

    const token = tokenFor(MOCK_ADMIN_USER);
    const stub = await startTalentumStub();

    const patient = await seedLaunchablePatient(request, { status: 'ACTIVE', lat: LAT, lng: LNG });
    const [w] = seedWorkersNear(LAT, LNG, 1);

    try {
      // DEPOIS do login — mesma ordem e mesmo motivo do P12 (`swapToken` resolve antes de
      // qualquer rota registrada mais cedo; instalar antes do login faria `/generate-ai-content`
      // ir à API real). `loginAndMockAi` (helper, G2) encapsula essa ordem.
      await loginAndMockAi(page, MOCK_ADMIN_USER);

      // (0) Paciente já ACTIVE ANTES do foguete — "Não faça: semear o ACTIVE por UPDATE depois".
      const statusBeforeFoguete = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusBeforeFoguete, 'paciente já ACTIVE antes do foguete do 2º serviço').toBe('ACTIVE');

      // (1) Foguete pela ficha — 2º serviço (o único que o helper cria) de um paciente já ativo.
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);

      // (2) Borrador → wizard → /talentum.
      await completeDraftViaWizard(page, vacancyId);

      // (3) Antes do clique em "Publicar en Talentum".
      const statusBeforePublish = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusBeforePublish, 'status antes do publish').toBe('ACTIVE');

      // (4) Publicar en Talentum — nunca mockado, vai ao backend → stub (porta 9914).
      const publishStatus = await publishOnTalentumPage(page, vacancyId);
      expect(publishStatus, 'POST /publish-talentum').toBe(200);
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`), { timeout: 15_000 });

      // ── Critério 6: o paciente ACTIVE NÃO regride ────────────────────────────────
      const statusAfter = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusAfter, 'status depois do publish — não regride').toBe('ACTIVE');

      const trailAfter = countLaunchTrail(patient.patientId);
      expect(trailAfter, 'trilha vacancy_launch continua em 0 (gancho não moveu)').toBe(0);

      const columnAfterLaunch = await readPatientKanbanColumn(page, patient.patientId);
      expect(columnAfterLaunch, 'coluna do Kanban do paciente continua ACTIVE').toBe('ACTIVE');

      // ── Controle positivo de que o gancho RODOU (senão "não moveu" == "não rodou") ──
      const funnel = (await readFunnelApi(request, token, vacancyId)) as {
        stages?: Record<string, FunnelStageItem[]>;
      };
      const compatible = funnel.stages?.COMPATIBLE ?? [];
      const wItem = compatible.find((it) => it.workerId === w);
      expect(wItem, 'W pertence a stages.COMPATIBLE — o match sem convite rodou fora do funil').toBeTruthy();

      console.log('[6.6] lancamento-segundo-servico-nao-regride', {
        vacancyId,
        patientId: patient.patientId,
        workerId: w,
        statusBeforeFoguete,
        statusBeforePublish,
        statusAfter,
        trailAfter,
        columnAfterLaunch,
        compatibleCount: compatible.length,
        wjaId: wItem?.id ?? null,
      });
    } finally {
      await stub.close();
      patient.cleanup();
      cleanupTestWorker(w);
    }
  });
});
