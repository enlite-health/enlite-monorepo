/**
 * funil-vacante-motivo.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 4 da change cadeia-paciente-vacante-itinerario (P17-19):
 * o motivo obrigatório no arrasto do quadro B (salto e entrar/sair de Rejeitados,
 * DX-4.5/DX-4.6/DX-4.9/DX-4.10) — frontend real (Vite) + backend real (Docker,
 * USE_MOCK_AUTH=true) + Postgres real, no mesmo padrão de `funil-vacante.integration.e2e.ts`
 * (Fase 2): `loginAs` (click + `keyboard.type`, memória `e2e-humano-nao-e-fill`).
 *
 * `describe` serial com os 7 testes de nome literal (DX-4.16):
 *   funil-err-de-selecionados            — P17: Seleccionados → Equipo, sem pergunta (feliz)
 *   funil-err-salto-com-motivo           — P18: salto pela tela, com o diálogo de motivo
 *   funil-err-salto-sem-motivo-422       — P18: salto pela API, sem motivo → 422
 *   funil-rejeitar-exige-motivo          — P19: entrar em Rejeitados exige motivo
 *   funil-sair-de-rejeitados-exige-motivo — P19: sair de Rejeitados exige motivo
 *   funil-err-modo-lista-aba-vazia        — alternativo do modo lista (critério 4 do gate 🟡):
 *                                            aba da Equipe vazia (0 + tabela vazia) → putMove → 1 + linha aparece
 *   funil-err-lista-vacantes-contagem     — alternativo da lista de vacantes (critério 4 do gate 🟡):
 *                                            duas vagas, só a movida ganha a coluna nova; Seleccionados cai junto
 *
 * O helper `funnel-move-e2e-helper.ts` (P16) semeia vaga+cards, lê a trilha e conta
 * efeito colateral; este spec só orquestra a interação humana e as asserções.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  seedVacancyWithCards,
  readTrail,
  countTrail,
  countOutboundSince,
  readPatientStatusApi,
  putMove,
  chooseReasonInModal,
} from '../helpers/funnel-move-e2e-helper';
import { seedMockStaff, cleanupMockStaff, readVacancyListRow } from '../helpers/vacancy-notes-e2e-helper';
import { dragKanbanCard } from '../helpers/kanban-notes-e2e-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { getWjaByWorkerAndJob } from '../helpers/wja-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
// Host da própria API sob teste — derivado de BACKEND_URL (não um literal fixo): no CI
// a api sobe em localhost:8080, neste worktree local em localhost:8105 (ver BRIEF-COMUM.md).
const API_HOST = new URL(BACKEND_URL).host;

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-funil-motivo',
  email: 'staff.funil.motivo@e2e.test',
  role: 'admin',
  country: 'AR',
};
const MOCK_TOKEN = tokenFor(MOCK_STAFF);

// Hosts de canal real — critério 11 (DX-4.7): mover para QUICK_RESPONSE_TEAM não pode
// tocar nenhum deles. Controle positivo: API_HOST (a própria API do teste).
// Testa só o HOSTNAME (não a URL inteira): a própria API local tem rotas com
// "talentum" no path (`/api/admin/workers/sync-talentum`) — um match por substring
// na URL inteira acusaria a própria stack de teste como "canal real" (medido: 40
// falsos positivos, todos no host da própria API).
const FORBIDDEN_HOSTS_RE = /twilio|whatsapp|facebook|graph\.facebook|periskope|talentum/i;

function isForbiddenHost(url: string): boolean {
  try {
    return FORBIDDEN_HOSTS_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// ── Navegação (molde `funil-vacante.integration.e2e.ts`) ──────────────────────

async function gotoVacanciesList(page: Page): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => /\/api\/admin\/vacancies\?/.test(r.url()) && r.request().method() === 'GET'),
    page.goto('/admin/vacancies'),
  ]);
  expect(response.ok(), 'GET /api/admin/vacancies falhou').toBe(true);
}

/**
 * `VacancyFunnelView.tsx` persiste a última vista (list/kanban) em
 * `localStorage['vacancy-funnel-view-<id>']` — limpa antes de cada visita fresca,
 * senão uma 2ª navegação à MESMA vaga reabre em Kanban (molde da Fase 2).
 */
async function gotoVacancyDetail(page: Page, vacancyId: string): Promise<void> {
  await page
    .evaluate((id) => localStorage.removeItem(`vacancy-funnel-view-${id}`), vacancyId)
    .catch(() => {});
  const funnelTableRe = new RegExp(`/vacancies/${vacancyId}/funnel-table(\\?|$)`);
  const [response] = await Promise.all([
    page.waitForResponse((r) => funnelTableRe.test(r.url()) && r.request().method() === 'GET'),
    page.goto(`/admin/vacancies/${vacancyId}`),
  ]);
  expect(response.ok(), 'GET funnel-table falhou').toBe(true);
  await expect(page.getByTestId('vacancy-funnel-view')).toBeVisible({ timeout: 15_000 });
}

async function switchToKanban(page: Page, vacancyId: string): Promise<void> {
  const funnelRe = new RegExp(`/vacancies/${vacancyId}/funnel(\\?|$)`);
  const [response] = await Promise.all([
    page.waitForResponse((r) => funnelRe.test(r.url()) && r.request().method() === 'GET'),
    page
      .getByRole('group', { name: 'Cambiar vista' })
      .getByRole('button', { name: /Kanban/i })
      .click(),
  ]);
  expect(response.ok(), 'GET funnel (kanban) falhou').toBe(true);
  await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });
}

/**
 * Lê `cols` testids até o texto estabilizar (duas leituras iguais) — o
 * `waitForResponse` resolve no evento de rede; o re-render do React vem num
 * tick seguinte (mesma corrida documentada no molde da Fase 2).
 */
async function readStableNumbers(
  page: Page,
  testIdFor: (col: string) => string,
  cols: readonly string[],
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const col of cols) {
    const locator = page.getByTestId(testIdFor(col));
    await expect(locator).toBeVisible({ timeout: 15_000 });
    let previous: string | null = null;
    await expect
      .poll(
        async () => {
          const current = await locator.innerText();
          const stable = current === previous;
          previous = current;
          return stable;
        },
        { timeout: 5_000, intervals: [50, 100, 200, 300] },
      )
      .toBe(true);
    out[col] = Number(previous);
  }
  return out;
}

/** Molde `funil-vacante.integration.e2e.ts` — a tabela do modo lista, sem candidatos na aba, tem 0 `tbody tr`. */
async function countFunnelTableRows(page: Page): Promise<number> {
  return page.getByTestId('vacancy-funnel-view').getByRole('table').locator('tbody tr').count();
}

const COLS = ['SELECTED', 'QUICK_RESPONSE_TEAM'] as const;

const ALL_COLUMN_IDS = [
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
 * O board (8 colunas × 280px) nunca cabe no viewport de 1366px — por design
 * (`KanbanColumn.tsx`: "9 colunas, rola de qualquer jeito"). `dragKanbanCard`
 * lê a `boundingBox()` de origem/alvo ANTES do drag e usa coordenadas fixas
 * durante os passos do mouse; se origem OU alvo estiverem fora do viewport, o
 * auto-scroll de proximidade do dnd-kit desloca o board DURANTE o arrasto e as
 * coordenadas ficam obsoletas — medido: um arrasto Seleccionados→Equipo (colunas
 * adjacentes, mas ambas fora do viewport em scroll=0) terminou solto em
 * Rechazados (a última coluna, onde o scroll bate no fim). Colapsar as colunas
 * de fora (52px cada) encolhe o board até origem e alvo caberem juntos no
 * viewport, sem qualquer scroll durante o arrasto.
 */
async function collapseColumnsExcept(page: Page, keep: readonly string[]): Promise<void> {
  for (const id of ALL_COLUMN_IDS) {
    if (keep.includes(id)) continue;
    const collapseButton = page.getByTestId(`kanban-column-${id}-collapse`);
    if (await collapseButton.count()) {
      await collapseButton.click();
    }
  }
  // `transition-all duration-300` — dá tempo da largura assentar antes de
  // qualquer `boundingBox()` (a régua exata do drag).
  await page.waitForTimeout(400);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('funil da vacante — motivo obrigatório @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Funil Motivo');
  });

  test.afterAll(() => {
    cleanupMockStaff(MOCK_STAFF);
  });

  // ── P17 · feliz: Seleccionados → Equipo, nada além da coluna ───────────────
  test('funil-err-de-selecionados', async ({ page, request }) => {
    const seed = seedVacancyWithCards([{ stage: 'SELECTED' }, { stage: 'INVITED' }], {
      providersNeeded: 2,
    });
    const [selectedCard] = seed.cards;
    const t0 = new Date();

    try {
      // countTrail antes: o INSERT do seed já grava `null → SELECTED` (gatilho de auditoria)
      // — a prova é a LINHA NOVA (delta), não o tamanho absoluto da trilha.
      const trailCountBefore = countTrail(selectedCard.wjaId);
      const faltantesBefore = (await readVacancyListRow(request, BACKEND_URL, MOCK_TOKEN, seed.vacancyId))
        .faltantes;
      const statusBefore = await readPatientStatusApi(request, BACKEND_URL, MOCK_TOKEN, seed.patientId);

      await loginAs(page, MOCK_STAFF);

      const requestUrls: string[] = [];
      page.on('request', (req) => requestUrls.push(req.url()));

      // 1. Lista de vacantes — navegação + print (o mesmo nome de prints/antes/).
      await gotoVacanciesList(page);
      await expect(page.getByTestId(`vacancy-row-${seed.vacancyId}`)).toBeVisible({ timeout: 15_000 });
      if (process.env.PRINT_DIR) {
        await page.screenshot({ path: `${process.env.PRINT_DIR}/lista-vacantes.png`, fullPage: true });
      }
      const listBefore = await readStableNumbers(
        page,
        (col) => `vacancy-row-${seed.vacancyId}-stage-${col}`,
        COLS,
      );

      // 2. Modo lista — navegação + print.
      await gotoVacancyDetail(page, seed.vacancyId);
      if (process.env.PRINT_DIR) {
        await page.screenshot({ path: `${process.env.PRINT_DIR}/funil-lista.png`, fullPage: true });
      }
      const tabBefore = await readStableNumbers(page, (col) => `funnel-tab-${col}-count`, COLS);

      // 3. Kanban — navegação + print.
      await switchToKanban(page, seed.vacancyId);
      if (process.env.PRINT_DIR) {
        await page.screenshot({ path: `${process.env.PRINT_DIR}/funil-kanban.png`, fullPage: true });
      }
      const kanbanBefore = await readStableNumbers(page, (col) => `kanban-column-${col}-count`, COLS);

      console.log('[P17] antes', { faltantesBefore, statusBefore, listBefore, tabBefore, kanbanBefore });

      // Encolhe o board pra origem e alvo caberem juntos no viewport (ver collapseColumnsExcept).
      await collapseColumnsExcept(page, ['SELECTED', 'QUICK_RESPONSE_TEAM']);

      // Arrasto: Seleccionados → Equipo de Respuesta Rápida. 2xx direto (sem pergunta).
      const [moveResponse] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        dragKanbanCard(page, selectedCard.wjaId, 'QUICK_RESPONSE_TEAM'),
      ]);
      expect(moveResponse.ok(), `PUT move deveria ser 2xx, veio ${moveResponse.status()}`).toBe(true);
      await expect(page.getByTestId('move-reason-modal')).toHaveCount(0);
      await expect(
        page.locator(
          `[data-testid="kanban-column-QUICK_RESPONSE_TEAM"] [data-testid="kanban-card-${selectedCard.wjaId}"]`,
        ),
      ).toBeVisible({ timeout: 10_000 });

      // Depois: as 6 contagens relidas nos 3 lugares.
      const kanbanAfter = await readStableNumbers(page, (col) => `kanban-column-${col}-count`, COLS);
      await gotoVacancyDetail(page, seed.vacancyId);
      const tabAfter = await readStableNumbers(page, (col) => `funnel-tab-${col}-count`, COLS);
      await gotoVacanciesList(page);
      await expect(page.getByTestId(`vacancy-row-${seed.vacancyId}`)).toBeVisible({ timeout: 15_000 });
      const listAfter = await readStableNumbers(
        page,
        (col) => `vacancy-row-${seed.vacancyId}-stage-${col}`,
        COLS,
      );

      console.log('[P17] depois', { listAfter, tabAfter, kanbanAfter });

      for (const [label, before, after] of [
        ['lista', listBefore, listAfter],
        ['aba', tabBefore, tabAfter],
        ['kanban', kanbanBefore, kanbanAfter],
      ] as const) {
        expect(after.SELECTED, `${label}.SELECTED`).toBe(before.SELECTED - 1);
        expect(after.QUICK_RESPONSE_TEAM, `${label}.QUICK_RESPONSE_TEAM`).toBe(before.QUICK_RESPONSE_TEAM + 1);
      }

      const faltantesAfter = (await readVacancyListRow(request, BACKEND_URL, MOCK_TOKEN, seed.vacancyId))
        .faltantes;
      console.log('[P17] faltantes antes=', faltantesBefore, 'depois=', faltantesAfter);
      expect(faltantesAfter).toBe(faltantesBefore);

      const statusAfter = await readPatientStatusApi(request, BACKEND_URL, MOCK_TOKEN, seed.patientId);
      console.log('[P17] patients.status antes=', statusBefore, 'depois=', statusAfter);
      expect(statusAfter).toBe(statusBefore);

      const trail = readTrail(selectedCard.wjaId);
      console.log('[P17] trilha', trail);
      expect(trail.length, 'trilha ganhou 1 linha nova').toBe(trailCountBefore + 1);
      const last = trail[trail.length - 1];
      expect(last.oldValue).toBe('SELECTED');
      expect(last.newValue).toBe('QUICK_RESPONSE_TEAM');
      expect(last.reasonCategory).toBeNull();

      const outbound = countOutboundSince(selectedCard.workerId, t0);
      console.log('[4.11] outbound:', outbound);
      expect(outbound.domainEvents, 'domainEvents').toBe(0);
      expect(outbound.stageMessageLog, 'stageMessageLog').toBe(0);
      expect(outbound.outbox, 'outbox').toBe(0);

      const forbiddenCount = requestUrls.filter(isForbiddenHost).length;
      const localCount = requestUrls.filter((u) => u.includes(API_HOST)).length;
      console.log('[P17] requests forbidden=', forbiddenCount, `${API_HOST}=`, localCount);
      expect(forbiddenCount, 'nenhuma request a canal real').toBe(0);
      expect(localCount, 'controle positivo: requests à própria API').toBeGreaterThan(0);
    } finally {
      seed.cleanup();
    }
  });

  // ── P18 · salto: com motivo (tela), controle de cancelar ───────────────────
  test('funil-err-salto-com-motivo', async ({ page, request }) => {
    const seed = seedVacancyWithCards([{ stage: 'INVITED' }, { stage: 'INVITED' }]);
    const [cardA, cardControl] = seed.cards;
    const t0 = new Date();

    try {
      // countTrail antes: o INSERT do seed já grava `null → INVITED` (gatilho de auditoria)
      // — a prova é a LINHA NOVA (delta), não o tamanho absoluto da trilha.
      const trailCountBeforeA = countTrail(cardA.wjaId);
      const statusBefore = await readPatientStatusApi(request, BACKEND_URL, MOCK_TOKEN, seed.patientId);

      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, seed.vacancyId);
      await switchToKanban(page, seed.vacancyId);
      await collapseColumnsExcept(page, ['INVITED', 'QUICK_RESPONSE_TEAM']);

      // Card A: arrasto pede motivo (422), escolhe e reenvia (2xx).
      const [firstPut] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        dragKanbanCard(page, cardA.wjaId, 'QUICK_RESPONSE_TEAM'),
      ]);
      expect(firstPut.status(), '1º PUT tem de ser 422').toBe(422);

      const moveReasonModal = page.getByTestId('move-reason-modal');
      await expect(moveReasonModal).toBeVisible();
      await expect(page.getByTestId('move-reason-option-encuadre-antecipado')).toBeVisible();
      await expect(page.getByTestId('move-reason-option-reaproveitado-de-outra-vaga')).toBeVisible();
      await expect(page.getByTestId('move-reason-option-indicacao-da-equipe')).toBeVisible();
      await expect(page.getByTestId('move-reason-option-other')).toBeVisible();

      const [secondPut] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        chooseReasonInModal(page, 'move-reason', 'ENCUADRE_ANTECIPADO'),
      ]);
      expect(secondPut.ok(), `2º PUT deveria ser 2xx, veio ${secondPut.status()}`).toBe(true);
      await expect(moveReasonModal).toHaveCount(0);
      await expect(
        page.locator(
          `[data-testid="kanban-column-QUICK_RESPONSE_TEAM"] [data-testid="kanban-card-${cardA.wjaId}"]`,
        ),
      ).toBeVisible({ timeout: 10_000 });

      const trail = readTrail(cardA.wjaId);
      console.log('[P18] trilha com-motivo', trail);
      expect(trail.length, 'trilha ganhou 1 linha nova').toBe(trailCountBeforeA + 1);
      const last = trail[trail.length - 1];
      expect(last.oldValue).toBe('INVITED');
      expect(last.newValue).toBe('QUICK_RESPONSE_TEAM');
      expect(last.changedBy).toBe(`staff:${MOCK_STAFF.uid}`);
      expect(new Date(last.createdAt).getTime()).toBeGreaterThanOrEqual(t0.getTime());
      expect(last.reasonCategory).toBe('ENCUADRE_ANTECIPADO');

      const statusAfter = await readPatientStatusApi(request, BACKEND_URL, MOCK_TOKEN, seed.patientId);
      console.log('[P18] patients.status antes=', statusBefore, 'depois=', statusAfter);
      expect(statusAfter).toBe(statusBefore);

      // Controle: cancelar no 3º card não move e não envia um 2º PUT.
      let putCount = 0;
      page.on('request', (req) => {
        if (req.method() === 'PUT' && /\/move$/.test(req.url())) putCount++;
      });
      const [controlPut] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        dragKanbanCard(page, cardControl.wjaId, 'QUICK_RESPONSE_TEAM'),
      ]);
      expect(controlPut.status(), 'PUT do controle também é 422').toBe(422);
      await expect(moveReasonModal).toBeVisible();
      const putCountAtModal = putCount;
      await page.getByTestId('move-reason-cancel').click();
      await expect(moveReasonModal).toHaveCount(0);
      // Sem otimismo: cancelar não dispara request nenhuma — dá tempo de uma
      // sobrar antes de contar (não há evento para esperar, é ausência).
      await page.waitForTimeout(500);
      console.log('[P18] controle putCount ao abrir modal=', putCountAtModal, 'após cancelar=', putCount);
      expect(putCount, 'cancelar não envia 2º PUT').toBe(putCountAtModal);
      await expect(
        page.locator(`[data-testid="kanban-column-INVITED"] [data-testid="kanban-card-${cardControl.wjaId}"]`),
      ).toBeVisible();
    } finally {
      seed.cleanup();
    }
  });

  // ── P18 · salto: sem motivo pela API → 422 ──────────────────────────────────
  test('funil-err-salto-sem-motivo-422', async ({ request }) => {
    const seed = seedVacancyWithCards([{ stage: 'INVITED' }]);
    const [card] = seed.cards;

    try {
      const before = countTrail(card.wjaId);

      const res = await putMove(request, BACKEND_URL, MOCK_TOKEN, card.encuadreId, {
        targetStage: 'QUICK_RESPONSE_TEAM',
      });
      const body = res.body as { code?: string; reason?: string };
      console.log('[P18] sem-motivo status=', res.status, 'body=', body);
      expect(res.status).toBe(422);
      expect(body.code).toBe('MOVE_REASON_REQUIRED');
      expect(body.reason).toBe('JUMP');

      const wja = getWjaByWorkerAndJob(card.workerId, seed.vacancyId);
      expect(wja?.funnelStage, 'estágio continua INVITED').toBe('INVITED');

      const after = countTrail(card.wjaId);
      console.log('[P18] countTrail antes=', before, 'depois=', after);
      expect(after).toBe(before);
    } finally {
      seed.cleanup();
    }
  });

  // ── P19 · entrar em Rejeitados exige motivo ─────────────────────────────────
  test('funil-rejeitar-exige-motivo', async ({ page, request }) => {
    const seed = seedVacancyWithCards([{ stage: 'CONFIRMED' }]);
    const [card] = seed.cards;

    try {
      const statusBefore = await readPatientStatusApi(request, BACKEND_URL, MOCK_TOKEN, seed.patientId);

      // Pela API, sem motivo: 422 ENTER_REJECTED, etapa continua CONFIRMED.
      const apiRes = await putMove(request, BACKEND_URL, MOCK_TOKEN, card.encuadreId, {
        targetStage: 'REJECTED',
      });
      const apiBody = apiRes.body as { code?: string; reason?: string };
      console.log('[P19] entrar sem motivo status=', apiRes.status, 'body=', apiBody);
      expect(apiRes.status).toBe(422);
      expect(apiBody.code).toBe('MOVE_REASON_REQUIRED');
      expect(apiBody.reason).toBe('ENTER_REJECTED');
      expect(getWjaByWorkerAndJob(card.workerId, seed.vacancyId)?.funnelStage, 'continua CONFIRMED').toBe(
        'CONFIRMED',
      );

      // Pela tela: o diálogo de motivo abre ANTES de qualquer PUT (D433/DX-4.10).
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, seed.vacancyId);
      await switchToKanban(page, seed.vacancyId);
      await collapseColumnsExcept(page, ['CONFIRMED', 'REJECTED']);

      await dragKanbanCard(page, card.wjaId, 'REJECTED');
      const rejectionModal = page.getByTestId('rejection-modal');
      await expect(rejectionModal).toBeVisible();

      const [putResponse] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        chooseReasonInModal(page, 'rejection', 'DISTANCE'),
      ]);
      expect(putResponse.ok(), `PUT deveria ser 2xx, veio ${putResponse.status()}`).toBe(true);
      await expect(rejectionModal).toHaveCount(0);

      const trail = readTrail(card.wjaId);
      const last = trail[trail.length - 1];
      console.log('[P19] trilha entrar', last);
      expect(last.newValue).toBe('REJECTED');
      expect(last.reasonCategory).toBe('DISTANCE');

      const encuadreCategory = runSQL(
        `SELECT rejection_reason_category FROM encuadres WHERE id = '${card.encuadreId}'`,
      );
      console.log('[P19] encuadres.rejection_reason_category=', encuadreCategory);
      expect(encuadreCategory).toBe('DISTANCE');

      const statusAfter = await readPatientStatusApi(request, BACKEND_URL, MOCK_TOKEN, seed.patientId);
      console.log('[P19] patients.status antes=', statusBefore, 'depois=', statusAfter);
      expect(statusAfter).toBe(statusBefore);
    } finally {
      seed.cleanup();
    }
  });

  // ── P19 · sair de Rejeitados exige motivo ───────────────────────────────────
  test('funil-sair-de-rejeitados-exige-motivo', async ({ page, request }) => {
    const seed = seedVacancyWithCards([{ stage: 'REJECTED' }]);
    const [card] = seed.cards;

    try {
      const statusBefore = await readPatientStatusApi(request, BACKEND_URL, MOCK_TOKEN, seed.patientId);

      // Pela API, sem motivo: 422 LEAVE_REJECTED, etapa continua REJECTED.
      const apiRes = await putMove(request, BACKEND_URL, MOCK_TOKEN, card.encuadreId, {
        targetStage: 'CONFIRMED',
      });
      const apiBody = apiRes.body as { code?: string; reason?: string };
      console.log('[P19] sair sem motivo status=', apiRes.status, 'body=', apiBody);
      expect(apiRes.status).toBe(422);
      expect(apiBody.code).toBe('MOVE_REASON_REQUIRED');
      expect(apiBody.reason).toBe('LEAVE_REJECTED');
      expect(getWjaByWorkerAndJob(card.workerId, seed.vacancyId)?.funnelStage, 'continua REJECTED').toBe(
        'REJECTED',
      );

      // Pela tela: MoveToMenu → Confirmados → data ("ainda não sei") → 422 → motivo → 2xx.
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, seed.vacancyId);
      await switchToKanban(page, seed.vacancyId);

      const cardLocator = page.locator(`[data-testid="kanban-card-${card.wjaId}"]`);
      await expect(cardLocator).toBeVisible();
      await cardLocator.getByTestId('move-to-button').click();
      await cardLocator.getByTestId('move-to-option-CONFIRMED').click();

      const scheduleModal = page.getByTestId('interview-schedule-modal');
      await expect(scheduleModal).toBeVisible();
      const [scheduleUnknownPut] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        page.getByTestId('interview-schedule-unknown').click(),
      ]);
      expect(scheduleUnknownPut.status(), '"ainda não sei" pede motivo (422)').toBe(422);
      await expect(scheduleModal).toHaveCount(0);

      const moveReasonModal = page.getByTestId('move-reason-modal');
      await expect(moveReasonModal).toBeVisible();
      await expect(page.getByTestId('move-reason-option-reavaliacao')).toBeVisible();
      await expect(page.getByTestId('move-reason-option-rejeitado-por-engano')).toBeVisible();
      await expect(page.getByTestId('move-reason-option-other')).toBeVisible();

      const [confirmPut] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        chooseReasonInModal(page, 'move-reason', 'REAVALIACAO'),
      ]);
      expect(confirmPut.ok(), `PUT deveria ser 2xx, veio ${confirmPut.status()}`).toBe(true);
      await expect(moveReasonModal).toHaveCount(0);

      const trail = readTrail(card.wjaId);
      const last = trail[trail.length - 1];
      console.log('[P19] trilha sair', last);
      expect(last.oldValue).toBe('REJECTED');
      expect(last.newValue).toBe('CONFIRMED');
      expect(last.reasonCategory).toBe('REAVALIACAO');

      const statusAfter = await readPatientStatusApi(request, BACKEND_URL, MOCK_TOKEN, seed.patientId);
      console.log('[P19] patients.status antes=', statusBefore, 'depois=', statusAfter);
      expect(statusAfter).toBe(statusBefore);
    } finally {
      seed.cleanup();
    }
  });

  // ── Alternativo · modo lista: aba da Equipe vazia, depois ganha 1 (critério 4 🟡) ──
  test('funil-err-modo-lista-aba-vazia', async ({ page, request }) => {
    const seed = seedVacancyWithCards([{ stage: 'SELECTED' }]);
    const [card] = seed.cards;

    try {
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, seed.vacancyId);

      // Antes: ninguém na Equipe — a aba mostra 0 e a tabela, ao abrir, não tem
      // linha nenhuma (o mesmo estado vazio que `funil-vacante-vazia`, Fase 2, lê
      // por contagem de testid — sem candidato nenhum, todas as abas ficam a 0).
      await expect(page.getByTestId('funnel-tab-QUICK_RESPONSE_TEAM-count')).toHaveText('0');
      await page.locator('#funnel-tab-QUICK_RESPONSE_TEAM').click();
      await expect
        .poll(() => countFunnelTableRows(page), { message: 'linhas da tabela em Equipo (vazia)' })
        .toBe(0);

      // Move o card SELECTED para a Equipe pela API — vizinho, sem motivo (o
      // mesmo par testado no feliz de `funil-err-de-selecionados`).
      const moveRes = await putMove(request, BACKEND_URL, MOCK_TOKEN, card.encuadreId, {
        targetStage: 'QUICK_RESPONSE_TEAM',
      });
      console.log('[alt-lista] putMove status=', moveRes.status);
      expect(moveRes.status, `PUT move deveria ser 2xx, veio ${moveRes.status}`).toBe(200);

      // Depois: recarrega o funil — a aba passa a 1 e a linha do card aparece
      // dentro dela (a tabela só lista a aba selecionada, então isso já prova
      // kanbanColumn = QUICK_RESPONSE_TEAM sem precisar ler o campo direto).
      await gotoVacancyDetail(page, seed.vacancyId);
      await expect(page.getByTestId('funnel-tab-QUICK_RESPONSE_TEAM-count')).toHaveText('1');
      await page.locator('#funnel-tab-QUICK_RESPONSE_TEAM').click();
      await expect(page.getByTestId(`funnel-row-${card.wjaId}`)).toBeVisible({ timeout: 10_000 });
    } finally {
      seed.cleanup();
    }
  });

  // ── Alternativo · lista de vacantes: só a vaga movida ganha a coluna nova (critério 4 🟡) ──
  test('funil-err-lista-vacantes-contagem', async ({ page, request }) => {
    const seedWithCard = seedVacancyWithCards([{ stage: 'SELECTED' }]);
    const seedEmpty = seedVacancyWithCards([]);
    const [card] = seedWithCard.cards;

    try {
      await loginAs(page, MOCK_STAFF);
      await gotoVacanciesList(page);
      await expect(page.getByTestId(`vacancy-row-${seedWithCard.vacancyId}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId(`vacancy-row-${seedEmpty.vacancyId}`)).toBeVisible({ timeout: 15_000 });

      // Antes: nenhuma das duas vagas tem ninguém na Equipe (00 e 00); a 1ª tem
      // 1 em Seleccionados (01) — é esse card que vai se mover.
      await expect(
        page.getByTestId(`vacancy-row-${seedWithCard.vacancyId}-stage-QUICK_RESPONSE_TEAM`),
      ).toHaveText('00');
      await expect(
        page.getByTestId(`vacancy-row-${seedEmpty.vacancyId}-stage-QUICK_RESPONSE_TEAM`),
      ).toHaveText('00');
      await expect(page.getByTestId(`vacancy-row-${seedWithCard.vacancyId}-stage-SELECTED`)).toHaveText('01');

      // Move o card da 1ª vaga para a Equipe pela API — vizinho, sem motivo.
      const moveRes = await putMove(request, BACKEND_URL, MOCK_TOKEN, card.encuadreId, {
        targetStage: 'QUICK_RESPONSE_TEAM',
      });
      console.log('[alt-vacancies] putMove status=', moveRes.status);
      expect(moveRes.status, `PUT move deveria ser 2xx, veio ${moveRes.status}`).toBe(200);

      // Depois: só a vaga movida ganha a coluna nova (01) — a outra vaga
      // continua intocada (00), e Seleccionados da 1ª cai junto (mesmo card,
      // não um card a mais).
      await gotoVacanciesList(page);
      await expect(page.getByTestId(`vacancy-row-${seedWithCard.vacancyId}`)).toBeVisible({ timeout: 15_000 });
      await expect(
        page.getByTestId(`vacancy-row-${seedWithCard.vacancyId}-stage-QUICK_RESPONSE_TEAM`),
      ).toHaveText('01');
      await expect(
        page.getByTestId(`vacancy-row-${seedEmpty.vacancyId}-stage-QUICK_RESPONSE_TEAM`),
      ).toHaveText('00');
      await expect(page.getByTestId(`vacancy-row-${seedWithCard.vacancyId}-stage-SELECTED`)).toHaveText('00');
    } finally {
      seedWithCard.cleanup();
      seedEmpty.cleanup();
    }
  });
});
