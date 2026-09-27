/**
 * funil-vacante-compativeis-convite.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 5 da change cadeia-paciente-vacante-itinerario (P18):
 * convidar um candidato "Compatível" é o envio que JÁ EXISTE (DX-5.8) — nenhum botão novo.
 * O "Reenviar" da tarjeta, clicado num card que está em `kanban-column-COMPATIBLE`,
 * carimba `messaged_at` e o card passa a contar como "Invitados" nos 3 lugares (o mesmo
 * `isMatchedNotInvited`/`deriveKanbanColumn` do P16/P17 — `WF/domain/kanbanColumn.ts:42-49`).
 *
 * REGRA SUPREMA: nenhum canal real. O worker do teste nasce com
 * `messaging_channel = 'periskope'` (`seedCompatibleCard(vacancyId, { periskope: true })`) —
 * o envio sai do backend para o stub Periskope da porta 9911
 * (`startPeriskopeStub`, molde `kanban-reenviar.integration.e2e.ts:40-58`), nunca para
 * Twilio/WhatsApp/Meta reais. O teste prova as duas pontas: o stub recebeu exatamente
 * 1 chamada, e nenhuma request do NAVEGADOR foi a `twilio|whatsapp|facebook|graph.facebook|
 * periskope` — o controle positivo é a própria API sob teste (`E2E_BACKEND_URL`).
 */

import { test, expect, type Page } from '@playwright/test';
import { seedVacancyWithCards } from '../helpers/funnel-move-e2e-helper';
import {
  seedCompatibleCard,
  cleanupCompatibleCard,
  readCompatibleCountsOnScreen,
  startPeriskopeStub,
  seedVacancyMatchTemplates,
  type PeriskopeStub,
} from '../helpers/compativeis-e2e-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';
// Host da própria API sob teste — derivado de BACKEND_URL (nunca localhost:8106 literal
// no spec: no CI a api sobe em localhost:8080, neste worktree local em localhost:8106).
const API_HOST = new URL(BACKEND_URL).host;
// Regex do critério: nenhuma request do navegador a fornecedor de canal real.
const REAL_CHANNEL_RE = /twilio|whatsapp|facebook|graph\.facebook|periskope/i;

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-funil-compativeis-convite',
  email: 'staff.funil.compativeis.convite@e2e.test',
  role: 'admin',
  country: 'AR',
};

// ── Navegação (molde `funil-vacante-compativeis.integration.e2e.ts`, P17) ──────

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
 * senão uma 2ª navegação à MESMA vaga reabre em Kanban (molde da Fase 2/4/5-P17).
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

/** Lê a contagem de UM testid (número cru, sem padding — kanban/aba usam texto puro). */
async function readStageCount(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).textContent())?.trim() ?? '';
  return Number(text);
}

// ── Test ─────────────────────────────────────────────────────────────────────

test.describe('funil da vacante — convidar um Compatível é o envio que já existe (P18) @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.setTimeout(120_000);

  let stub: PeriskopeStub;
  let seed: ReturnType<typeof seedVacancyWithCards>;
  let compat: ReturnType<typeof seedCompatibleCard>;

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Funil Compatíveis Convite');
    stub = startPeriskopeStub();
    seedVacancyMatchTemplates();
    seed = seedVacancyWithCards([{ stage: 'INVITED' }]);
    compat = seedCompatibleCard(seed.vacancyId, { periskope: true });
  });

  test.afterAll(() => {
    stub.server.close();
    runSQL(`DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id = '${compat.workerId}'`);
    cleanupCompatibleCard(compat.workerId, seed.vacancyId);
    seed.cleanup();
    cleanupMockStaff(MOCK_STAFF);
  });

  test('funil-compativeis-convidado-sai', async ({ page }) => {
    const vacancyId = seed.vacancyId;
    // Card identifier: wja.id, sempre presente (`WJAFunnelController.ts:90,278` —
    // `encuadreId` é o id do ENCUADRE, usado só para mover; o card é `kanban-card-<wja.id>`).
    const cardTestId = `kanban-card-${compat.wjaId}`;

    // Critério "nada saiu para fora": toda request do navegador, desde o login.
    const requestUrls: string[] = [];
    page.on('request', (req) => requestUrls.push(req.url()));

    await loginAs(page, MOCK_STAFF);

    // ── Antes: as 6 contagens (Compatíveis e Invitados nos 3 lugares) ──────────

    await gotoVacanciesList(page);
    await expect(page.getByTestId(`vacancy-row-${vacancyId}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`vacancy-row-${vacancyId}-stage-COMPATIBLE`).scrollIntoViewIfNeeded();
    const vacantesBefore = await readCompatibleCountsOnScreen(page, vacancyId);
    const vacantesInvitedBefore = await readStageCount(page, `vacancy-row-${vacancyId}-stage-INVITED`);

    await gotoVacancyDetail(page, vacancyId);
    const listaBefore = await readCompatibleCountsOnScreen(page, vacancyId);
    const listaInvitedBefore = await readStageCount(page, 'funnel-tab-INVITED-count');

    await switchToKanban(page, vacancyId);
    const kanbanBefore = await readCompatibleCountsOnScreen(page, vacancyId);
    const kanbanInvitedBefore = await readStageCount(page, 'kanban-column-INVITED-count');

    console.log('[5.2] contagens ANTES', {
      compativeis: { vacantes: vacantesBefore.vacantes, lista: listaBefore.lista, kanban: kanbanBefore.kanban },
      invitados: { vacantes: vacantesInvitedBefore, lista: listaInvitedBefore, kanban: kanbanInvitedBefore },
    });

    expect(vacantesBefore.vacantes, 'ANTES vacantes.stage-COMPATIBLE').toBe(1);
    expect(listaBefore.lista, 'ANTES aba funnel-tab-COMPATIBLE-count').toBe(1);
    expect(kanbanBefore.kanban, 'ANTES kanban kanban-column-COMPATIBLE-count').toBe(1);
    expect(vacantesInvitedBefore, 'ANTES vacantes.stage-INVITED').toBe(1);
    expect(listaInvitedBefore, 'ANTES aba funnel-tab-INVITED-count').toBe(1);
    expect(kanbanInvitedBefore, 'ANTES kanban kanban-column-INVITED-count').toBe(1);

    // ── Na tela: card do compatível dentro de kanban-column-COMPATIBLE → Reenviar ──

    const card = page.getByTestId(cardTestId);
    await expect(page.getByTestId('kanban-column-COMPATIBLE').getByTestId(cardTestId), 'card nasce em Compatíveis').toBeVisible({
      timeout: 10_000,
    });
    await card.getByTestId('resend-button').click();
    await expect(card.getByTestId('resend-feedback'), 'feedback "Enviado ✓"').toHaveText('Enviado ✓', { timeout: 30_000 });

    // O card sai de Compatíveis e passa a estar em Invitados (polling de 5 s,
    // useWJAFunnel.ts:14, ou o refetch do próprio sucesso do reenvio).
    await expect(
      page.getByTestId('kanban-column-COMPATIBLE').getByTestId(cardTestId),
      'card saiu de Compatíveis',
    ).toHaveCount(0, { timeout: 10_000 });
    await expect(
      page.getByTestId('kanban-column-INVITED').getByTestId(cardTestId),
      'card está em Invitados',
    ).toBeVisible({ timeout: 10_000 });

    // ── Depois: as 6 contagens de novo ─────────────────────────────────────────

    const kanbanAfter = await readCompatibleCountsOnScreen(page, vacancyId);
    const kanbanInvitedAfter = await readStageCount(page, 'kanban-column-INVITED-count');

    await gotoVacancyDetail(page, vacancyId);
    const listaAfter = await readCompatibleCountsOnScreen(page, vacancyId);
    const listaInvitedAfter = await readStageCount(page, 'funnel-tab-INVITED-count');

    await gotoVacanciesList(page);
    await expect(page.getByTestId(`vacancy-row-${vacancyId}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`vacancy-row-${vacancyId}-stage-COMPATIBLE`).scrollIntoViewIfNeeded();
    const vacantesAfter = await readCompatibleCountsOnScreen(page, vacancyId);
    const vacantesInvitedAfter = await readStageCount(page, `vacancy-row-${vacancyId}-stage-INVITED`);

    console.log('[5.2] contagens DEPOIS', {
      compativeis: { vacantes: vacantesAfter.vacantes, lista: listaAfter.lista, kanban: kanbanAfter.kanban },
      invitados: { vacantes: vacantesInvitedAfter, lista: listaInvitedAfter, kanban: kanbanInvitedAfter },
    });

    expect(kanbanAfter.kanban, 'DEPOIS kanban kanban-column-COMPATIBLE-count').toBe(0);
    expect(listaAfter.lista, 'DEPOIS aba funnel-tab-COMPATIBLE-count').toBe(0);
    expect(vacantesAfter.vacantes, 'DEPOIS vacantes.stage-COMPATIBLE').toBe(0);
    expect(kanbanInvitedAfter, 'DEPOIS kanban kanban-column-INVITED-count').toBe(2);
    expect(listaInvitedAfter, 'DEPOIS aba funnel-tab-INVITED-count').toBe(2);
    expect(vacantesInvitedAfter, 'DEPOIS vacantes.stage-INVITED').toBe(2);

    // ── Stub recebeu exatamente 1 chamada; messaged_at carimbado ───────────────

    console.log('[5.2] stub.calls.length=', stub.calls.length);
    expect(stub.calls.length, 'stub Periskope recebeu exatamente 1 chamada').toBe(1);

    const messagedAtSet = runSQL(
      `SELECT messaged_at IS NOT NULL FROM worker_job_applications WHERE id = '${compat.wjaId}'`,
    );
    console.log('[5.2] messaged_at IS NOT NULL =', messagedAtSet);
    expect(messagedAtSet, 'messaged_at do WJA não é nulo').toBe('t');

    // ── Nenhum request do navegador tocou canal real; controle: requests à API ──

    // Testa o HOSTNAME, não a URL inteira — a app local tem módulos/arquivos com
    // "whatsapp" no nome (`CompleteWhatsappPage.tsx`, `WhatsappStatusBadge`) que o
    // Vite serve por HMR; casar a URL inteira acusaria FALSO POSITIVO nesses assets
    // do próprio dev server (medido: 16 hits, todos `localhost:5189/src/...`).
    const realChannelHits = requestUrls.filter((u) => {
      try {
        return REAL_CHANNEL_RE.test(new URL(u).hostname);
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
    console.log('[5.2] requests do navegador', {
      realChannelHits: realChannelHits.length,
      backendHits: backendHits.length,
      amostraRealChannel: realChannelHits.slice(0, 5),
    });
    expect(realChannelHits.length, 'nenhuma request do navegador a twilio|whatsapp|facebook|graph.facebook|periskope').toBe(
      0,
    );
    expect(backendHits.length, `controle positivo: requests a ${API_HOST}`).toBeGreaterThan(0);
  });
});
