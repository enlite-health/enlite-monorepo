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
  gotoVacancyDetail,
  readStageCount,
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

// `gotoVacancyDetail`/`switchToKanban`/`readStageCount` vivem em `compativeis-e2e-helper.ts`
// (achado 🟡-3 do gate parcial, G2) — importadas acima, byte-idênticas nos 4 specs novos.

// ── Test ─────────────────────────────────────────────────────────────────────

test.describe('funil da vacante — convidar um Compatível é o envio que já existe (P18) @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.setTimeout(120_000);
  // 054: serial — o stub Periskope (porta 9911) é compartilhado e o 1º teste afirma `stub.calls.length === 1`;
  // o teste da barra (abaixo) roda DEPOIS e mede o delta.
  test.describe.configure({ mode: 'serial' });

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

    // 054: a tela abre no Kanban (padrão) — as contagens por coluna são lidas nele
    // (`kanban-column-<col>-count`); a Lista não tem mais abas com contagem.
    await gotoVacancyDetail(page, vacancyId);
    const kanbanBefore = await readCompatibleCountsOnScreen(page, vacancyId);
    const kanbanInvitedBefore = await readStageCount(page, 'kanban-column-INVITED-count');

    console.log('[5.2] contagens ANTES', {
      compativeis: { vacantes: vacantesBefore.vacantes, kanban: kanbanBefore.kanban },
      invitados: { vacantes: vacantesInvitedBefore, kanban: kanbanInvitedBefore },
    });

    expect(vacantesBefore.vacantes, 'ANTES vacantes.stage-COMPATIBLE').toBe(1);
    expect(kanbanBefore.kanban, 'ANTES kanban kanban-column-COMPATIBLE-count').toBe(1);
    expect(vacantesInvitedBefore, 'ANTES vacantes.stage-INVITED').toBe(1);
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

    // Recarrega (visita fresca, Kanban): o número persistido bate com o da tela viva.
    await gotoVacancyDetail(page, vacancyId);
    const reloadAfter = await readCompatibleCountsOnScreen(page, vacancyId);
    const reloadInvitedAfter = await readStageCount(page, 'kanban-column-INVITED-count');

    await gotoVacanciesList(page);
    await expect(page.getByTestId(`vacancy-row-${vacancyId}`)).toBeVisible({ timeout: 15_000 });
    await page.getByTestId(`vacancy-row-${vacancyId}-stage-COMPATIBLE`).scrollIntoViewIfNeeded();
    const vacantesAfter = await readCompatibleCountsOnScreen(page, vacancyId);
    const vacantesInvitedAfter = await readStageCount(page, `vacancy-row-${vacancyId}-stage-INVITED`);

    console.log('[5.2] contagens DEPOIS', {
      compativeis: { vacantes: vacantesAfter.vacantes, kanbanRecarregado: reloadAfter.kanban, kanban: kanbanAfter.kanban },
      invitados: { vacantes: vacantesInvitedAfter, kanbanRecarregado: reloadInvitedAfter, kanban: kanbanInvitedAfter },
    });

    expect(kanbanAfter.kanban, 'DEPOIS kanban kanban-column-COMPATIBLE-count').toBe(0);
    expect(reloadAfter.kanban, 'DEPOIS (recarregado) kanban-column-COMPATIBLE-count').toBe(0);
    expect(vacantesAfter.vacantes, 'DEPOIS vacantes.stage-COMPATIBLE').toBe(0);
    expect(kanbanInvitedAfter, 'DEPOIS kanban kanban-column-INVITED-count').toBe(2);
    expect(reloadInvitedAfter, 'DEPOIS (recarregado) kanban-column-INVITED-count').toBe(2);
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

  // ── 054 item 6: a barra "Enviar invitaciones (N)" NA VISÃO KANBAN (sem clicar Lista) ──
  // Mapa do side-effect outbound: a barra enfileira em `inviteProgressStore` →
  // `AdminApiService.sendVacancyMatchInvite` → POST /api/admin/messaging/whatsapp/vacancy-match
  // (MESMA rota do "Reenviar" da tarjeta, só sem `resend:true` → guard em modo `invite`,
  // `MessagingController.ts:90`). O worker nasce com `messaging_channel='periskope'`, então o envio
  // sai do backend para o stub da 9911 — nunca Twilio/Meta. O N vem de `useInvitedPendingCandidates`
  // (linhas do bucket INVITED com `whatsappStatus === 'NOT_SENT'`, i.e. sem log de disparo), que
  // inclui o Compatível; ao enviar, o log de disparo vira 'sent' e o N cai.
  test('funil-compativeis-barra-envia-no-kanban', async ({ page }) => {
    const vacancySeed = seedVacancyWithCards([]);
    const compat2 = seedCompatibleCard(vacancySeed.vacancyId, { periskope: true });
    const callsBefore = stub.calls.length;
    const requestUrls: string[] = [];
    page.on('request', (req) => requestUrls.push(req.url()));

    try {
      await loginAs(page, MOCK_STAFF);
      // Visita fresca: abre no Kanban (padrão 054). Não clica "Lista" em momento nenhum.
      await gotoVacancyDetail(page, vacancySeed.vacancyId);
      await expect(
        page.getByRole('group', { name: 'Cambiar vista' }).getByRole('button', { name: 'Kanban' }),
      ).toHaveAttribute('aria-pressed', 'true');

      const cardTestId = `kanban-card-${compat2.wjaId}`;
      await expect(page.getByTestId('kanban-column-COMPATIBLE').getByTestId(cardTestId), 'card nasce em Compatíveis').toBeVisible({
        timeout: 15_000,
      });
      await expect(page.getByTestId('kanban-column-COMPATIBLE-count')).toHaveText('1');
      await expect(page.getByTestId('kanban-column-INVITED-count')).toHaveText('0');

      // N antes: o botão habilita quando o hook carrega (pendentes >= 1).
      const dispatchButton = page.getByRole('button', { name: /^Enviar invitaciones \(\d+\)$/ });
      await expect(dispatchButton).toBeEnabled({ timeout: 15_000 });
      const readN = async (): Promise<number> =>
        Number(/\((\d+)\)/.exec((await dispatchButton.textContent()) ?? '')?.[1] ?? NaN);
      const nBefore = await readN();
      expect(nBefore, 'N antes do envio (>= 1: o Compatível é pendente)').toBeGreaterThanOrEqual(1);

      // Barra → modal de confirmação → "Enviar".
      await dispatchButton.click();
      await expect(page.getByRole('heading', { name: /Confirmar envío/i })).toBeVisible({ timeout: 5_000 });
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();

      // O card sai de Compatíveis e entra em Invitados (polling do funil = 5 s) — prazo >= 15 s.
      await expect
        .poll(
          async () => ({
            compat: await page.getByTestId('kanban-column-COMPATIBLE').getByTestId(cardTestId).count(),
            invited: await page.getByTestId('kanban-column-INVITED').getByTestId(cardTestId).count(),
          }),
          { timeout: 30_000, intervals: [500, 1000, 2000], message: 'card Compatíveis → Invitados' },
        )
        .toEqual({ compat: 0, invited: 1 });
      await expect(page.getByTestId('kanban-column-COMPATIBLE-count')).toHaveText('0', { timeout: 15_000 });
      await expect(page.getByTestId('kanban-column-INVITED-count')).toHaveText('1', { timeout: 15_000 });

      // O N do botão cai (o log de disparo deixa o candidato de ser NOT_SENT; refetch ao fim do lote + polling).
      await expect
        .poll(readN, { timeout: 30_000, intervals: [500, 1000, 2000], message: 'N de "Enviar invitaciones (N)" cai' })
        .toBe(nBefore - 1);

      // Efeito colateral: 1 chamada ao stub, messaged_at carimbado, nada saiu do navegador para canal real.
      expect(stub.calls.length - callsBefore, 'stub Periskope recebeu exatamente 1 chamada').toBe(1);
      expect(
        runSQL(`SELECT messaged_at IS NOT NULL FROM worker_job_applications WHERE id = '${compat2.wjaId}'`),
        'messaged_at do WJA não é nulo',
      ).toBe('t');
      const realChannelHits = requestUrls.filter((u) => {
        try {
          return REAL_CHANNEL_RE.test(new URL(u).hostname);
        } catch {
          return false;
        }
      });
      expect(realChannelHits.length, 'nenhuma request do navegador a canal real').toBe(0);
      expect(requestUrls.filter((u) => new URL(u).host === API_HOST).length, `controle positivo: requests a ${API_HOST}`).toBeGreaterThan(0);
    } finally {
      runSQL(`DELETE FROM whatsapp_bulk_dispatch_logs WHERE worker_id = '${compat2.workerId}'`);
      cleanupCompatibleCard(compat2.workerId, vacancySeed.vacancyId);
      vacancySeed.cleanup();
    }
  });
});
