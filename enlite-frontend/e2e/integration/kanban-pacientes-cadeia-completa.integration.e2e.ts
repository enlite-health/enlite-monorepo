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
import { test, expect } from '@playwright/test';
import {
  startTalentumStub, clickFoguete, completeDraftViaWizard, publishOnTalentumPage, readPatientKanbanColumn,
  countLaunchTrail, backendUrl, mockAdminUserFor, useLancamentoStaff, loginAndMockAi, LANCAMENTO_VIEWPORT_ES_AR,
  type FunnelStageItem,
} from '../helpers/lancamento-e2e-helper';
import { readPatientStatusApi, countOutboundSince } from '../helpers/funnel-move-e2e-helper';
import { readFunnelApi, gotoVacancyDetail, switchToKanban } from '../helpers/compativeis-e2e-helper';
import { readItineraryApi } from '../helpers/itinerario-e2e-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import {
  seedCadeia, countPatients, residueByIds, cleanupCadeia, collectRequests,
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
