/**
 * funil-vacante.integration.e2e.ts @integration
 *
 * Integration E2E — funil da vacante (Fase 2 da change
 * cadeia-paciente-vacante-itinerario, quadro B): as 7 colunas do funil (D433)
 * batem NOS TRÊS LUGARES (lista de vacantes, modo lista, Kanban) e com a API
 * que os alimenta — frontend real (Vite) + backend real (Docker,
 * USE_MOCK_AUTH=true) + Postgres real, na MESMA estratégia de auth de
 * `kanban-pacientes.integration.e2e.ts` (Fase 1): `loginAs`
 * (`e2e/helpers/abac-stack-helper.ts`, click + `keyboard.type` — memória
 * `e2e-humano-nao-e-fill`) contra um `users` semeado por SQL (o mesmo padrão
 * de `login-humano.ts`), sem Firebase Emulator.
 *
 * Exercises (Fase 2 da change):
 *   P20 — os 3 lugares e a API dizem o mesmo número + print (DX-2.11, DX-2.13)
 *   P21 — Pre Screening une PRE_SCREENING + IN_PROGRESS numa coluna só
 */

import { test, expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  insertTestWorker,
  cleanupTestWorker,
} from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

// DX-EX-1 (Fase 1): fixar 8080 quebraria contra esta stack isolada (cadeia-f2,
// 8102) — o CI (stack padrão) mantém o comportamento de hoje via o default.
const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

const MOCK_ADMIN_USER: MockUser = {
  uid: 'e2e-int-admin-funil-vacante',
  email: 'admin.funil.vacante@e2e.test',
  role: 'admin',
  country: 'AR',
};
const MOCK_TOKEN = tokenFor(MOCK_ADMIN_USER);

// DX-2.1: as 7 colunas do quadro B e o `sources` de cada uma — LITERAL aqui
// (não importado de `funnelTabsConfig.ts`), para não repetir no teste a mesma
// fonte que o P36 (sabotagem) ataca no código de produção.
const COLUMN_SOURCES: Record<string, string[]> = {
  INVITED: ['INVITED'],
  INICIADO: ['INICIADO'],
  PRE_SCREENING: ['PRE_SCREENING', 'IN_PROGRESS'],
  COMPLETED: ['COMPLETED'],
  CONFIRMED: ['CONFIRMED'],
  SELECTED: ['SELECTED'],
  REJECTED: ['REJECTED'],
};
const COLUMN_IDS = Object.keys(COLUMN_SOURCES);

// ── Helpers ───────────────────────────────────────────────────────────────────

function seedAdminUser(): void {
  runSQL(
    `INSERT INTO users (firebase_uid, email, display_name, role, is_active, account_type, status) ` +
      `VALUES ('${MOCK_ADMIN_USER.uid}', '${MOCK_ADMIN_USER.email}', 'E2E Funil Vacante', 'admin', true, 'staff', 'ACTIVE') ` +
      `ON CONFLICT (firebase_uid) DO NOTHING`,
  );
}

function cleanupAdminUser(): void {
  runSQL(`DELETE FROM users WHERE firebase_uid = '${MOCK_ADMIN_USER.uid}'`);
}

/** stageCounts (8 chaves derivadas) → as 7 contagens do quadro B, somando `sources`. */
function expectedFromApi(stageCounts: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const col of COLUMN_IDS) {
    out[col] = COLUMN_SOURCES[col].reduce((acc, s) => acc + (stageCounts[s] ?? 0), 0);
  }
  return out;
}

async function readApiStageCounts(
  request: APIRequestContext,
  vacancyId: string,
): Promise<Record<string, number>> {
  const res = await request.get(`${BACKEND_URL}/api/admin/vacancies?limit=20&offset=0`, {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(res.ok(), `GET /api/admin/vacancies falhou: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { data: Array<{ id: string; stageCounts: Record<string, number> }> };
  const row = body.data.find((v) => v.id === vacancyId);
  if (!row) throw new Error(`vaga ${vacancyId} não encontrada em GET /api/admin/vacancies`);
  return expectedFromApi(row.stageCounts);
}

async function gotoVacanciesList(page: Page): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse((r) => /\/api\/admin\/vacancies\?/.test(r.url()) && r.request().method() === 'GET'),
    page.goto('/admin/vacancies'),
  ]);
  return response;
}

/**
 * `VacancyFunnelView.tsx` persiste a última vista (list/kanban) em
 * `localStorage['vacancy-funnel-view-<id>']` — sem limpar, uma 2ª navegação à
 * MESMA vaga depois de `switchToKanban` reabre em Kanban, não em "lista
 * (default)". Cada chamada representa uma visita FRESCA: sempre em lista.
 */
async function gotoVacancyDetail(page: Page, vacancyId: string): Promise<Response> {
  await page
    .evaluate((id) => localStorage.removeItem(`vacancy-funnel-view-${id}`), vacancyId)
    .catch(() => {});
  const funnelTableRe = new RegExp(`/vacancies/${vacancyId}/funnel-table(\\?|$)`);
  const [response] = await Promise.all([
    page.waitForResponse((r) => funnelTableRe.test(r.url()) && r.request().method() === 'GET'),
    page.goto(`/admin/vacancies/${vacancyId}`),
  ]);
  return response;
}

async function switchToKanban(page: Page, vacancyId: string): Promise<Response> {
  const funnelRe = new RegExp(`/vacancies/${vacancyId}/funnel(\\?|$)`);
  const [response] = await Promise.all([
    page.waitForResponse((r) => funnelRe.test(r.url()) && r.request().method() === 'GET'),
    page
      .getByRole('group', { name: 'Cambiar vista' })
      .getByRole('button', { name: /Kanban/i })
      .click(),
  ]);
  return response;
}

async function readTestIdNumbers(
  page: Page,
  testIdFor: (col: string) => string,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const col of COLUMN_IDS) {
    out[col] = Number(await page.getByTestId(testIdFor(col)).innerText());
  }
  return out;
}

async function countFunnelTableRows(page: Page): Promise<number> {
  return page.getByTestId('vacancy-funnel-view').getByRole('table').locator('tbody tr').count();
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('funil da vacante @integration', () => {
  test.use({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(90_000);

  // V1 (P20 + P22): 7 workers cobrindo as 7 colunas + 1 controle (G) fora de tudo.
  let patientIdV1 = '';
  let vacancyIdV1 = '';
  const workersV1: Record<string, string> = {};
  const wjaIdsV1: Record<string, string> = {};

  test.beforeAll(() => {
    seedAdminUser();

    const { patientId, addressId } = insertTestPatient({
      withAddress: true,
      firstName: 'FunilVacante',
      lastName: `V1-${Date.now()}`,
    });
    patientIdV1 = patientId;
    const caseNumber = 980_000 + Math.floor(Math.random() * 9_000);
    vacancyIdV1 = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });

    for (const letter of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      workersV1[letter] = insertTestWorker({
        firstName: `FunilV1${letter}`,
        lastName: `E2E${Date.now()}`,
      });
    }

    // A — Invitados: INVITED/system + messaged_at (o "convidado de verdade").
    wjaIdsV1.A = insertWJA({
      workerId: workersV1.A,
      jobPostingId: vacancyIdV1,
      funnelStage: 'INVITED',
      source: 'system',
    });
    runSQL(`UPDATE worker_job_applications SET messaged_at = NOW() WHERE id = '${wjaIdsV1.A}'`);
    // B — Iniciados: INVITED/manual (postulação).
    wjaIdsV1.B = insertWJA({
      workerId: workersV1.B,
      jobPostingId: vacancyIdV1,
      funnelStage: 'INVITED',
      source: 'manual',
    });
    // C + D — Pre Screening une PRE_SCREENING e IN_PROGRESS.
    wjaIdsV1.C = insertWJA({
      workerId: workersV1.C,
      jobPostingId: vacancyIdV1,
      funnelStage: 'PRE_SCREENING',
      source: 'talentum',
    });
    wjaIdsV1.D = insertWJA({
      workerId: workersV1.D,
      jobPostingId: vacancyIdV1,
      funnelStage: 'IN_PROGRESS',
      source: 'talentum',
    });
    // E — Selecionados.
    wjaIdsV1.E = insertWJA({ workerId: workersV1.E, jobPostingId: vacancyIdV1, funnelStage: 'SELECTED' });
    // F — Rejeitados (candidatura normal).
    wjaIdsV1.F = insertWJA({ workerId: workersV1.F, jobPostingId: vacancyIdV1, funnelStage: 'REJECTED' });
    // G — controle: INVITED/system SEM messaged_at, fica fora de tudo (nunca mensageado).
    wjaIdsV1.G = insertWJA({
      workerId: workersV1.G,
      jobPostingId: vacancyIdV1,
      funnelStage: 'INVITED',
      source: 'system',
    });
  });

  test.afterAll(() => {
    for (const letter of Object.keys(workersV1)) {
      const workerId = workersV1[letter];
      try {
        cleanupWJAAndEncuadre(workerId, vacancyIdV1);
      } catch (err) {
        console.error(`[cleanup] wja/encuadre ${letter} falhou (seguindo)`, err);
      }
      try {
        cleanupTestWorker(workerId);
      } catch (err) {
        console.error(`[cleanup] worker ${letter} falhou (seguindo)`, err);
      }
    }
    try {
      cleanupTestPatient(patientIdV1);
    } catch (err) {
      console.error('[cleanup] patient V1 falhou (seguindo)', err);
    }
    try {
      cleanupAdminUser();
    } catch (err) {
      console.error('[cleanup] users falhou (seguindo)', err);
    }
  });

  // ── P20 · os 3 lugares e a API dizem o mesmo número + print ───────────────
  test('funil-vacante-tres-lugares', async ({ page, request }) => {
    // 1. API, na mesma execução — o esperado sai da SOMA de `sources`, não do front.
    const apiCounts = await readApiStageCounts(request, vacancyIdV1);

    // 2. loginAs (click + keyboard.type). Requests só depois do login.
    await loginAs(page, MOCK_ADMIN_USER);

    const requestUrls: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET') requestUrls.push(req.url());
    });

    const listResponse = await gotoVacanciesList(page);
    expect(listResponse.ok(), 'GET /api/admin/vacancies (lista) falhou').toBe(true);
    await expect(page.getByTestId(`vacancy-row-${vacancyIdV1}`)).toBeVisible({ timeout: 15_000 });

    // Primeira linha depois da navegação: o print.
    if (process.env.PRINT_DIR) {
      await page.screenshot({ path: `${process.env.PRINT_DIR}/lista-vacantes.png`, fullPage: true });
    }

    const listCounts = await readTestIdNumbers(page, (col) => `vacancy-row-${vacancyIdV1}-stage-${col}`);

    // 3. Contador (2.10, DX-2.13): 1 listagem distinta, 0 por-vaga NESTA tela.
    const listagensDistintas = new Set(
      requestUrls.filter((u) => /\/api\/admin\/vacancies\?/.test(u)),
    ).size;
    const porVaga = requestUrls.filter((u) => /\/api\/admin\/vacancies\/[0-9a-f-]{36}/.test(u)).length;
    console.log('[2.10] listagens distintas=', listagensDistintas, 'por-vaga=', porVaga);

    // 4. Modo lista: clica na linha → /admin/vacancies/<V1> (default).
    const funnelTableRe = new RegExp(`/vacancies/${vacancyIdV1}/funnel-table(\\?|$)`);
    const [funnelTableResponse] = await Promise.all([
      page.waitForResponse((r) => funnelTableRe.test(r.url()) && r.request().method() === 'GET'),
      page.getByTestId(`vacancy-row-${vacancyIdV1}`).click(),
    ]);
    expect(funnelTableResponse.ok(), 'GET funnel-table falhou').toBe(true);
    await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyIdV1}`));
    await expect(page.getByTestId('vacancy-funnel-view')).toBeVisible({ timeout: 15_000 });
    if (process.env.PRINT_DIR) {
      await page.screenshot({ path: `${process.env.PRINT_DIR}/funil-modo-lista.png`, fullPage: true });
    }
    const tabCounts = await readTestIdNumbers(page, (col) => `funnel-tab-${col}-count`);

    // 5. Kanban.
    const kanbanResponse = await switchToKanban(page, vacancyIdV1);
    expect(kanbanResponse.ok(), 'GET funnel (kanban) falhou').toBe(true);
    await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });
    if (process.env.PRINT_DIR) {
      await page.screenshot({ path: `${process.env.PRINT_DIR}/funil-kanban.png`, fullPage: true });
    }
    const kanbanCounts = await readTestIdNumbers(page, (col) => `kanban-column-${col}-count`);

    // 6. Asserts: cell == tab == badge == api, por coluna nomeada.
    for (const col of COLUMN_IDS) {
      expect(listCounts[col], `lista.${col}`).toBe(apiCounts[col]);
      expect(tabCounts[col], `aba.${col}`).toBe(apiCounts[col]);
      expect(kanbanCounts[col], `kanban.${col}`).toBe(apiCounts[col]);
    }
    // Literais que provam o semeado (G fora — nunca mensageado).
    expect(apiCounts.INVITED, 'INVITED').toBe(1);
    expect(apiCounts.INICIADO, 'INICIADO').toBe(1);
    expect(apiCounts.PRE_SCREENING, 'PRE_SCREENING').toBe(2);
    expect(apiCounts.SELECTED, 'SELECTED').toBe(1);
    expect(apiCounts.REJECTED, 'REJECTED').toBe(1);

    expect(listagensDistintas, 'listagens distintas').toBe(1);
    expect(porVaga, 'requests por-vaga nesta tela').toBe(0);
  });

  // ── P21 · Pre Screening une PRE_SCREENING + IN_PROGRESS ────────────────────
  test('funil-vacante-pre-screening-une', async ({ page }) => {
    const { patientId, addressId } = insertTestPatient({
      withAddress: true,
      firstName: 'FunilV2',
      lastName: `PreScreening-${Date.now()}`,
    });
    const caseNumber = 981_000 + Math.floor(Math.random() * 900);
    const vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });
    const workerPreScreening = insertTestWorker({ firstName: 'FunilV2PS', lastName: `E2E${Date.now()}` });
    const workerInProgress = insertTestWorker({ firstName: 'FunilV2IP', lastName: `E2E${Date.now()}` });

    try {
      insertWJA({
        workerId: workerPreScreening,
        jobPostingId: vacancyId,
        funnelStage: 'PRE_SCREENING',
        source: 'talentum',
      });
      insertWJA({
        workerId: workerInProgress,
        jobPostingId: vacancyId,
        funnelStage: 'IN_PROGRESS',
        source: 'talentum',
      });

      await loginAs(page, MOCK_ADMIN_USER);

      // Kanban: uma coluna só (PRE_SCREENING), contando os dois — sem IN_PROGRESS.
      await gotoVacancyDetail(page, vacancyId);
      await expect(page.getByTestId('vacancy-funnel-view')).toBeVisible({ timeout: 15_000 });
      await switchToKanban(page, vacancyId);
      await expect(page.getByTestId('kanban-board')).toBeVisible({ timeout: 15_000 });
      // Não conta pelo DOM dos cards (a coluna pode estar colapsada) — pelo contador.
      await expect(page.getByTestId('kanban-column-PRE_SCREENING-count')).toHaveText('2');
      await expect(page.getByTestId('kanban-column-IN_PROGRESS')).toHaveCount(0);
      await expect(page.getByTestId('kanban-column-PRE_SCREENING')).toHaveCount(1);

      // Modo lista: a aba "Pre Screening" também soma os dois, e a tabela mostra as 2 linhas.
      await gotoVacancyDetail(page, vacancyId);
      await expect(page.getByTestId('vacancy-funnel-view')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('funnel-tab-PRE_SCREENING-count')).toHaveText('2');
      await page.locator('#funnel-tab-PRE_SCREENING').click();
      await expect
        .poll(() => countFunnelTableRows(page), { message: 'linhas da tabela em Pre Screening' })
        .toBe(2);
    } finally {
      cleanupWJAAndEncuadre(workerPreScreening, vacancyId);
      cleanupWJAAndEncuadre(workerInProgress, vacancyId);
      cleanupTestWorker(workerPreScreening);
      cleanupTestWorker(workerInProgress);
      cleanupTestPatient(patientId);
    }
  });
});
