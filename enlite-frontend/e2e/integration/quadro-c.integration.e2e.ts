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
import { insertWJA, upsertEncuadre, getWjaByWorkerAndJob, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { putMove, chooseReasonInModal } from '../helpers/funnel-move-e2e-helper';
import { collectDataRequests } from '../helpers/kanban-subcard-e2e-helper';
import { tokenFor, loginAs } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import {
  readServiceTeamApi, postServiceTeamAction, countMarks, openContractedServiceTab, selectServiceRow,
  cleanupQuadroC,
} from '../helpers/quadro-c-e2e-helper';

const STAFF = mockAdminUserFor('quadro-c');

/**
 * `seedAssignment` (itinerario-e2e-helper.ts, irmão pré-existente, não tocado por este passo)
 * devolve o `runSQL` cru de `patient-detail-a-helper.ts`: `psql -tAc "INSERT … RETURNING id"`
 * neste container imprime a tupla E o tag de comando ("INSERT 0 1") na MESMA saída — medido, achado
 * fora do passo (ver LISTA do retorno de P24). Os únicos consumidores anteriores descartavam o
 * retorno; extrai só o UUID aqui, sem tocar o helper irmão (regra 3 do brief).
 */
function extractUuid(raw: string): string {
  return raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? raw;
}

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
      assignmentId = extractUuid(
        seedAssignment({ slotId, workerId, applicationId: wjaId, validFromDaysAgo: 7, status: 'ACTIVE' }),
      );

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

  test('quadro-c-rejeitar-alocado-422', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    let assignmentId: string | null = null;
    try {
      const wjaId = insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const itin = await readItineraryApi(request, seed.patientId);
      const svc = itin.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId);
      const slotId = svc?.slots[0]?.id;
      if (!slotId) throw new Error('quadro-c-rejeitar-alocado-422: slot do serviço não encontrado no itinerário');
      assignmentId = extractUuid(
        seedAssignment({ slotId, workerId, applicationId: wjaId, validFromDaysAgo: 3, status: 'ACTIVE' }),
      );

      const allocated = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId, reasonCategory: 'DESISTENCIA_DO_PRESTADOR',
      });
      expect(allocated.status).toBe(422);
      expect(allocated.body.code).toBe('SERVICE_TEAM_WORKER_ALLOCATED');
      expect(allocated.body.error).toBe('remova do itinerário primeiro');
      const statusStillActive = runSQL(`SELECT status FROM patient_itinerary_assignment WHERE id = '${assignmentId}'`);
      expect(statusStillActive).toBe('ACTIVE');

      runSQL(
        `UPDATE patient_itinerary_assignment SET status = 'ENDED', valid_to = ` +
          `(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 1 WHERE id = '${assignmentId}'`,
      );

      const afterEnd = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId, reasonCategory: 'DESISTENCIA_DO_PRESTADOR',
      });
      const rejectedIds = (afterEnd.body.data?.rejected ?? []).map((m) => m.workerId);
      console.log('[10.7]', allocated.status, afterEnd.status, rejectedIds);
      expect(afterEnd.status).toBe(200);
      expect(rejectedIds).toContain(workerId);
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  test('quadro-c-rejeitar-exige-motivo', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerApi = insertTestWorker({ occupation: 'AT' });
    const workerUi = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId: workerApi, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: workerUi, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const marksBefore = countMarks(seed.serviceId, workerApi);
      const noReason = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId: workerApi,
      });
      expect(noReason.status).toBe(422);
      expect(noReason.body.code).toBe('SERVICE_TEAM_REASON_REQUIRED');
      const marksAfterNoReason = countMarks(seed.serviceId, workerApi);
      expect(marksAfterNoReason).toBe(marksBefore);

      const withReason = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId: workerApi, reasonCategory: 'INDISPONIBILIDADE_DE_HORARIO',
      });
      expect(withReason.status).toBe(200);
      const rowCategory = runSQL(
        `SELECT reject_reason_category FROM contracted_service_rejections WHERE service_id = '${seed.serviceId}' ` +
          `AND worker_id = '${workerApi}' AND reverted_at IS NULL`,
      );
      console.log('[10.8]', noReason.status, withReason.status, rowCategory);
      expect(rowCategory).toBe('INDISPONIBILIDADE_DE_HORARIO');

      // Também pela tela: "Rechazar" → modal → confirmar desabilitado sem escolha → escolher → confirmar.
      await loginAs(page, STAFF);
      await openContractedServiceTab(page, seed.patientId);
      await selectServiceRow(page, seed.serviceId);
      await page.getByTestId(`service-team-reject-${workerUi}`).click();
      const confirmBtn = page.getByTestId('service-team-reject-confirm');
      await expect(confirmBtn).toBeDisabled();
      await chooseReasonInModal(page, 'service-team-reject', 'DESISTENCIA_DO_PRESTADOR');
      await expect(
        page.getByTestId('kanban-column-REJECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerUi}`),
      ).toBeVisible();
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerApi, vacancyId);
      cleanupWJAAndEncuadre(workerUi, vacancyId);
      cleanupTestWorker(workerApi);
      cleanupTestWorker(workerUi);
      seed.cleanup();
    }
  });

  test('quadro-c-reverter-exige-motivo', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const rejected = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId, reasonCategory: 'OTHER',
      });
      expect(rejected.status).toBe(200);

      const noReason = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'revert', { workerId });
      expect(noReason.status).toBe(422);
      const stillRejected = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      expect((stillRejected.body.data?.rejected ?? []).map((m) => m.workerId)).toContain(workerId);

      const withReason = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'revert', {
        workerId, reasonCategory: 'REAVALIACAO',
      });
      expect(withReason.status).toBe(200);
      const revertCategory = runSQL(
        `SELECT revert_reason_category FROM contracted_service_rejections WHERE service_id = '${seed.serviceId}' ` +
          `AND worker_id = '${workerId}' ORDER BY created_at DESC LIMIT 1`,
      );
      const revertedAtFilled = runSQL(
        `SELECT (reverted_at IS NOT NULL)::text FROM contracted_service_rejections WHERE service_id = '${seed.serviceId}' ` +
          `AND worker_id = '${workerId}' ORDER BY created_at DESC LIMIT 1`,
      );
      const revertedByFilled = runSQL(
        `SELECT (reverted_by IS NOT NULL)::text FROM contracted_service_rejections WHERE service_id = '${seed.serviceId}' ` +
          `AND worker_id = '${workerId}' ORDER BY created_at DESC LIMIT 1`,
      );
      console.log('[10.9]', noReason.status, revertCategory, revertedAtFilled, revertedByFilled);
      expect(revertCategory).toBe('REAVALIACAO');
      expect(revertedAtFilled).toBe('true');
      expect(revertedByFilled).toBe('true');
      expect((withReason.body.data?.selected ?? []).map((m) => m.workerId)).toContain(workerId);
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  test('quadro-c-rejeitar-nao-mexe-em-b', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const before = getWjaByWorkerAndJob(workerId, vacancyId);

      const reject = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId, reasonCategory: 'OTHER',
      });
      expect(reject.status).toBe(200);

      const after = getWjaByWorkerAndJob(workerId, vacancyId);
      console.log('[10.11]', before?.funnelStage, after?.funnelStage);
      expect(after?.funnelStage).toBe('QUICK_RESPONSE_TEAM');
      expect(after?.funnelStage).toBe(before?.funnelStage);
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });
});
