/**
 * quadro-c.integration.e2e.ts @integration — Fase 10 (cadeia-paciente-vacante-itinerario), DX-10.13.
 *
 * Front real (Vite) + API real (rebuildada da worktree) + Postgres real. Zero mock de dado —
 * `page.route` só é instalado DEPOIS do `loginAs` (nenhum previsto aqui). Semente por API real
 * (`seedLaunchablePatient`/`activateRecruitmentViaApi`/`createServiceViaApi`) e por SQL só onde
 * nenhum escritor de API existe ainda (alocação — Fase 11; encuadre do quadro B — helper
 * pré-existente `upsertEncuadre`).
 *
 * 11 títulos, DX-10.13: `quadro-c-rechazado-na-vaga-some`, `quadro-c-removido-volta`,
 * `quadro-c-sem-adicionar`, `quadro-c-so-err-alimenta`, `quadro-c-rejeitar-alocado-422`,
 * `quadro-c-rejeitar-exige-motivo`, `quadro-c-reverter-exige-motivo`, `quadro-c-rejeitar-nao-mexe-em-b`,
 * `quadro-c-por-servico`, `quadro-c-selecao`, `quadro-c-sem-vaga`.
 */
import { test, expect } from '@playwright/test';
import {
  seedLaunchablePatient, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR, backendUrl,
} from '../helpers/lancamento-e2e-helper';
import {
  activateRecruitmentViaApi, readItineraryApi, seedAssignment, ITINERARIO_STAFF,
} from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, upsertEncuadre, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { putMove } from '../helpers/funnel-move-e2e-helper';
import { collectDataRequests } from '../helpers/kanban-subcard-e2e-helper';
import { tokenFor, loginAs } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import {
  readServiceTeamApi, countMarks, openContractedServiceTab, selectServiceRow, cleanupQuadroC,
} from '../helpers/quadro-c-e2e-helper';

const STAFF = mockAdminUserFor('quadro-c');

test.describe('quadro-c @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  useLancamentoStaff(STAFF, 'E2E Quadro C');

  test('quadro-c-so-err-alimenta', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'SELECTED' });

      const before = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      expect(before.status).toBe(200);
      const beforeIds = [
        ...(before.body.data?.selected ?? []),
        ...(before.body.data?.inService ?? []),
        ...(before.body.data?.rejected ?? []),
      ].map((m) => m.workerId);
      expect(beforeIds).not.toContain(workerId);

      // vizinho no quadro B (SELECTED → QUICK_RESPONSE_TEAM): sem motivo (Fase 4, requiredMoveReason).
      const encuadreId = upsertEncuadre({ workerId, jobPostingId: vacancyId });
      const move = await putMove(request, backendUrl(), tokenFor(ITINERARIO_STAFF), encuadreId, {
        targetStage: 'QUICK_RESPONSE_TEAM',
      });
      expect(move.status).toBe(200);

      const after = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      const afterIds = (after.body.data?.selected ?? []).map((m) => m.workerId);
      console.log('[10.6]', beforeIds, afterIds);
      expect(afterIds).toContain(workerId);
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  test('quadro-c-rechazado-na-vaga-some', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const reqs = collectDataRequests(page);
      await loginAs(page, STAFF);
      await openContractedServiceTab(page, seed.patientId);
      const detailPattern = new RegExp(`GET /api/admin/patients/${seed.patientId}$`);
      const detailReqsAfterLoad = reqs().filter((r) => detailPattern.test(r)).length;
      await selectServiceRow(page, seed.serviceId);
      await expect(
        page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerId}`),
      ).toBeVisible();
      const apiBefore = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      expect((apiBefore.body.data?.selected ?? []).map((m) => m.workerId)).toContain(workerId);

      const encuadreId = upsertEncuadre({ workerId, jobPostingId: vacancyId });
      const move = await putMove(request, backendUrl(), tokenFor(ITINERARIO_STAFF), encuadreId, {
        targetStage: 'REJECTED',
        reasonCategory: 'WORKER_DECLINED',
      });
      expect(move.status).toBe(200);

      // Sem `page.reload()` — re-clica a linha pra atualizar o quadro C (`selectionNonce`, DX-10.8).
      await selectServiceRow(page, seed.serviceId);
      await expect(page.getByTestId(`service-team-card-${workerId}`)).toHaveCount(0);

      const apiAfter = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      const afterIds = [
        ...(apiAfter.body.data?.selected ?? []),
        ...(apiAfter.body.data?.inService ?? []),
        ...(apiAfter.body.data?.rejected ?? []),
      ].map((m) => m.workerId);
      expect(afterIds).not.toContain(workerId);

      const marks = countMarks(seed.serviceId, workerId);
      expect(marks).toBe(0);
      console.log('[10.12]', marks);

      const requestsSoFar = reqs();
      const teamRequests = requestsSoFar.filter((r) => /\/contracted-services\/.*\/team$/.test(r));
      expect(teamRequests.length).toBe(2);
      const detailRequestsNow = requestsSoFar.filter((r) => detailPattern.test(r)).length;
      // 0 GET novo de /api/admin/patients/<p> depois do 1º carregamento — os 2 cliques na linha só
      // disparam /team.
      expect(detailRequestsNow).toBe(detailReqsAfterLoad);
      console.log('[10.15]', requestsSoFar);
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  test('quadro-c-removido-volta', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    let assignmentId: string | null = null;
    try {
      const wjaId = insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const itin = await readItineraryApi(request, seed.patientId);
      const svc = itin.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId);
      const slotId = svc?.slots[0]?.id;
      if (!slotId) throw new Error('quadro-c-removido-volta: slot do serviço não encontrado no itinerário');
      // `seedAssignment` (itinerario-e2e-helper.ts, irmão pré-existente, não tocado por este passo)
      // devolve `runSQL` cru: `psql -tAc "INSERT … RETURNING id"` neste container imprime a tupla E
      // o tag de comando ("INSERT 0 1") na MESMA saída — medido (achado fora do passo, ver LISTA do
      // retorno). Os únicos consumidores anteriores descartavam o retorno; extrai só o UUID aqui.
      const rawAssignmentId = seedAssignment({
        slotId, workerId, applicationId: wjaId, validFromDaysAgo: 7, status: 'ACTIVE',
      });
      assignmentId = rawAssignmentId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
        ?? rawAssignmentId;

      await loginAs(page, STAFF);
      await openContractedServiceTab(page, seed.patientId);
      await selectServiceRow(page, seed.serviceId);
      await expect(
        page.getByTestId('kanban-column-IN_SERVICE').getByTestId(`service-team-card-${workerId}`),
      ).toBeVisible();
      const apiBefore = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      expect((apiBefore.body.data?.inService ?? []).map((m) => m.workerId)).toContain(workerId);

      runSQL(
        `UPDATE patient_itinerary_assignment SET status = 'ENDED', valid_to = ` +
          `(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 1 WHERE id = '${assignmentId}'`,
      );

      await selectServiceRow(page, seed.serviceId);
      await expect(
        page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerId}`),
      ).toBeVisible();
      const apiAfter = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      console.log(
        '[10.3]',
        (apiBefore.body.data?.inService ?? []).map((m) => m.workerId),
        (apiAfter.body.data?.selected ?? []).map((m) => m.workerId),
      );
      expect((apiAfter.body.data?.selected ?? []).map((m) => m.workerId)).toContain(workerId);
      expect((apiAfter.body.data?.inService ?? []).map((m) => m.workerId)).not.toContain(workerId);
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });
});
