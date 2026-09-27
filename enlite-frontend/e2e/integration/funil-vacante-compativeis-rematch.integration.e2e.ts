/**
 * funil-vacante-compativeis-rematch.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 5 da change cadeia-paciente-vacante-itinerario (P19):
 * re-match não ressuscita quem foi Rejeitado pela tela (critério 4, DX-5.12/DX-5.13).
 * Este é o teste-alvo direto da sabotagem do critério 5 (P25) — tem de MORRER se o
 * `saveMatchResults` (upsert do match, `ON CONFLICT (worker_id, job_posting_id) DO
 * UPDATE SET`) passar a sobrescrever `application_funnel_stage`/`source`/`messaged_at`
 * de um WJA que já saiu do estado "candidato do match" (`WF/domain/kanbanColumn.ts`).
 *
 * Geografia isolada (DX-5.13): a vaga nasce numa coordenada própria e os workers a
 * ~100 m dela — a contagem de Compatíveis não depende do lixo de outros e2e (a prova
 * é o DELTA e a pertença de R/N, nunca a contagem absoluta).
 *
 * Três workers, todos REGISTERED e dentro do raio do hard filter:
 *   R — entra em Compatíveis no 1º match, é rejeitado PELA TELA (Kanban →
 *       `dragKanbanCard` → modal de motivo, o mesmo caminho de
 *       `funil-vacante-motivo.integration.e2e.ts`) e não pode voltar a Compatíveis
 *       no 2º match — é a lacuna C se voltar.
 *   C — entra em Compatíveis no 1º match e não é tocado (contexto: mais de um
 *       candidato coexistindo com o rejeitado).
 *   N — nasce DEPOIS do 1º match, sem WJA — o controle positivo: prova que o 2º
 *       match ENTREGA candidato novo (não que ele simplesmente não fez nada).
 *
 * `getWjaByWorkerAndJob` (backend) confirma o estágio real de R; `readFunnelApi`
 * confirma a pertença a `stages.COMPATIBLE`; a tela (recarregada) confirma os 3
 * lugares na prática. `countOutboundSince` prova que o match, sozinho, não envia
 * nada (0 em `messaging_outbox` para R, C e N).
 */

import { test, expect, type Page } from '@playwright/test';
import {
  seedIsolatedVacancy,
  runMatchApi,
  readFunnelApi,
  gotoVacancyDetail,
  switchToKanban,
  readStageCount,
} from '../helpers/compativeis-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { getWjaByWorkerAndJob, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { dragKanbanCard } from '../helpers/kanban-notes-e2e-helper';
import { chooseReasonInModal, countOutboundSince } from '../helpers/funnel-move-e2e-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-funil-rematch',
  email: 'staff.funil.rematch@e2e.test',
  role: 'admin',
  country: 'AR',
};
const MOCK_TOKEN = tokenFor(MOCK_STAFF);

// Geografia isolada (DX-5.13) — paciente numa coordenada própria; workers ~100 m dela
// (0.0009° de latitude ≈ 100 m).
const PATIENT_LAT = -54.8019;
const PATIENT_LNG = -68.303;
const WORKER_LAT = PATIENT_LAT + 0.0009;
const WORKER_LNG = PATIENT_LNG;

interface FunnelApiData {
  stages: Record<string, Array<{ workerId?: string | null }>>;
}

function workerIdsInStage(data: FunnelApiData, stage: string): Array<string | null | undefined> {
  return (data.stages[stage] ?? []).map((item) => item.workerId);
}

// `gotoVacancyDetail`/`switchToKanban`/`readStageCount` vivem em `compativeis-e2e-helper.ts`
// (achado 🟡-3 do gate parcial, G2) — importadas acima, byte-idênticas nos 4 specs novos.

/** As 9 colunas do quadro B (`funil-vacante-compativeis.integration.e2e.ts`, P17). */
const ALL_COLUMN_IDS = [
  'COMPATIBLE',
  'INVITED',
  'INICIADO',
  'PRE_SCREENING',
  'COMPLETED',
  'CONFIRMED',
  'SELECTED',
  'QUICK_RESPONSE_TEAM',
  'REJECTED',
] as const;

/**
 * Molde `funil-vacante-motivo.integration.e2e.ts` (Fase 4): o board não cabe no
 * viewport de 1366px — colapsar todas as colunas fora de `keep` encolhe o board até
 * origem e alvo caberem juntos, sem scroll durante o arrasto (senão o auto-scroll de
 * proximidade do dnd-kit desloca o board e o drop erra de coluna).
 */
async function collapseColumnsExcept(page: Page, keep: readonly string[]): Promise<void> {
  for (const id of ALL_COLUMN_IDS) {
    if (keep.includes(id)) continue;
    const collapseButton = page.getByTestId(`kanban-column-${id}-collapse`);
    if (await collapseButton.count()) {
      await collapseButton.click();
    }
  }
  await page.waitForTimeout(400);
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.describe('funil da vacante — re-match não ressuscita rejeitado (P19) @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Funil Rematch');
  });

  test.afterAll(() => {
    cleanupMockStaff(MOCK_STAFF);
  });

  test('funil-rematch-nao-ressuscita-rejeitado', async ({ page, request }) => {
    const t0 = new Date();
    const vacancy = seedIsolatedVacancy({ lat: PATIENT_LAT, lng: PATIENT_LNG });
    // occupation: 'AT' — `seedIsolatedVacancy`/`insertBaseVacancy` nasce com
    // `required_professions = ['AT']` (default); sem occupation, `ProfessionSpecification`
    // (`COALESCE(w.occupation, w.profession)` ? required_professions) exclui o worker no
    // hard filter ANTES de qualquer distância — medido: sem isto, `stages.COMPATIBLE` sai
    // vazio mesmo com R/C dentro do raio.
    const workerR = insertTestWorker({
      firstName: 'RematchR',
      lastName: `Seed-${Date.now()}`,
      lat: WORKER_LAT,
      lng: WORKER_LNG,
      occupation: 'AT',
    });
    const workerC = insertTestWorker({
      firstName: 'RematchC',
      lastName: `Seed-${Date.now()}`,
      lat: WORKER_LAT,
      lng: WORKER_LNG,
      occupation: 'AT',
    });
    let workerN: string | undefined;

    try {
      // (1) 1º match — R e C entram em Compatíveis (hard filter: REGISTERED + raio).
      const match1 = await runMatchApi(request, MOCK_TOKEN, vacancy.vacancyId, { radiusKm: 1, topN: 200 });
      console.log('[5.4] match1.status=', match1.status);
      expect(match1.status, 'POST /match (1º) deveria ser 200').toBe(200);

      const funnel1 = (await readFunnelApi(request, MOCK_TOKEN, vacancy.vacancyId)) as FunnelApiData;
      const compat1WorkerIds = workerIdsInStage(funnel1, 'COMPATIBLE');
      console.log('[5.4] após match1, stages.COMPATIBLE workerIds=', compat1WorkerIds);
      expect(compat1WorkerIds, 'R em Compatíveis após o 1º match').toContain(workerR);
      expect(compat1WorkerIds, 'C em Compatíveis após o 1º match').toContain(workerC);

      const wjaR = getWjaByWorkerAndJob(workerR, vacancy.vacancyId);
      if (!wjaR) throw new Error('getWjaByWorkerAndJob(R) não encontrou WJA após o 1º match');

      // (2) Rejeitar R PELA TELA — Kanban: COMPATIBLE → REJECTED, com motivo (nunca por
      // SQL: o critério quer "rejeitado que passa no hard filter", nascido do match e
      // saído pela tela, não um estado forjado).
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, vacancy.vacancyId);
      await switchToKanban(page, vacancy.vacancyId);
      await collapseColumnsExcept(page, ['COMPATIBLE', 'REJECTED']);

      await dragKanbanCard(page, wjaR.id, 'REJECTED');
      const rejectionModal = page.getByTestId('rejection-modal');
      await expect(rejectionModal).toBeVisible();
      const [putResponse] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        chooseReasonInModal(page, 'rejection', 'DISTANCE'),
      ]);
      expect(putResponse.ok(), `PUT /move deveria ser 2xx, veio ${putResponse.status()}`).toBe(true);
      await expect(rejectionModal).toHaveCount(0);
      await expect(
        page.getByTestId('kanban-column-REJECTED').getByTestId(`kanban-card-${wjaR.id}`),
        'R está em Rejeitados logo após o arrasto',
      ).toBeVisible({ timeout: 10_000 });

      // (3) worker N novo, ~100 m, SEM WJA — o controle positivo do 2º match.
      // compat0 lido AGORA (R já saiu, N ainda não existe pro backend).
      workerN = insertTestWorker({
        firstName: 'RematchN',
        lastName: `Seed-${Date.now()}`,
        lat: WORKER_LAT,
        lng: WORKER_LNG,
        occupation: 'AT',
      });
      const compat0 = await readStageCount(page, 'kanban-column-COMPATIBLE-count');
      const funnel0 = (await readFunnelApi(request, MOCK_TOKEN, vacancy.vacancyId)) as FunnelApiData;
      const compat0Api = funnel0.stages.COMPATIBLE?.length ?? 0;
      console.log('[5.4] compat0 (kanban)=', compat0, 'compat0 (api stages.COMPATIBLE.length)=', compat0Api);

      // (4) 2º match.
      const match2 = await runMatchApi(request, MOCK_TOKEN, vacancy.vacancyId, { radiusKm: 1, topN: 200 });
      console.log('[5.4] match2.status=', match2.status);
      expect(match2.status, 'POST /match (2º) deveria ser 200').toBe(200);

      // (5) API: R continua REJECTED (não ressuscitado); R não está mais em
      // Compatíveis; N entra; o delta é só +1 (o N).
      const wjaRAfter = getWjaByWorkerAndJob(workerR, vacancy.vacancyId);
      console.log('[5.4] R.application_funnel_stage após match2=', wjaRAfter?.funnelStage);
      expect(wjaRAfter?.funnelStage, 'R continua REJECTED após o 2º match').toBe('REJECTED');

      const funnel2 = (await readFunnelApi(request, MOCK_TOKEN, vacancy.vacancyId)) as FunnelApiData;
      const compat2WorkerIds = workerIdsInStage(funnel2, 'COMPATIBLE');
      const compat2Api = funnel2.stages.COMPATIBLE?.length ?? 0;
      console.log('[5.4] após match2, stages.COMPATIBLE workerIds=', compat2WorkerIds, 'length=', compat2Api);
      expect(compat2WorkerIds, 'R NÃO está em Compatíveis após o 2º match').not.toContain(workerR);
      expect(compat2WorkerIds, 'N está em Compatíveis após o 2º match').toContain(workerN);
      expect(compat2Api, 'stages.COMPATIBLE.length = compat0 + 1 (só o N)').toBe(compat0Api + 1);

      // Na tela, recarregada: kanban-column-COMPATIBLE-count = compat0 + 1; o card de
      // R continua em Rejeitados.
      await gotoVacancyDetail(page, vacancy.vacancyId);
      await switchToKanban(page, vacancy.vacancyId);
      await collapseColumnsExcept(page, ['COMPATIBLE', 'REJECTED']);
      const compatAfterScreen = await readStageCount(page, 'kanban-column-COMPATIBLE-count');
      console.log('[5.4] kanban-column-COMPATIBLE-count após reload=', compatAfterScreen);
      expect(compatAfterScreen, 'kanban-column-COMPATIBLE-count = compat0 + 1 (recarregada)').toBe(compat0 + 1);
      await expect(
        page.getByTestId('kanban-column-REJECTED').getByTestId(`kanban-card-${wjaR.id}`),
        'card de R continua em Rejeitados (recarregada)',
      ).toBeVisible({ timeout: 10_000 });

      // (6) O match não envia — messaging_outbox = 0 para R, C e N.
      const outboxR = countOutboundSince(workerR, t0).outbox;
      const outboxC = countOutboundSince(workerC, t0).outbox;
      const outboxN = countOutboundSince(workerN, t0).outbox;
      console.log('[5.4] messaging_outbox — R=', outboxR, 'C=', outboxC, 'N=', outboxN);
      expect(outboxR, 'messaging_outbox de R = 0 (o match não envia)').toBe(0);
      expect(outboxC, 'messaging_outbox de C = 0 (o match não envia)').toBe(0);
      expect(outboxN, 'messaging_outbox de N = 0 (o match não envia)').toBe(0);
    } finally {
      cleanupWJAAndEncuadre(workerR, vacancy.vacancyId);
      cleanupWJAAndEncuadre(workerC, vacancy.vacancyId);
      if (workerN) cleanupWJAAndEncuadre(workerN, vacancy.vacancyId);
      cleanupTestWorker(workerR);
      cleanupTestWorker(workerC);
      if (workerN) cleanupTestWorker(workerN);
      vacancy.cleanup();
    }
  });
});
