/**
 * kanban-pacientes-cadeia-completa.integration.e2e.ts @integration — Fase 16 (cadeia-paciente-vacante-itinerario),
 * DX-16.3 / DX-16.4 / DX-16.6 / DX-16.7.
 *
 * A cadeia inteira numa execução só: os onze invariantes de `docs/referencia/fluxo-paciente-vacante-itinerario.md`,
 * um `test.step` por passo do plano, cada um com `console.log('[16.p<n>]', …)` só com ids, status e contagens (o
 * título não aparece no log do CI). O caminho do arquivo casa `kanban-pacientes` do job padrão — workflow intocado.
 *
 * Tela × API por passo (DX-16.4) — pela TELA onde o molde já faz pela tela; API só onde o molde usa API, e o nome
 * do step diz:
 *   1  semente de X (2 serviços, 2 endereços, horário) — API + SQL; a coluna Admissão lida na TELA
 *   2  foguete — TELA
 *   3  completar + enviar à Talentum STUB — TELA (o match deposita em Compatíveis)
 *   4  quadro B — TELA (arrasto + modal); Invitados por SEMENTE (convidar é canal real); a recusa sem motivo pela API
 *   5  quadro C — TELA (rejeitar com motivo); a recusa sem motivo pela API
 *   6  itinerário — montado via API (a aba da Fase 12 não marca montado); alocar pela TELA
 *   7  folga de 1h em outro endereço — TELA (409 dito e 201)
 *   8  par e coluna — TELA do Kanban
 *   9  substituição — TELA; rejeitar o titular alocado via API (molde da Fase 10)
 *   10 encerrar — via API (a Fase 12 não encerra pela tela); efeito lido na TELA
 *   11 desmonte — SQL por id, no `finally`
 *
 * Único mock do navegador: `/generate-ai-content` (`loginAndMockAi`). `publish-talentum` nunca é mockado — vai ao
 * backend, que vai ao stub da Talentum (`startTalentumStub`, fechado no `finally`). O `t0` do `countOutboundSince`
 * é a única leitura do relógio do runner (exceção declarada no plano, molde do lançamento); o resto das datas vem
 * do banco. Nada é importado do que a Fase 15 criou (DX-16.9).
 */
import { test, expect, type Response } from '@playwright/test';
import {
  startTalentumStub, clickFoguete, completeDraftViaWizard, publishOnTalentumPage, readPatientKanbanColumn,
  countLaunchTrail, backendUrl, mockAdminUserFor, useLancamentoStaff, loginAndMockAi, LANCAMENTO_VIEWPORT_ES_AR,
  type FunnelStageItem,
} from '../helpers/lancamento-e2e-helper';
import {
  readPatientStatusApi, countOutboundSince, readTrail, countTrail, putMove, chooseReasonInModal,
} from '../helpers/funnel-move-e2e-helper';
import { readFunnelApi, gotoVacancyDetail, switchToKanban } from '../helpers/compativeis-e2e-helper';
import { readItineraryApi } from '../helpers/itinerario-e2e-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { insertWJA, upsertEncuadre, getWjaByWorkerAndJob } from '../helpers/wja-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import {
  readServiceTeamApi, postServiceTeamAction, countMarks, selectServiceRow,
} from '../helpers/quadro-c-e2e-helper';
import { openServiceTeamOf } from '../helpers/substituicao-e2e-helper';
import {
  seedCadeia, seedRoleWorkers, countPatients, residueByIds, cleanupCadeia, collectRequests,
  type CadeiaPatientX, type CadeiaPatientWithVacancy,
} from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('cadeia-completa');

const idList = (ids: string[]): string => (ids.length ? ids.map((id) => `'${id}'`).join(',') : 'NULL');

test.describe('cadeia-completa @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(300_000);
  useLancamentoStaff(STAFF, 'E2E Cadeia Completa F16');

  test('cadeia-completa — os onze invariantes numa execução', async ({ page, request }) => {
    const token = tokenFor(STAFF);
    const pre = countPatients();
    const tally = collectRequests(page);
    const stub = await startTalentumStub();

    const patientIds: string[] = [];
    const workerIds: string[] = [];
    const workerVacancyPairs: Array<{ workerId: string; vacancyId: string }> = [];
    const seeds: Array<{ cleanup: () => void }> = [];

    let x: CadeiaPatientX | null = null;
    let y: CadeiaPatientWithVacancy | null = null;
    let m = '';
    let v = '';
    let wjaM = '';

    try {
      const seeded = await seedCadeia(request);
      x = seeded.x;
      y = seeded.y;
      m = seeded.m;
      patientIds.push(x.patientId, y.patientId);
      seeds.push(x, y);
      workerIds.push(m);

      await loginAndMockAi(page, STAFF);
      const t0 = new Date();
      const X = x;

      await test.step('passo 1 — X em Admissão com 2 serviços em endereços diferentes, cada um com horário (invariante 8)', async () => {
        const itin = await readItineraryApi(request, X.patientId);
        expect(itin.status).toBe(200);
        const services = itin.body.data?.services ?? [];
        expect(services.map((s) => s.contractedServiceId).sort()).toEqual([X.service1Id, X.service2Id].sort());
        for (const s of services) {
          expect(s.slots.filter((slot) => slot.active).length).toBeGreaterThanOrEqual(1);
        }
        const distinctAddresses = Number(
          runSQL(`SELECT count(DISTINCT address_id) FROM patient_contracted_services WHERE patient_id = '${X.patientId}'`),
        );
        expect(distinctAddresses).toBe(2);
        const column = await readPatientKanbanColumn(page, X.patientId);
        expect(column).toBe('ADMISSION');
        console.log('[16.p1]', X.patientId, services.length, distinctAddresses, column);
      });

      await test.step('passo 2 — foguete no serviço 1 pela tela: a vaga nasce em rascunho e X continua em Admissão (invariante 7)', async () => {
        v = await clickFoguete(page, X.patientId, X.service1Id);
        workerVacancyPairs.push({ workerId: m, vacancyId: v });
        const isDraft = runSQL(`SELECT is_draft::text FROM job_postings WHERE id = '${v}'`);
        expect(isDraft).toBe('true');
        const status = await readPatientStatusApi(request, backendUrl(), token, X.patientId);
        expect(status).toBe('ADMISSION');
        const trail = countLaunchTrail(X.patientId);
        expect(trail).toBe(0);
        console.log('[16.p2]', v, isDraft, status, trail);
      });

      await test.step('passo 3 — completar e enviar à Talentum (stub) pela tela: X vai a Búsqueda e o match deposita em Compatíveis, sem convite (invariante 7)', async () => {
        await completeDraftViaWizard(page, v);
        const publishStatus = await publishOnTalentumPage(page, v);
        expect(publishStatus).toBe(200);
        const status = await readPatientStatusApi(request, backendUrl(), token, X.patientId);
        expect(status).toBe('SEARCHING');
        const trail = countLaunchTrail(X.patientId);
        expect(trail).toBe(1);
        const column = await readPatientKanbanColumn(page, X.patientId);
        expect(column).toBe('SEARCHING');

        await gotoVacancyDetail(page, v);
        await switchToKanban(page, v);
        const funnel = (await readFunnelApi(request, token, v)) as { stages?: Record<string, FunnelStageItem[]> };
        const mItem = (funnel.stages?.COMPATIBLE ?? []).find((it) => it.workerId === m);
        expect(mItem, 'M em stages.COMPATIBLE').toBeTruthy();
        wjaM = mItem?.id ?? '';
        await expect(
          page.locator(`[data-testid="kanban-column-COMPATIBLE"] [data-testid="kanban-card-${wjaM}"]`),
        ).toBeVisible({ timeout: 15_000 });

        const creates = stub.calls.filter((c) => c.method === 'POST' && c.path === '/pre-screening/projects').length;
        expect(creates).toBe(1);
        const outM = countOutboundSince(m, t0);
        expect(outM).toEqual({ domainEvents: 0, stageMessageLog: 0, outbox: 0 });
        console.log('[16.p3]', v, publishStatus, status, trail, column, wjaM, creates, outM);
      });

      // Os workers de papel nascem DEPOIS do publish (o match já rodou; o upsert dele não sobrescreve estágio).
      const { wa, wb, wc, ws } = seedRoleWorkers();
      workerIds.push(wa, wb, wc, ws);
      for (const w of [wa, wb, wc, ws]) workerVacancyPairs.push({ workerId: w, vacancyId: v });
      // Invitados = INVITED/system COM `messaged_at` (INVITED/manual é a coluna Iniciado; INVITED/system sem envio é
      // candidato do match) — mesma semente de `seedVacancyWithCards` (funnel-move-e2e-helper.ts).
      const wjaA = insertWJA({ workerId: wa, jobPostingId: v, funnelStage: 'INVITED', source: 'system' });
      runSQL(`UPDATE worker_job_applications SET messaged_at = NOW() WHERE id = '${wjaA}'`);
      insertWJA({ workerId: wb, jobPostingId: v, funnelStage: 'SELECTED' });
      insertWJA({ workerId: wc, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: ws, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const isMovePut = (r: Response): boolean => r.request().method() === 'PUT' && /\/move$/.test(r.url());

      await test.step('passo 4 — quadro B pela tela: Invitados (por semente — convidar é canal real) direto para Equipe de Resposta Rápida com motivo e trilha; Rejeitados sem motivo recusado e com motivo aceito; X não muda (invariantes 5, 11 e 3)', async () => {
        const statusBefore = await readPatientStatusApi(request, backendUrl(), token, X.patientId);
        const trailBeforeA = countTrail(wjaA);
        await gotoVacancyDetail(page, v);
        await switchToKanban(page, v);
        await expect(
          page.locator(`[data-testid="kanban-column-INVITED"] [data-testid="kanban-card-${wjaA}"]`),
        ).toBeVisible({ timeout: 15_000 });

        // Salto Invitados → Equipe de Resposta Rápida: o 1º PUT pede motivo (422), o 2º leva a categoria.
        const [firstPut] = await Promise.all([
          page.waitForResponse(isMovePut),
          dndKitDrag(page, page.locator(`[data-testid="kanban-draggable-${wjaA}"]`), page.locator('[data-testid="kanban-column-QUICK_RESPONSE_TEAM"]')),
        ]);
        expect(firstPut.status()).toBe(422);
        const moveReasonModal = page.getByTestId('move-reason-modal');
        await expect(moveReasonModal).toBeVisible();
        const [secondPut] = await Promise.all([
          page.waitForResponse(isMovePut),
          chooseReasonInModal(page, 'move-reason', 'ENCUADRE_ANTECIPADO'),
        ]);
        expect(secondPut.ok(), `2º PUT ${secondPut.status()}`).toBe(true);
        await expect(moveReasonModal).toHaveCount(0);
        await expect(
          page.locator(`[data-testid="kanban-column-QUICK_RESPONSE_TEAM"] [data-testid="kanban-card-${wjaA}"]`),
        ).toBeVisible({ timeout: 10_000 });
        const trailA = readTrail(wjaA);
        expect(trailA.length).toBe(trailBeforeA + 1);
        const lastA = trailA[trailA.length - 1];
        expect(lastA.oldValue).toBe('INVITED');
        expect(lastA.newValue).toBe('QUICK_RESPONSE_TEAM');
        expect(lastA.changedBy).toBe(`staff:${STAFF.uid}`);
        expect(new Date(lastA.createdAt).getTime()).toBeGreaterThanOrEqual(t0.getTime());
        expect(lastA.reasonCategory).toBe('ENCUADRE_ANTECIPADO');

        // M a Rejeitados SEM motivo — pela API (molde `funil-rejeitar-exige-motivo`): 422, M fica em Compatíveis.
        // (Compatíveis é a coluna do INVITED/system sem envio — o estágio gravado não muda, e M segue na coluna.)
        const stageMBefore = getWjaByWorkerAndJob(m, v)?.funnelStage;
        const encuadreM = upsertEncuadre({ workerId: m, jobPostingId: v });
        const noReason = await putMove(request, backendUrl(), token, encuadreM, { targetStage: 'REJECTED' });
        const noReasonBody = noReason.body as { code?: string; reason?: string };
        expect(noReason.status).toBe(422);
        expect(noReasonBody.code).toBe('MOVE_REASON_REQUIRED');
        expect(noReasonBody.reason).toBe('ENTER_REJECTED');
        expect(getWjaByWorkerAndJob(m, v)?.funnelStage).toBe(stageMBefore);
        const funnelAfterNoReason = (await readFunnelApi(request, token, v)) as { stages?: Record<string, FunnelStageItem[]> };
        expect((funnelAfterNoReason.stages?.COMPATIBLE ?? []).some((it) => it.workerId === m)).toBe(true);

        // M a Rejeitados pela TELA: o modal abre antes de qualquer PUT e não confirma sem categoria.
        await dndKitDrag(page, page.locator(`[data-testid="kanban-draggable-${wjaM}"]`), page.locator('[data-testid="kanban-column-REJECTED"]'));
        const rejectionModal = page.getByTestId('rejection-modal');
        await expect(rejectionModal).toBeVisible();
        await expect(page.getByTestId('rejection-confirm')).toBeDisabled();
        const [rejectPut] = await Promise.all([
          page.waitForResponse(isMovePut),
          chooseReasonInModal(page, 'rejection', 'DISTANCE'),
        ]);
        expect(rejectPut.ok(), `PUT Rejeitados ${rejectPut.status()}`).toBe(true);
        await expect(rejectionModal).toHaveCount(0);
        const trailM = readTrail(wjaM);
        const lastM = trailM[trailM.length - 1];
        expect(lastM.newValue).toBe('REJECTED');
        expect(lastM.reasonCategory).toBe('DISTANCE');

        const statusAfter = await readPatientStatusApi(request, backendUrl(), token, X.patientId);
        expect(statusBefore).toBe('SEARCHING');
        expect(statusAfter).toBe(statusBefore);
        console.log('[16.p4]', wjaA, firstPut.status(), secondPut.status(), lastA.oldValue, lastA.newValue, lastA.reasonCategory,
          'sem-motivo-via-api', noReason.status, noReasonBody.code, noReasonBody.reason,
          'tela', rejectPut.status(), lastM.newValue, lastM.reasonCategory, statusBefore, statusAfter);
      });

      await test.step('passo 5 — quadro C pela tela: WA em Selecionado, só-Selecionados-de-B fora, C do serviço 2 vazio, rejeitar em C com motivo não mexe em B nem em X (invariantes 1, 8, 6, 11 e 3)', async () => {
        await openServiceTeamOf(page, X.patientId, X.service1Id);
        const selected = page.getByTestId('kanban-column-SELECTED_FOR_SERVICE');
        for (const w of [wa, wc, ws]) await expect(selected.getByTestId(`service-team-card-${w}`)).toHaveCount(1);
        for (const w of [wb, m]) await expect(page.getByTestId(`service-team-card-${w}`)).toHaveCount(0);

        await selectServiceRow(page, X.service2Id);
        await expect(page.getByTestId('quadro-c-sem-vaga')).toBeVisible();
        await expect(page.locator('[data-testid^="kanban-column-"]')).toHaveCount(0);
        const teamS2 = await readServiceTeamApi(request, X.patientId, X.service2Id);
        expect(teamS2.body.data?.vacancyId ?? null).toBeNull();

        await selectServiceRow(page, X.service1Id);
        await expect(selected.getByTestId(`service-team-card-${wc}`)).toHaveCount(1);
        // Rejeitar em C SEM motivo — pela API (molde `quadro-c-rejeitar-exige-motivo`): 422, nenhuma marca.
        const noReason = await postServiceTeamAction(request, X.patientId, X.service1Id, 'reject', { workerId: wc });
        expect(noReason.status).toBe(422);
        expect(noReason.body.code).toBe('SERVICE_TEAM_REASON_REQUIRED');
        expect(countMarks(X.service1Id, wc)).toBe(0);

        await page.getByTestId(`service-team-reject-${wc}`).click();
        await expect(page.getByTestId('service-team-reject-confirm')).toBeDisabled();
        await chooseReasonInModal(page, 'service-team-reject', 'DESISTENCIA_DO_PRESTADOR');
        await expect(
          page.getByTestId('kanban-column-REJECTED_FOR_SERVICE').getByTestId(`service-team-card-${wc}`),
        ).toBeVisible({ timeout: 10_000 });
        const marks = countMarks(X.service1Id, wc, { active: true });
        expect(marks).toBe(1);
        const stageWc = getWjaByWorkerAndJob(wc, v)?.funnelStage;
        expect(stageWc).toBe('QUICK_RESPONSE_TEAM');
        const status = await readPatientStatusApi(request, backendUrl(), token, X.patientId);
        expect(status).toBe('SEARCHING');
        console.log('[16.p5]', X.service1Id, X.service2Id, teamS2.body.data?.vacancyId ?? null,
          'sem-motivo-via-api', noReason.status, noReason.body.code, 'tela', marks, stageWc, status);
      });
    } finally {
      await test.step('passo 11 — desmontar tudo o que criou, na ordem das fases (resíduo 0 por id; invariantes 1 a 11 sem sobra)', async () => {
        const control = residueByIds({ patientIds, workerIds });
        const events = Number(
          runSQL(
            `SELECT count(*) FROM domain_events WHERE payload->>'workerId' IN (${idList(workerIds)}) ` +
              `OR payload->>'patientId' IN (${idList(patientIds)})`,
          ),
        );
        cleanupCadeia({ patientIds, workerVacancyPairs, workerIds, seeds });
        runSQL(
          `DELETE FROM domain_events WHERE payload->>'workerId' IN (${idList(workerIds)}) ` +
            `OR payload->>'patientId' IN (${idList(patientIds)})`,
        );
        const residue = residueByIds({ patientIds, workerIds });
        const eventsAfter = Number(
          runSQL(
            `SELECT count(*) FROM domain_events WHERE payload->>'workerId' IN (${idList(workerIds)}) ` +
              `OR payload->>'patientId' IN (${idList(patientIds)})`,
          ),
        );
        const post = countPatients();
        console.log('[16.p11]', control, events, residue, eventsAfter);
        console.log('[16.5]', pre, post, control.patients, residue.patients);
        console.log('[16.6]', residue.workers, residue.wja, residue.assignments, eventsAfter);
        expect(control.patients).toBe(patientIds.length);
        expect(residue).toEqual({ patients: 0, workers: 0, wja: 0, assignments: 0 });
        expect(eventsAfter).toBe(0);
        expect(post).toBe(pre);
      });
      await stub.close();
      const t = tally();
      console.log('[16.p11-tally]', t.forbidden.length, t.apiHits, t.observedHits);
    }
  });
});
