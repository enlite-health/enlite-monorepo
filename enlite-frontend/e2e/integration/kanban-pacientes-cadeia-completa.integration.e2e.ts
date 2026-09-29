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
  openPatientKanbanBoard, launchViaApi, type FunnelStageItem,
} from '../helpers/lancamento-e2e-helper';
import {
  readPatientStatusApi, countOutboundSince, readTrail, countTrail, putMove, chooseReasonInModal,
} from '../helpers/funnel-move-e2e-helper';
import { readFunnelApi, gotoVacancyDetail, switchToKanban } from '../helpers/compativeis-e2e-helper';
import { readItineraryApi, type ReadItineraryResult, type ItineraryResponseDto } from '../helpers/itinerario-e2e-helper';
import {
  assembleApi, allocationOptionsApi, endAllocationApi, countActiveAllocations,
} from '../helpers/itinerario-escrita-e2e-helper';
import { openItineraryTab } from '../helpers/itinerario-aba-e2e-helper';
import { readSubcardPair, pairFromItinerary } from '../helpers/kanban-subcard-e2e-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { insertWJA, upsertEncuadre, getWjaByWorkerAndJob } from '../helpers/wja-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import {
  readServiceTeamApi, postServiceTeamAction, countMarks, selectServiceRow, openEncuadreTab,
} from '../helpers/quadro-c-e2e-helper';
import { openServiceTeamOf, nextWeekdaySql } from '../helpers/substituicao-e2e-helper';
import {
  seedCadeia, seedRoleWorkers, seedPatientZ, seedMarkedWorker, countPatients, residueByIds, cleanupCadeia, collectRequests, readKanbanState,
  lastStatusChangeSource, printPath, type CadeiaPatientX, type CadeiaPatientWithVacancy,
} from '../helpers/cadeia-completa-e2e-helper';

const STAFF = mockAdminUserFor('cadeia-completa');

interface OptionDto { workerId: string; displayName: string | null }
interface OverlapSideDto { startTime: string; endTime: string }
interface OverlapBody { code?: string; existing?: OverlapSideDto; requested?: OverlapSideDto; minGapMinutes?: number | null }
/** O campo da Fase 13 (`substitutionDates`) que o `ServiceTeamDto` da Fase 10 ainda não tipa. */
interface InServiceF13 { workerId: string; substitutionDates?: string[] }

/** M entra UMA vez numa etapa de `FUNNEL_STAGES` (Rejeitados, passo 4) → 1 `domain_events` sem consumidor (mapa ⚠1). */
const M_FUNNEL_STAGE_ENTRIES = 1;
/** WZ entra UMA vez em Selecionados (etapa de `FUNNEL_STAGES`) → 1 `domain_events`, sem outbox nem log de mensagem. */
const WZ_FUNNEL_STAGE_ENTRIES = 1;

function itineraryData(res: ReadItineraryResult): ItineraryResponseDto {
  if (res.status !== 200 || !res.body.data) throw new Error(`GET itinerary ${res.status}`);
  return res.body.data;
}

const idList = (ids: string[]): string => (ids.length ? ids.map((id) => `'${id}'`).join(',') : 'NULL');

interface CadeiaIds {
  patientIds: string[];
  workerIds: string[];
  workerVacancyPairs: Array<{ workerId: string; vacancyId: string }>;
  seeds: Array<{ cleanup: () => void }>;
}

const countEventsOf = (ids: CadeiaIds): number => Number(
  runSQL(
    `SELECT count(*) FROM domain_events WHERE payload->>'workerId' IN (${idList(ids.workerIds)}) ` +
      `OR payload->>'patientId' IN (${idList(ids.patientIds)})`,
  ),
);

/**
 * Desmonte por id (DX-16.7): controle ANTES (pacientes = nº de ids), `cleanupCadeia` na ordem da regra 13, os
 * `domain_events` dos ids (mapa ⚠3, molde `account-link-real`), resíduo 0 e `count(*) patients` = o do início.
 */
function teardownById(ids: CadeiaIds, pre: number, marker: string): void {
  const control = residueByIds(ids);
  const events = countEventsOf(ids);
  cleanupCadeia(ids);
  runSQL(
    `DELETE FROM domain_events WHERE payload->>'workerId' IN (${idList(ids.workerIds)}) ` +
      `OR payload->>'patientId' IN (${idList(ids.patientIds)})`,
  );
  const residue = residueByIds(ids);
  const eventsAfter = countEventsOf(ids);
  const post = countPatients();
  console.log(marker, control, events, residue, eventsAfter);
  console.log('[16.5]', pre, post, control.patients, residue.patients);
  console.log('[16.6]', residue.workers, residue.wja, residue.assignments, eventsAfter);
  expect(control.patients).toBe(ids.patientIds.length);
  expect(residue).toEqual({ patients: 0, workers: 0, wja: 0, assignments: 0 });
  expect(eventsAfter).toBe(0);
  expect(post).toBe(pre);
}

test.describe('cadeia-completa @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(300_000);
  useLancamentoStaff(STAFF, 'E2E Cadeia Completa F16');

  test('cadeia-completa — os onze invariantes numa execução', async ({ page, request }, testInfo) => {
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

      const Y = y;
      let allocationId = '';
      let par0 = '';
      let par0s2 = '';
      let par1 = '';
      let columnP8 = '';

      /** Board do Kanban de pacientes com o card de X à vista (e o print `fullPage`, se houver `PRINT_DIR` — DX-16.8). */
      const openBoardAtX = async (printName: string): Promise<void> => {
        await openPatientKanbanBoard(page);
        const card = page.getByTestId(`patient-kanban-card-${X.patientId}`);
        await expect(card).toBeVisible({ timeout: 15_000 });
        await card.scrollIntoViewIfNeeded();
        await page.evaluate(() => document.fonts.ready);
        const path = printPath(printName);
        if (path) await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' });
      };

      /**
       * Aba Itinerario aberta: "Asignar" do slot → modal → busca pelo rótulo visível → confirmar. Devolve o POST.
       * `listed` = nº de opções esperado na lista aberta (o `SearchableSelect` abre com 1 linha de placeholder a mais).
       */
      const allocateOnScreen = async (slotId: string, label: string, listed?: number): Promise<Response> => {
        await page.getByTestId(`itinerario-slot-asignar-${slotId}`).click();
        const modal = page.getByTestId('itinerario-alocar-modal');
        await expect(modal).toBeVisible();
        await modal.getByTestId('itinerario-alocar-prestador').click();
        if (listed !== undefined) await expect(modal.getByRole('option')).toHaveCount(listed + 1);
        const search = modal.getByRole('textbox');
        await search.click();
        await search.pressSequentially(label, { delay: 20 });
        await modal.getByRole('option', { name: label }).click();
        const [postResp] = await Promise.all([
          page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith(`/slots/${slotId}/allocations`)),
          modal.getByTestId('itinerario-alocar-confirmar').click(),
        ]);
        return postResp;
      };

      await test.step('passo 6 — itinerário pela tela: montado (via API — a aba da Fase 12 não marca montado), as opções são exatamente Selecionado (C), alocar WA; em C ele vai a Em Atendimento (invariantes 2 e 5)', async () => {
        await openBoardAtX('kanban-antes-da-alocacao');
        par0 = await readSubcardPair(page, X.service1Id);
        par0s2 = await readSubcardPair(page, X.service2Id);
        const itin0 = itineraryData(await readItineraryApi(request, X.patientId));
        expect(par0).toBe(pairFromItinerary(itin0, X.service1Id));
        expect(par0s2).toBe(pairFromItinerary(itin0, X.service2Id));

        const assembled = await assembleApi(request, token, X.patientId);
        expect(assembled.status, `assemble ${assembled.status}`).toBeLessThan(300);

        // Invariante 5: só quem foi candidato ERR (e não rejeitado em C) aparece — WB, WC e M ficam fora.
        const opts = await allocationOptionsApi(request, token, X.patientId, X.service1Id);
        expect(opts.status).toBe(200);
        const options = (opts.body.data as { options: OptionDto[] } | undefined)?.options ?? [];
        expect(options.map((o) => o.workerId).sort()).toEqual([wa, ws].sort());
        const waLabel = options.find((o) => o.workerId === wa)?.displayName;
        if (!waLabel) throw new Error('passo 6: WA sem displayName nas opções');
        const slot1 = itin0.services.find((s) => s.contractedServiceId === X.service1Id)?.slots.find((s) => s.startTime.startsWith('08:00'));
        if (!slot1) throw new Error('passo 6: slot 08:00 do serviço 1 ausente');

        await openItineraryTab(page, X.patientId);
        const postResp = await allocateOnScreen(slot1.id, waLabel, options.length);
        expect(postResp.status()).toBe(201);
        allocationId = ((await postResp.json()) as { data?: { allocationId?: string } }).data?.allocationId ?? '';
        expect(allocationId).not.toBe('');
        await expect(page.getByTestId(`itinerario-slot-prestador-${slot1.id}-${wa}`)).toBeVisible({ timeout: 15_000 });

        // 29/09: o quadro C saiu de "Servicio Contratado" — a aba certa agora é "Encuadre".
        await openEncuadreTab(page, X.patientId);
        await selectServiceRow(page, X.service1Id);
        await expect(page.getByTestId('kanban-column-IN_SERVICE').getByTestId(`service-team-card-${wa}`)).toHaveCount(1);
        await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${wa}`)).toHaveCount(0);
        console.log('[16.p6]', par0, par0s2, assembled.status, options.length, slot1.id, postResp.status(), allocationId);
      });

      insertWJA({ workerId: wa, jobPostingId: Y.vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      workerVacancyPairs.push({ workerId: wa, vacancyId: Y.vacancyId });

      await test.step('passo 7 — pela tela, WA no paciente Y em outro endereço no mesmo dia: 30 min depois do fim do passo 6 → recusado e dito; 1h depois → aceito (invariante 4)', async () => {
        const slotsY = itineraryData(await readItineraryApi(request, Y.patientId))
          .services.find((s) => s.contractedServiceId === Y.serviceId)?.slots ?? [];
        const slotEarly = slotsY.find((s) => s.startTime.startsWith('12:30'));
        const slotLate = slotsY.find((s) => s.startTime.startsWith('13:00'));
        if (!slotEarly || !slotLate) throw new Error('passo 7: slots 12:30/13:00 de Y ausentes');
        const optsY = await allocationOptionsApi(request, token, Y.patientId, Y.serviceId);
        const waLabelY = ((optsY.body.data as { options: OptionDto[] } | undefined)?.options ?? []).find((o) => o.workerId === wa)?.displayName;
        if (!waLabelY) throw new Error('passo 7: WA sem displayName nas opções de Y');

        await openItineraryTab(page, Y.patientId);
        const early = await allocateOnScreen(slotEarly.id, waLabelY);
        expect(early.status()).toBe(409);
        const body = (await early.json()) as OverlapBody;
        expect(body.code).toBe('ITINERARY_OVERLAP');
        expect(body.minGapMinutes ?? null).not.toBeNull();
        if (!body.existing || !body.requested) throw new Error('passo 7: 409 sem existing/requested');
        const erro = page.getByTestId('itinerario-sobreposicao-erro');
        await expect(erro).toBeVisible();
        await expect(erro).toContainText(`${body.existing.startTime}-${body.existing.endTime}`);
        await expect(erro).toContainText(`${body.requested.startTime}-${body.requested.endTime}`);
        await expect(erro).toContainText(String(body.minGapMinutes));

        const late = await allocateOnScreen(slotLate.id, waLabelY);
        expect(late.status()).toBe(201);
        await expect(page.getByTestId(`itinerario-slot-prestador-${slotLate.id}-${wa}`)).toBeVisible({ timeout: 15_000 });
        const active = countActiveAllocations(wa);
        expect(active).toBe(2);
        console.log('[16.p7]', early.status(), body.code, body.minGapMinutes !== null, late.status(), active);
      });

      await test.step('passo 8 — na tela do Kanban de X: o par cobertas/contratadas do subcard do serviço 1 e a coluna mudaram por causa do passo 6, sem ninguém arrastar card (invariante 3)', async () => {
        const state = await readKanbanState(page, X.patientId, X.service1Id);
        const s2Pair = await readSubcardPair(page, X.service2Id);
        par1 = pairFromItinerary(itineraryData(await readItineraryApi(request, X.patientId)), X.service1Id);
        expect(state.pair).toBe(par1);
        expect(state.pair).not.toBe(par0);
        expect(s2Pair).toBe(par0s2);
        const apiStatus = await readPatientStatusApi(request, backendUrl(), token, X.patientId);
        expect(state.column).toBe(apiStatus);
        expect(state.column).not.toBe('SEARCHING');
        const source = lastStatusChangeSource(X.patientId);
        expect(source).toBe('system');
        columnP8 = state.column;

        await openBoardAtX('kanban-depois-da-alocacao');
        const card = page.getByTestId(`patient-kanban-card-${X.patientId}`);
        await expect(card).toHaveScreenshot(`${testInfo.project.name}-cadeia-completa-card-x.png`, {
          maxDiffPixelRatio: 0.05,
          animations: 'disabled',
          caret: 'hide',
          // Nome e nº do caso (cabeçalho do card) e as horas na etapa mudam por semente.
          mask: [card.locator(':scope > div').first(), page.getByTestId(`sla-badge-${X.patientId}`)],
        });
        console.log('[16.p8]', par0, par1, s2Pair, columnP8, apiStatus, source);
      });

      await test.step('passo 9 — quadro C pela tela: ausência do titular numa data com substituto vindo de Selecionado (C); o par e a coluna do passo 8 não mudam; rejeitar o titular alocado → recusado (recusa via API, molde da Fase 10) (invariantes 9, 3 e 10)', async () => {
        const d = nextWeekdaySql(1);
        const teamBefore = await readServiceTeamApi(request, X.patientId, X.service1Id);
        const wsLabel = (teamBefore.body.data?.selected ?? []).find((mm) => mm.workerId === ws)?.displayName;
        if (!wsLabel) throw new Error('passo 9: WS sem displayName no time');

        await openServiceTeamOf(page, X.patientId, X.service1Id);
        await page.getByTestId(`service-team-substitute-${wa}`).click();
        await expect(page.getByTestId('substitution-modal')).toBeVisible();
        await page.getByTestId('substitution-date').selectOption(d);
        await page.getByTestId('substitution-worker').click();
        await page.getByPlaceholder('Buscar...').pressSequentially(wsLabel, { delay: 20 });
        await page.getByRole('option', { name: wsLabel }).click();
        await Promise.all([
          page.waitForResponse((r) => r.request().method() === 'GET' && r.url().includes('/contracted-services/') && r.url().endsWith('/team') && r.ok()),
          page.getByTestId('substitution-confirm').click(),
        ]);

        const after = await readServiceTeamApi(request, X.patientId, X.service1Id);
        const inService = (after.body.data as unknown as { inService: InServiceF13[] } | undefined)?.inService ?? [];
        expect(inService.find((mm) => mm.workerId === ws)?.substitutionDates).toEqual([d]);
        expect(inService.some((mm) => mm.workerId === wa)).toBe(true);
        const chip = page.getByTestId(`service-team-card-${ws}`).getByTestId('card-datas-substituicao');
        await expect(chip).toHaveCount(1);
        const [, month, day] = d.split('-');
        await expect(chip).toContainText(`${day}/${month}`);

        const state = await readKanbanState(page, X.patientId, X.service1Id);
        expect(state).toEqual({ column: columnP8, pair: par1 });

        const rejectAllocated = await postServiceTeamAction(request, X.patientId, X.service1Id, 'reject', {
          workerId: wa, reasonCategory: 'OTHER',
        });
        expect(rejectAllocated.status).toBe(422);
        expect(rejectAllocated.body.code).toBe('SERVICE_TEAM_WORKER_ALLOCATED');
        const marksWa = countMarks(X.service1Id, wa, { active: true });
        expect(marksWa).toBe(0);
        console.log('[16.p9]', d, inService.length, state.column, state.pair, 'recusa-via-api', rejectAllocated.status, rejectAllocated.body.code, marksWa);
      });

      await test.step('passo 10 — encerrar a alocação do passo 6 (via API, Fase 12 não encerra pela tela): WA volta a Selecionado (C) e X é recalculado — volta a Búsqueda (invariante 2)', async () => {
        const end = await endAllocationApi(request, token, X.patientId, X.service1Id, allocationId);
        expect(end.status, `end ${end.status} ${end.body.code ?? ''}`).toBe(200);
        await openServiceTeamOf(page, X.patientId, X.service1Id);
        await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${wa}`)).toHaveCount(1);
        const state = await readKanbanState(page, X.patientId, X.service1Id);
        expect(state.column).toBe('SEARCHING');
        expect(state.pair).toBe(par0);
        console.log('[16.p10]', 'via-api', end.status, state.column, state.pair);
      });

      // Critério 7 (DX-16.6): navegador por hostname + backend por worker; maps só impresso (mapa ⚠2).
      const net = tally();
      const outbound = {
        m: countOutboundSince(m, t0), wa: countOutboundSince(wa, t0), wb: countOutboundSince(wb, t0),
        wc: countOutboundSince(wc, t0), ws: countOutboundSince(ws, t0),
      };
      const creates = stub.calls.filter((c) => c.method === 'POST' && c.path === '/pre-screening/projects').length;
      console.log('[16.7]', net.forbidden.length, net.apiHits, net.observedHits, outbound, creates);
      expect(net.forbidden).toEqual([]);
      expect(net.apiHits).toBeGreaterThan(0);
      for (const w of [outbound.wa, outbound.wb, outbound.wc, outbound.ws]) {
        expect(w).toEqual({ domainEvents: 0, stageMessageLog: 0, outbox: 0 });
      }
      expect(outbound.m).toEqual({ domainEvents: M_FUNNEL_STAGE_ENTRIES, stageMessageLog: 0, outbox: 0 });
      expect(creates).toBe(1);
    } finally {
      await test.step('passo 11 — desmontar tudo o que criou, na ordem das fases (resíduo 0 por id; invariantes 1 a 11 sem sobra)', async () => {
        teardownById({ patientIds, workerIds, workerVacancyPairs, seeds }, pre, '[16.p11]');
      });
      await stub.close();
    }
  });

  test('cadeia-completa-silencio — selecionado não é alocado', async ({ page, request }) => {
    const token = tokenFor(STAFF);
    const pre = countPatients();
    const tally = collectRequests(page);
    const stub = await startTalentumStub();
    const ids: CadeiaIds = { patientIds: [], workerIds: [], workerVacancyPairs: [], seeds: [] };

    try {
      // Z já lançado (a vaga existe de verdade → SEARCHING) e MONTADO: a derivação poderia mover — o silêncio só
      // vale com ela armada. O lançamento é pela API (molde `launchViaApi`); a Talentum vai ao stub.
      const z = await seedPatientZ(request);
      ids.patientIds.push(z.patientId);
      ids.seeds.push(z);
      const launched = await launchViaApi(request, token, z.vacancyId);
      expect(launched).toBe(200);
      expect(await readPatientStatusApi(request, backendUrl(), token, z.patientId)).toBe('SEARCHING');
      const assembled = await assembleApi(request, token, z.patientId);
      expect(assembled.status, `assemble ${assembled.status}`).toBeLessThan(300);
      // WZ nasce DEPOIS do lançamento (fora do match), em Confirmado.
      const wz = seedMarkedWorker('WZ');
      ids.workerIds.push(wz);
      ids.workerVacancyPairs.push({ workerId: wz, vacancyId: z.vacancyId });
      const wjaZ = insertWJA({ workerId: wz, jobPostingId: z.vacancyId, funnelStage: 'CONFIRMED' });
      // Card sem encuadre não arrasta (`KanbanBoard.tsx` `isDragDisabled`) — mesma semente de `seedVacancyWithCards`.
      upsertEncuadre({ workerId: wz, jobPostingId: z.vacancyId });

      await loginAndMockAi(page, STAFF);
      const t0 = new Date(); // o corte do `countOutboundSince` de WZ — a mesma exceção declarada do 1º teste

      const columnBefore = await readPatientKanbanColumn(page, z.patientId);
      const pairBefore = await readSubcardPair(page, z.serviceId);
      let putStatus = 0;

      await test.step('silencio 1 — levar WZ pela tela de Confirmado a Selecionados de B, sem Equipe de Resposta Rápida e sem alocação (invariantes 1 e 3)', async () => {
        await gotoVacancyDetail(page, z.vacancyId);
        await switchToKanban(page, z.vacancyId);
        await expect(
          page.locator(`[data-testid="kanban-column-CONFIRMED"] [data-testid="kanban-card-${wjaZ}"]`),
        ).toBeVisible({ timeout: 15_000 });
        // Confirmado é a 6ª coluna: fora da viewport de 1366 (medido: x = 1766) — o `dndKitDrag` mede a ORIGEM sem rolar.
        const sourceZ = page.locator(`[data-testid="kanban-draggable-${wjaZ}"]`);
        await sourceZ.scrollIntoViewIfNeeded();
        await dndKitDrag(page, sourceZ, page.locator('[data-testid="kanban-column-SELECTED"]'));
        // Entrar em Selecionados abre o diálogo de PAPEL antes do PUT (não é motivo — molde `kanban-fase2-full-flow`).
        const roleModal = page.getByTestId('role-modal');
        await expect(roleModal).toBeVisible({ timeout: 10_000 });
        await page.getByTestId('role-option-titular').getByRole('radio').click();
        const [put] = await Promise.all([
          page.waitForResponse((r) => r.request().method() === 'PUT' && /\/move$/.test(r.url())),
          page.getByTestId('role-confirm').click(),
        ]);
        await expect(roleModal).toHaveCount(0);
        putStatus = put.status();
        expect(put.ok(), `PUT Confirmado → Selecionados ${putStatus}`).toBe(true);
        await expect(
          page.locator(`[data-testid="kanban-column-SELECTED"] [data-testid="kanban-card-${wjaZ}"]`),
        ).toBeVisible({ timeout: 10_000 });
        expect(getWjaByWorkerAndJob(wz, z.vacancyId)?.funnelStage).toBe('SELECTED');
      });

      await test.step('silencio 2 — nada move em A e nada entra em C (invariantes 3, 1 e 2)', async () => {
        const state = await readKanbanState(page, z.patientId, z.serviceId);
        expect(columnBefore).toBe('SEARCHING');
        expect(state).toEqual({ column: columnBefore, pair: pairBefore });
        const source = lastStatusChangeSource(z.patientId);
        expect(source).toBe('vacancy_launch');
        const systemTrail = Number(
          runSQL(`SELECT count(*) FROM patient_status_history WHERE patient_id = '${z.patientId}' AND change_source = 'system'`),
        );
        expect(systemTrail).toBe(0);

        const team = await readServiceTeamApi(request, z.patientId, z.serviceId);
        expect(team.status).toBe(200);
        const inTeam = [...(team.body.data?.selected ?? []), ...(team.body.data?.inService ?? [])].some((mm) => mm.workerId === wz);
        expect(inTeam).toBe(false);
        await openServiceTeamOf(page, z.patientId, z.serviceId);
        await expect(page.getByTestId('quadro-c-secao')).toBeVisible();
        await expect(page.getByTestId(`service-team-card-${wz}`)).toHaveCount(0);
        const opts = await allocationOptionsApi(request, token, z.patientId, z.serviceId);
        expect(opts.status).toBe(200);
        const optionIds = ((opts.body.data as { options: OptionDto[] } | undefined)?.options ?? []).map((o) => o.workerId);
        expect(optionIds).not.toContain(wz);

        const net = tally();
        const outWz = countOutboundSince(wz, t0);
        const creates = stub.calls.filter((c) => c.method === 'POST' && c.path === '/pre-screening/projects').length;
        expect(net.forbidden).toEqual([]);
        expect(net.apiHits).toBeGreaterThan(0);
        expect(outWz).toEqual({ domainEvents: WZ_FUNNEL_STAGE_ENTRIES, stageMessageLog: 0, outbox: 0 });
        expect(creates).toBe(1);
        console.log('[16.4-silencio]', z.patientId, launched, assembled.status, putStatus, columnBefore, state.column,
          pairBefore, state.pair, source, systemTrail, inTeam, optionIds.length,
          net.forbidden.length, net.apiHits, net.observedHits, outWz, creates);
      });
    } finally {
      teardownById(ids, pre, '[16.silencio-desmonte]');
      await stub.close();
    }
  });
});
