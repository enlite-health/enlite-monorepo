/**
 * funil-vacante-compativeis.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 5 da change cadeia-paciente-vacante-itinerario (P17):
 * a coluna "Compatíveis" (candidato do match, INVITED/system SEM messaged_at —
 * `isMatchedNotInvited`, `WF/domain/kanbanColumn.ts:42-48`) contada IGUAL nos 3 lugares
 * onde ela aparece — Kanban, aba do modo lista e lista de vacantes — sem consulta nova
 * (DX-5.3) e sem nenhuma request de match/maps durante o teste (critérios 8 e 9).
 *
 * 3 testes independentes, sem `serial` (DX-5.10) — cada um semeia e limpa o seu:
 *   funil-compativeis-tres-lugares          — feliz: os 4 números (Kanban, aba, linhas
 *                                              da aba, lista de vacantes) + API iguais a 2;
 *                                              ordem das 9 colunas do Kanban; sem
 *                                              request de match/maps.
 *   funil-compativeis-lista-aba-vazia       — alternativo do modo lista: aba a 0 e sem
 *                                              linha até o match existir.
 *   funil-compativeis-lista-vacantes-duas-vagas — alternativo da lista de vacantes: só
 *                                              a vaga com o compatível ganha a coluna.
 *
 * O helper `compativeis-e2e-helper.ts` (P16) semeia o card compatível e lê as contagens
 * nos 3 lugares por `data-testid`; este spec só orquestra a navegação e as asserções, no
 * molde de `funil-vacante-motivo.integration.e2e.ts` (Fase 4).
 */

import { test, expect, type Page } from '@playwright/test';
import { seedVacancyWithCards } from '../helpers/funnel-move-e2e-helper';
import {
  seedCompatibleCard,
  cleanupCompatibleCard,
  readFunnelApi,
  readCompatibleCountsOnScreen,
  gotoVacancyDetail,
  switchToKanban,
  readStageCount,
  type SeedCompatibleCardResult,
} from '../helpers/compativeis-e2e-helper';
import { seedMockStaff, cleanupMockStaff, readVacancyListRow } from '../helpers/vacancy-notes-e2e-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
// Host da própria API sob teste — derivado de BACKEND_URL (nunca localhost:8106 literal
// no spec: no CI a api sobe em localhost:8080, neste worktree local em localhost:8106).
const API_HOST = new URL(BACKEND_URL).host;

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-funil-compativeis',
  email: 'staff.funil.compativeis@e2e.test',
  role: 'admin',
  country: 'AR',
};
const MOCK_TOKEN = tokenFor(MOCK_STAFF);

/** A ordem das 9 colunas do quadro B, fonte única `funnelTabsConfig.ts:20-30` (critério 3). */
const KANBAN_COLUMN_ORDER = [
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

// ── Navegação (molde `funil-vacante-motivo.integration.e2e.ts`) ────────────────

async function gotoVacanciesList(page: Page): Promise<void> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => /\/api\/admin\/vacancies\?/.test(r.url()) && r.request().method() === 'GET'),
    page.goto('/admin/vacancies'),
  ]);
  expect(response.ok(), 'GET /api/admin/vacancies falhou').toBe(true);
}

// `gotoVacancyDetail`/`switchToKanban`/`readStageCount` vivem em `compativeis-e2e-helper.ts`
// (achado 🟡-3 do gate parcial, G2) — importadas acima, byte-idênticas nos 4 specs novos.

/**
 * Critério 3: os ids das 9 colunas do Kanban, na ordem em que aparecem no DOM
 * (`kanban-column-<ID>`, maiúsculo — exclui `-count`/`-collapse`, que são minúsculos).
 */
async function readKanbanColumnIdsInOrder(page: Page): Promise<string[]> {
  const testids = await page
    .getByTestId(/^kanban-column-[A-Z_]+$/)
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
  return testids.map((t) => t.replace(/^kanban-column-/, ''));
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('funil da vacante — Compatíveis nos 3 lugares @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Funil Compatíveis');
  });

  test.afterAll(() => {
    cleanupMockStaff(MOCK_STAFF);
  });

  // ── Feliz: os 4 números + API iguais a 2, ordem das 9 colunas, sem match/maps ──
  test('funil-compativeis-tres-lugares', async ({ page, request }) => {
    const seed = seedVacancyWithCards([{ stage: 'INVITED' }, { stage: 'REJECTED' }]);
    const compat1 = seedCompatibleCard(seed.vacancyId);
    const compat2 = seedCompatibleCard(seed.vacancyId);

    try {
      await loginAs(page, MOCK_STAFF);

      // Critérios 8 e 9: toda request desde o login.
      const requestUrls: string[] = [];
      page.on('request', (req) => requestUrls.push(req.url()));

      // 1. Lista de vacantes — janela do critério 8 marcada por índice.
      const listWindowStart = requestUrls.length;
      await gotoVacanciesList(page);
      await expect(page.getByTestId(`vacancy-row-${seed.vacancyId}`)).toBeVisible({ timeout: 15_000 });
      await page.getByTestId(`vacancy-row-${seed.vacancyId}-stage-COMPATIBLE`).scrollIntoViewIfNeeded();
      const vacantesCounts = await readCompatibleCountsOnScreen(page, seed.vacancyId);
      const vacantesInvited = await readStageCount(page, `vacancy-row-${seed.vacancyId}-stage-INVITED`);
      const listWindowEnd = requestUrls.length;

      // 2. Modo lista (aba padrão) — abre a aba Compatibles e conta as linhas.
      // Race do spec (achado P23b/P17b): o clique em #funnel-tab-COMPATIBLE dispara um NOVO fetch
      // (`useVacancyFunnelTable.ts:39-42`, a dependência `tab.key` muda) e `.count()` não faz
      // polling/retry — lia o DOM antes da tabela reassentar. Espera a resposta do fetch (molde
      // `gotoVacancyDetail`/`switchToKanban` acima) E confere a contagem de linhas com auto-retry
      // (`toHaveCount`), sem enfraquecer o valor esperado (continua 2, igual à API).
      await gotoVacancyDetail(page, seed.vacancyId);
      const compatibleTableRe = new RegExp(`/vacancies/${seed.vacancyId}/funnel-table\\?columns=COMPATIBLE(&|$)`);
      const [compatibleTableResponse] = await Promise.all([
        page.waitForResponse((r) => compatibleTableRe.test(r.url()) && r.request().method() === 'GET'),
        page.locator('#funnel-tab-COMPATIBLE').click(),
      ]);
      expect(compatibleTableResponse.ok(), 'GET funnel-table?columns=COMPATIBLE falhou').toBe(true);
      const listaCounts = await readCompatibleCountsOnScreen(page, seed.vacancyId);
      const listaInvited = await readStageCount(page, 'funnel-tab-INVITED-count');
      const funnelRowsLocator = page.locator('[data-testid^="funnel-row-"]');
      await expect(funnelRowsLocator, 'linhas [data-testid^="funnel-row-"] na aba Compatibles').toHaveCount(2);
      const funnelRowCount = await funnelRowsLocator.count();

      // 3. Kanban — contagem da coluna + ordem das 9 colunas.
      await switchToKanban(page, seed.vacancyId);
      const kanbanCounts = await readCompatibleCountsOnScreen(page, seed.vacancyId);
      const kanbanInvited = await readStageCount(page, 'kanban-column-INVITED-count');
      const columnIds = await readKanbanColumnIdsInOrder(page);
      const emptyColumns = page.getByTestId(/kanban-column-(IN_PROGRESS|BLOQUEADO)$/);

      // API: readFunnelApi (stages.COMPATIBLE) + GET /vacancies (stageCounts.COMPATIBLE).
      const funnelApiData = (await readFunnelApi(request, MOCK_TOKEN, seed.vacancyId)) as {
        stages: Record<string, unknown[]>;
      };
      const apiCompat = funnelApiData.stages.COMPATIBLE?.length ?? 0;
      const vacancyRow = (await readVacancyListRow(request, BACKEND_URL, MOCK_TOKEN, seed.vacancyId)) as {
        stageCounts: Record<string, number>;
      };
      const apiListCompat = vacancyRow.stageCounts.COMPATIBLE;

      console.log('[5.1] contagens COMPATIBLE', {
        vacantes: vacantesCounts.vacantes,
        lista: listaCounts.lista,
        funnelRowCount,
        kanban: kanbanCounts.kanban,
        apiCompat,
        apiListCompat,
      });
      console.log('[5.1] contagens INVITED', { vacantesInvited, listaInvited, kanbanInvited });
      console.log('[5.1] ordem das 9 colunas do kanban', columnIds);

      // Critério 1: os 4 números iguais entre si e iguais a 2; +API confirmando a mesma dobra.
      expect(vacantesCounts.vacantes, 'vacantes.stage-COMPATIBLE').toBe(2);
      expect(listaCounts.lista, 'aba funnel-tab-COMPATIBLE-count').toBe(2);
      expect(funnelRowCount, 'linhas [data-testid^="funnel-row-"] na aba Compatibles').toBe(2);
      expect(kanbanCounts.kanban, 'kanban kanban-column-COMPATIBLE-count').toBe(2);
      expect(apiCompat, 'API funnel: stages.COMPATIBLE.length').toBe(2);
      expect(apiListCompat, 'API vacancies: stageCounts.COMPATIBLE').toBe(2);

      // INVITED = 1 nos mesmos 3 lugares (o compatível não infla Invitados).
      expect(vacantesInvited, 'vacantes.stage-INVITED').toBe(1);
      expect(listaInvited, 'aba funnel-tab-INVITED-count').toBe(1);
      expect(kanbanInvited, 'kanban kanban-column-INVITED-count').toBe(1);

      // Critério 3: a lista literal das 9 colunas, na ordem, e 0 para IN_PROGRESS|BLOQUEADO.
      expect(columnIds, 'ordem das 9 colunas do kanban').toEqual([...KANBAN_COLUMN_ORDER]);
      await expect(emptyColumns, 'IN_PROGRESS/BLOQUEADO não são coluna').toHaveCount(0);

      // Critério 8: nenhuma request de match ENQUANTO a lista de vacantes esteve aberta;
      // controle positivo: a própria GET /vacancies aconteceu nessa janela.
      const listWindow = requestUrls.slice(listWindowStart, listWindowEnd);
      const matchInList = listWindow.filter((u) => /match-results|\/match(\?|$)/.test(u));
      const vacanciesInList = listWindow.filter((u) => /\/api\/admin\/vacancies\?/.test(u));
      console.log('[5.1] critério 8 — janela da lista de vacantes', {
        matchInList: matchInList.length,
        vacanciesInList: vacanciesInList.length,
      });
      expect(matchInList.length, 'nenhuma request de match/match-results na janela da lista').toBe(0);
      expect(vacanciesInList.length, 'controle positivo: GET /api/admin/vacancies').toBeGreaterThanOrEqual(1);

      // Critério 9: nenhuma request a maps.googleapis.com no teste inteiro; controle
      // positivo: requests à própria API (o host de E2E_BACKEND_URL).
      const mapsHits = requestUrls.filter((u) => {
        try {
          return new URL(u).hostname.includes('maps.googleapis.com');
        } catch {
          return false;
        }
      });
      const backendHits = requestUrls.filter((u) => {
        try {
          return new URL(u).host === API_HOST;
        } catch {
          return false;
        }
      });
      console.log('[5.1] critério 9 — teste inteiro', {
        mapsHits: mapsHits.length,
        backendHits: backendHits.length,
      });
      expect(mapsHits.length, 'nenhuma request a maps.googleapis.com').toBe(0);
      expect(backendHits.length, `controle positivo: requests a ${API_HOST}`).toBeGreaterThan(0);
    } finally {
      cleanupCompatibleCard(compat1.workerId, seed.vacancyId);
      cleanupCompatibleCard(compat2.workerId, seed.vacancyId);
      seed.cleanup();
    }
  });

  // ── Alternativo do modo lista: aba vazia até o match existir ───────────────────
  test('funil-compativeis-lista-aba-vazia', async ({ page }) => {
    const seed = seedVacancyWithCards([{ stage: 'INVITED' }]);
    let compat: SeedCompatibleCardResult | undefined;

    try {
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, seed.vacancyId);

      // Antes: nenhum candidato do match — a aba mostra 0 e não abre linha nenhuma.
      await expect(page.getByTestId('funnel-tab-COMPATIBLE-count')).toHaveText('0');
      await page.locator('#funnel-tab-COMPATIBLE').click();
      await expect(page.locator('[data-testid^="funnel-row-"]')).toHaveCount(0);

      // Semeia o compatível direto no banco (sem chamar a rota de match — DX-5.13).
      compat = seedCompatibleCard(seed.vacancyId);

      // Depois: recarrega — a aba passa a 1 e a linha do worker aparece, nome visível
      // (engine OFF nesta stack, cells === null).
      await gotoVacancyDetail(page, seed.vacancyId);
      await expect(page.getByTestId('funnel-tab-COMPATIBLE-count')).toHaveText('1');
      await page.locator('#funnel-tab-COMPATIBLE').click();
      const row = page.getByTestId(`funnel-row-${compat.wjaId}`);
      await expect(row).toBeVisible({ timeout: 10_000 });
      const workerName = (await row.getByTestId('funnel-worker-link').textContent())?.trim();
      console.log('[alt-lista] aba 0→1, nome do worker visível=', workerName);
      expect(workerName, 'nome do worker visível na linha (engine OFF)').toMatch(/CompativeisE2E/);
    } finally {
      if (compat) cleanupCompatibleCard(compat.workerId, seed.vacancyId);
      seed.cleanup();
    }
  });

  // ── Alternativo da lista de vacantes: só a vaga com o compatível ganha a coluna ──
  test('funil-compativeis-lista-vacantes-duas-vagas', async ({ page }) => {
    const seedV1 = seedVacancyWithCards([{ stage: 'INVITED' }]);
    const seedV2 = seedVacancyWithCards([{ stage: 'INVITED' }]);
    const compat = seedCompatibleCard(seedV1.vacancyId);

    try {
      await loginAs(page, MOCK_STAFF);
      await gotoVacanciesList(page);
      await expect(page.getByTestId(`vacancy-row-${seedV1.vacancyId}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId(`vacancy-row-${seedV2.vacancyId}`)).toBeVisible({ timeout: 15_000 });

      const v1Compat = page.getByTestId(`vacancy-row-${seedV1.vacancyId}-stage-COMPATIBLE`);
      const v2Compat = page.getByTestId(`vacancy-row-${seedV2.vacancyId}-stage-COMPATIBLE`);
      await v1Compat.scrollIntoViewIfNeeded();
      await v2Compat.scrollIntoViewIfNeeded();

      // Só a V1 (a que tem o compatível) ganha a coluna; a V2 continua em 00.
      await expect(v1Compat, 'V1.stage-COMPATIBLE').toHaveText('01');
      await expect(v2Compat, 'V2.stage-COMPATIBLE').toHaveText('00');

      // INVITED das duas igual ao semeado (1 cada) — o compatível não mexe nele.
      await expect(
        page.getByTestId(`vacancy-row-${seedV1.vacancyId}-stage-INVITED`),
        'V1.stage-INVITED',
      ).toHaveText('01');
      await expect(
        page.getByTestId(`vacancy-row-${seedV2.vacancyId}-stage-INVITED`),
        'V2.stage-INVITED',
      ).toHaveText('01');

      console.log('[alt-vacantes] V1 COMPATIBLE=01 INVITED=01; V2 COMPATIBLE=00 INVITED=01');
    } finally {
      cleanupCompatibleCard(compat.workerId, seedV1.vacancyId);
      seedV1.cleanup();
      seedV2.cleanup();
    }
  });
});
