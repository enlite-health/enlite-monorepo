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
  activateRecruitmentViaApi, readItineraryApi, seedAssignment, createServiceViaApi, ITINERARIO_STAFF,
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
  const found = raw.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
  if (!found) throw new Error(`extractUuid: nenhum uuid na saída do psql (semente falhou?): ${raw}`);
  return found;
}

/**
 * 2º endereço do paciente (`quadro-c-por-servico`, critério 13) — SQL direto: nenhum helper de
 * API grava endereço nesta pasta ainda (a rota `POST /patients/:patientId/addresses`,
 * `adminPatientsRoutes.ts:184`, não tem wrapper de e2e — DX-10.13 permite SQL quando a rota não
 * serve, listado aqui). Molde do INSERT: `localizaciones-abac-principal-tipo...ts:204-206`
 * (`address_type = NULL` — lista fechada pelo zod da API, não pelo CHECK do banco).
 */
function insertSecondAddress(patientId: string): string {
  return extractUuid(
    runSQL(
      `INSERT INTO patient_addresses (patient_id, is_default, address_type, address_formatted, address_raw, ` +
        `lat, lng, display_order, source, created_at, updated_at) VALUES ('${patientId}', false, NULL, ` +
        `'Av. Santa Fe 2000, CABA, AR', 'Av. Santa Fe 2000, CABA', -34.595, -58.393, 2, 'manual', NOW(), NOW()) ` +
        `RETURNING id`,
    ),
  );
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
      // Espera a resposta do GET /team da re-seleção ANTES de medir — sem isso o `toHaveCount(0)`
      // pode passar ANTES do fetch responder (o clique zera `team` no estado antes da resposta
      // chegar), provando o "zero" errado (achado 2 do veredito, gate parcial G1-e). `r.ok()` +
      // método GET: um 500 no `/team` não pode mais passar o zero como se fosse "rejeitado de
      // verdade" (N2 do gate fecho — o zero também acontece quando a tela some por erro).
      await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes('/contracted-services/') && r.url().endsWith('/team') && r.ok()),
        selectServiceRow(page, seed.serviceId),
      ]);
      await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE')).toBeVisible();
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

  test('quadro-c-reverter-exige-motivo', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    const workerUi = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: workerUi, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
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

      // Também pela tela (N4 do gate fecho — molde: o trecho de "Rechazar" pela tela em
      // `quadro-c-rejeitar-exige-motivo`): worker rejeitado por fixture (API) → clique real em
      // "Revertir" → modal → confirmar desabilitado sem escolha → escolher → confirmar → card em
      // Seleccionado + 0 marca ativa.
      const rejectedUi = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId: workerUi, reasonCategory: 'OTHER',
      });
      expect(rejectedUi.status).toBe(200);

      await loginAs(page, STAFF);
      await openContractedServiceTab(page, seed.patientId);
      await selectServiceRow(page, seed.serviceId);
      await expect(
        page.getByTestId('kanban-column-REJECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerUi}`),
      ).toBeVisible();
      await page.getByTestId(`service-team-revert-${workerUi}`).click();
      await expect(page.getByTestId('service-team-revert-modal')).toBeVisible();
      const confirmBtn = page.getByTestId('service-team-revert-confirm');
      await expect(confirmBtn).toBeDisabled();
      await chooseReasonInModal(page, 'service-team-revert', 'REAVALIACAO');
      await expect(
        page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerUi}`),
      ).toHaveCount(1);
      expect(countMarks(seed.serviceId, workerUi, { active: true })).toBe(0);
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupWJAAndEncuadre(workerUi, vacancyId);
      cleanupTestWorker(workerId);
      cleanupTestWorker(workerUi);
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

  test('quadro-c-sem-vaga', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    try {
      await loginAs(page, STAFF);
      await openContractedServiceTab(page, seed.patientId);
      await selectServiceRow(page, seed.serviceId);
      await expect(page.getByTestId('quadro-c-sem-vaga')).toBeVisible();
      await expect(page.locator('[data-testid^="kanban-column-"]')).toHaveCount(0);

      const api = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      console.log('[10.19]', api.status, api.body.data?.vacancyId);
      expect(api.body.data?.vacancyId ?? null).toBeNull();
    } finally {
      cleanupQuadroC(seed.patientId);
      seed.cleanup();
    }
  });

  test('quadro-c-sem-adicionar', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      // Achado 2 do veredito: medir "0 botões dentro da seção" SEM serviço selecionado passaria com
      // um "Adicionar" dentro do quadro (a seção só mostra o texto de convite, o board nem monta).
      // Seleciona um serviço COM vaga e candidato — o board (3 colunas) precisa estar de pé antes
      // da contagem valer alguma coisa.
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      await loginAs(page, STAFF);
      await openContractedServiceTab(page, seed.patientId);
      await selectServiceRow(page, seed.serviceId);
      await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE')).toBeVisible();
      await expect(page.getByTestId(`service-team-card-${workerId}`)).toBeVisible();

      const dentro = page.getByTestId('quadro-c-secao').getByRole('button', { name: /adicionar|agregar|añadir|nuevo/i });
      await expect(dentro).toHaveCount(0);

      const fora = page.getByTestId('servicos-contratados-card').getByRole('button', {
        name: /adicionar|agregar|añadir|nuevo/i,
      });
      // `.count()` só para o log — a asserção de fato é o `toBeVisible` abaixo, que espera com retry.
      const foraCount = await fora.count();
      console.log('[10.5]', 0, foraCount);
      await expect(fora.first()).toBeVisible();
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  test('quadro-c-por-servico', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const address2Id = insertSecondAddress(seed.patientId);
    const s2 = await createServiceViaApi(request, seed.patientId, { addressId: address2Id, schedule: [{ dayOfWeek: 2, startTime: '09:00', endTime: '13:00' }] });
    const v1 = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    await activateRecruitmentViaApi(request, seed.patientId, s2);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const apiS1 = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      const apiS2 = await readServiceTeamApi(request, seed.patientId, s2);
      const s1Ids = [
        ...(apiS1.body.data?.selected ?? []), ...(apiS1.body.data?.inService ?? []), ...(apiS1.body.data?.rejected ?? []),
      ].map((m) => m.workerId);
      const s2Ids = [
        ...(apiS2.body.data?.selected ?? []), ...(apiS2.body.data?.inService ?? []), ...(apiS2.body.data?.rejected ?? []),
      ].map((m) => m.workerId);
      console.log('[10.13]', s1Ids, s2Ids);
      expect(s1Ids).toContain(workerId);
      expect(s2Ids).not.toContain(workerId);

      await loginAs(page, STAFF);
      await openContractedServiceTab(page, seed.patientId);
      // Espera a resposta do GET /team do serviço `s2` ANTES de medir — mesma régua de
      // `quadro-c-rechazado-na-vaga-some` (o zero não pode passar antes do fetch responder, nem
      // quando o fetch falha: `r.ok()` + GET, N2 do gate fecho).
      await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes('/contracted-services/') && r.url().endsWith('/team') && r.ok()),
        selectServiceRow(page, s2),
      ]);
      await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE')).toBeVisible();
      await expect(page.getByTestId(`service-team-card-${workerId}`)).toHaveCount(0);
    } finally {
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, v1);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  test('quadro-c-selecao', async ({ page, request }, testInfo) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const v1 = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const s2 = await createServiceViaApi(request, seed.patientId, { addressId: seed.addressId, schedule: [{ dayOfWeek: 2, startTime: '09:00', endTime: '13:00' }] });
    await activateRecruitmentViaApi(request, seed.patientId, s2);
    const w1 = insertTestWorker({ occupation: 'AT' }); // ERR/selected
    const w2 = insertTestWorker({ occupation: 'AT' }); // alocado/inService
    const w3 = insertTestWorker({ occupation: 'AT' }); // rejeitado
    const keep = process.env.QUADRO_C_KEEP === '1';
    try {
      insertWJA({ workerId: w1, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const wjaW2 = insertWJA({ workerId: w2, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w3, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const rejectW3 = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId: w3, reasonCategory: 'OTHER',
      });
      expect(rejectW3.status).toBe(200);

      const itin = await readItineraryApi(request, seed.patientId);
      const svc = itin.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId);
      const slotId = svc?.slots[0]?.id;
      if (!slotId) throw new Error('quadro-c-selecao: slot do serviço não encontrado no itinerário');
      seedAssignment({ slotId, workerId: w2, applicationId: wjaW2, validFromDaysAgo: 5, status: 'ACTIVE' });

      await loginAs(page, STAFF);
      await openContractedServiceTab(page, seed.patientId);
      const printDir = process.env.PRINT_DIR;

      // Sem seleção: 0 colunas.
      await expect(page.getByTestId('quadro-c-sem-selecao')).toBeVisible();
      await expect(page.locator('[data-testid^="kanban-column-"]')).toHaveCount(0);
      if (printDir) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: `${printDir}/quadro-c-sem-selecao.png`, fullPage: false, animations: 'disabled', caret: 'hide',
        });
      }

      // s1 selecionado: 3 colunas, 1 card em cada (ERR, alocado, rejeitado).
      await selectServiceRow(page, seed.serviceId);
      await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE')).toHaveCount(1);
      await expect(page.getByTestId('kanban-column-IN_SERVICE')).toHaveCount(1);
      await expect(page.getByTestId('kanban-column-REJECTED_FOR_SERVICE')).toHaveCount(1);
      await expect(page.getByTestId(`service-team-card-${w1}`)).toBeVisible();
      await expect(page.getByTestId(`service-team-card-${w2}`)).toBeVisible();
      await expect(page.getByTestId(`service-team-card-${w3}`)).toBeVisible();

      // P26b (pixel-check DIV-12/DIV-13): a coluna Rechazado (3ª) não pode sair cortada da área
      // do card — o botão "Revertir" de w3 precisa estar inteiro dentro de `quadro-c-secao`.
      const revertW3 = page.getByTestId(`service-team-revert-${w3}`);
      await revertW3.scrollIntoViewIfNeeded();
      await expect(revertW3).toBeInViewport();
      const secaoBox = await page.getByTestId('quadro-c-secao').boundingBox();
      const revertBox = await revertW3.boundingBox();
      if (!secaoBox || !revertBox) {
        throw new Error('quadro-c-selecao: boundingBox ausente para conferir o corte da coluna Rechazado');
      }
      expect(revertBox.x).toBeGreaterThanOrEqual(secaoBox.x);
      expect(revertBox.x + revertBox.width).toBeLessThanOrEqual(secaoBox.x + secaoBox.width);

      if (printDir) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: `${printDir}/quadro-c-tres-colunas.png`, fullPage: false, animations: 'disabled', caret: 'hide',
          mask: [
            page.getByTestId(`service-team-card-${w1}`), page.getByTestId(`service-team-card-${w2}`),
            page.getByTestId(`service-team-card-${w3}`),
          ],
        });
      }

      // Motivo aberto (Rechazar em w1, ainda selecionado) — print, depois cancela (não altera dado).
      await page.getByTestId(`service-team-reject-${w1}`).click();
      await expect(page.getByTestId('service-team-reject-modal')).toBeVisible();
      if (printDir) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({
          path: `${printDir}/quadro-c-motivo.png`, fullPage: false, animations: 'disabled', caret: 'hide',
        });
      }
      await page.getByTestId('service-team-reject-cancel').click();
      await expect(page.getByTestId('service-team-reject-modal')).toHaveCount(0);

      // s2 selecionado: título/endereço lidos do DOM da linha 2, realce medido, seção com 1 baseline.
      const row2 = page.getByTestId(`contracted-service-row-${s2}`);
      const row1 = page.getByTestId(`contracted-service-row-${seed.serviceId}`);
      const serviceLabel2 = ((await row2.locator('td').nth(1).innerText()) ?? '').trim();
      // Sem `.catch()`: se a semente do 2º endereço falhar, o teste quebra AQUI, com o testid que
      // faltou — nunca pula a asserção em silêncio (achado 2 do veredito).
      const addressLabel2 = (await page.getByTestId(`contracted-service-address-${s2}`).innerText()).trim();
      if (!addressLabel2) {
        throw new Error('quadro-c-selecao: contracted-service-address veio vazio — a semente do 2º endereço falhou');
      }

      await selectServiceRow(page, s2);
      const titulo = page.getByTestId('quadro-c-titulo');
      await expect(titulo).toBeVisible();
      const tituloText = (await titulo.innerText()).trim();
      expect(tituloText).toContain(serviceLabel2);
      expect(tituloText).toContain(addressLabel2);

      await expect(row2).toHaveAttribute('aria-selected', 'true');
      await expect(row1).not.toHaveAttribute('aria-selected', 'true');
      const [selBg, naoBg] = await Promise.all([
        row2.evaluate((el) => getComputedStyle(el).backgroundColor),
        row1.evaluate((el) => getComputedStyle(el).backgroundColor),
      ]);
      console.log('[10.18] realce', { sel: selBg, nao: naoBg });
      expect(selBg).not.toBe(naoBg);

      await expect(page.getByTestId('servicos-contratados-card').getByTestId('quadro-c-secao')).toHaveCount(1);

      await page.evaluate(() => document.fonts.ready);
      await expect(page.getByTestId('quadro-c-secao')).toHaveScreenshot(`${testInfo.project.name}-quadro-c-selecao.png`, {
        maxDiffPixelRatio: 0.05,
        mask: [titulo],
      });

      if (keep) {
        console.log('[quadro-c-selecao] patientId mantido (QUADRO_C_KEEP=1):', seed.patientId);
      }
    } finally {
      if (!keep) {
        cleanupQuadroC(seed.patientId);
        cleanupWJAAndEncuadre(w1, v1);
        cleanupWJAAndEncuadre(w2, v1);
        cleanupWJAAndEncuadre(w3, v1);
        cleanupTestWorker(w1);
        cleanupTestWorker(w2);
        cleanupTestWorker(w3);
        seed.cleanup();
      }
    }
  });
});
