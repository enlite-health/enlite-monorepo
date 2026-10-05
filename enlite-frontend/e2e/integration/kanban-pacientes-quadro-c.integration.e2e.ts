/**
 * kanban-pacientes-quadro-c.integration.e2e.ts @integration — Fase 10 (cadeia-paciente-vacante-itinerario), DX-10.13.
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
 *
 * Nome do ARQUIVO (P26, DX-10.13 "CI"): sem o "pode" do Gabriel para `pr-gate.yml` nesta sessão
 * (Q-10.4 — e `pr-gate.yml` é intocável em qualquer passo salvo o P27, regra 3 do brief), aplica o
 * fallback já documentado no plano: o caminho `kanban-pacientes-quadro-c...` casa o termo
 * `kanban-pacientes` que já está no `grep:` do job padrão (`pr-gate.yml:142`) — os títulos dos
 * testes continuam `quadro-c-…`, os `--grep` dos critérios valem igual.
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
import { putMove } from '../helpers/funnel-move-e2e-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import {
  readServiceTeamApi, postServiceTeamAction,
  cleanupQuadroC,
} from '../helpers/quadro-c-e2e-helper';
import { extractUuid } from '../helpers/itinerario-escrita-e2e-helper';

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
