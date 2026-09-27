/**
 * funil-vacante-lancamento.integration.e2e.ts @integration
 *
 * P12 (Fase 6, cadeia-paciente-vacante-itinerario) — 1 teste, caminho COMPLETO de tela
 * (ficha → foguete → borrador → wizard → /talentum → "Publicar en Talentum"):
 *
 * `lancamento-move-para-busqueda` (critérios 4, 5 e 8):
 *   4. o lançamento move o paciente ADMISSION → SEARCHING (trilha `vacancy_launch`, coluna
 *      do Kanban do paciente);
 *   5. o match sem convite roda: W1/W2 caem em Compatíveis, sem tocar canal real (a Talentum
 *      só no stub, nenhum request do navegador a canal externo, `stub.calls` com 1 create);
 *   8. o arrasto manual de Compatíveis até Equipe de Resposta Rápida continua liberado (DX-5.6)
 *      e pede motivo de salto (JUMP) — e não mexe no status do paciente nem na trilha do
 *      lançamento (o gancho já rodou; o arrasto é do quadro B, não do funil do paciente).
 *
 * Único mock de navegador: `/generate-ai-content` (Gemini custaria) — instalado ANTES do
 * login (`mockGenerateAiContent`), senão a página `/talentum` fica esperando a IA de verdade
 * numa navegação que já passou pelo interceptor de auth. `publish-talentum` NUNCA é mockado:
 * vai ao backend, que vai ao stub da Talentum (porta 9914, `startTalentumStub`).
 *
 * Helpers: `lancamento-e2e-helper.ts` (P4 — stub, seed do paciente lançável, caminho pela
 * tela, trilha do lançamento), `funnel-move-e2e-helper.ts`/`compativeis-e2e-helper.ts`
 * (Fases 4/5 — leitura do funil, contagem de efeito colateral, modal de motivo, Kanban da
 * vaga), `dndKitDrag.ts` (arrasto compatível com dnd-kit — molda `scrollIntoViewIfNeeded`
 * do alvo durante o drag, sem precisar colapsar colunas).
 */

import { test, expect } from '@playwright/test';
import {
  startTalentumStub,
  seedLaunchablePatient,
  seedWorkersNear,
  clickFoguete,
  completeDraftViaWizard,
  publishOnTalentumPage,
  readPatientKanbanColumn,
  countLaunchTrail,
  backendUrl,
  mockAdminUserFor,
  useLancamentoStaff,
  loginAndMockAi,
  LANCAMENTO_VIEWPORT_ES_AR,
  type FunnelStageItem,
} from '../helpers/lancamento-e2e-helper';
import { readPatientStatusApi, countOutboundSince, chooseReasonInModal } from '../helpers/funnel-move-e2e-helper';
import { readFunnelApi, switchToKanban, gotoVacancyDetail, readStageCount } from '../helpers/compativeis-e2e-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { tokenFor } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { cleanupTestWorker } from '../helpers/db-test-helper';

// Canal real — critério 5 (DX-6.9/Q-EX-6.5): o navegador NUNCA fala com nenhum destes hosts
// (quem fala com a Talentum é o backend, via stub). Testa só o HOSTNAME (não a URL inteira —
// a própria API tem rotas como `/workers/sync-talentum`, memória de `funil-vacante-motivo`).
const FORBIDDEN_HOSTS = /twilio|whatsapp|facebook|periskope|talentum\.chat|groq|generativelanguage/i;

const MOCK_ADMIN_USER = mockAdminUserFor('move');

/** Última linha da trilha `vacancy_launch` do paciente — `old_value`/`new_value` (critério 4). */
function readLaunchTrailRow(patientId: string): { oldValue: string | null; newValue: string } | null {
  const out = runSQL(
    `SELECT COALESCE(old_value, ''), new_value FROM patient_status_history ` +
      `WHERE patient_id = '${patientId}' AND change_source = 'vacancy_launch' ORDER BY created_at DESC LIMIT 1`,
  );
  if (!out.trim()) return null;
  const [oldValue, newValue] = out.split('|');
  return { oldValue: oldValue || null, newValue };
}

test.describe('funil-vacante lancamento @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  test.setTimeout(120_000);

  useLancamentoStaff(MOCK_ADMIN_USER, 'E2E Lancamento Move F6');

  test('lancamento-move-para-busqueda', async ({ page, request }) => {
    // Coordenada própria do arquivo (DX-6.9) — distinta de P1/P10/P11/P24 e dos outros e2e do grupo.
    const LAT = -53.7877;
    const LNG = -67.7094;

    const token = tokenFor(MOCK_ADMIN_USER);
    const stub = await startTalentumStub();

    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });
    const [w1, w2] = seedWorkersNear(LAT, LNG, 2);

    try {
      // DEPOIS do login, não antes: `loginAs` registra `page.route('**/api/**', swapToken)`
      // (abac-stack-helper.ts:134) com `route.continue()` — Playwright resolve rotas que casam
      // a MESMA URL na ordem INVERSA de registro (a última registrada é tentada primeiro); como
      // `swapToken` nunca chama `route.fallback()`, ele vence e a request de `/generate-ai-content`
      // vai à API real (medido: 400 "Prompt document ID não configurado") se o mock for instalado
      // ANTES do login. DESVIO DO PASSO: o texto do P12 diz o oposto ("tem de ser antes do
      // login") — essa nota do plano cobre só o timing de NAVEGAÇÃO (instalar antes de qualquer
      // `page.goto`, para não perder a 1ª chamada), não a prioridade de rotas do Playwright: os
      // dois requisitos só coexistem registrando depois do login (que já não navega mais até o
      // foguete) e antes do clique no foguete. `loginAndMockAi` (helper, G2) encapsula essa ordem.
      await loginAndMockAi(page, MOCK_ADMIN_USER);

      // "desde o login": só requests do navegador a partir daqui entram na contagem do critério 5.
      const requestUrls: string[] = [];
      page.on('request', (req) => requestUrls.push(req.url()));
      const t0 = new Date();

      // (1) Foguete pela ficha.
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);

      // (2) Borrador → wizard (profissão AT, salário, meet) → /talentum.
      await completeDraftViaWizard(page, vacancyId);

      // (3) Antes do clique em "Publicar en Talentum".
      const statusBefore = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusBefore, 'status antes do publish').toBe('ADMISSION');
      const trailBefore = countLaunchTrail(patient.patientId);
      expect(trailBefore, 'trilha vacancy_launch antes do publish').toBe(0);

      // (4) Publicar en Talentum — nunca mockado, vai ao backend → stub (porta 9914).
      const publishStatus = await publishOnTalentumPage(page, vacancyId);
      expect(publishStatus, 'POST /publish-talentum').toBe(200);
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`), { timeout: 15_000 });

      // ── Critério 4: o lançamento move ADMISSION → SEARCHING ──────────────────────
      const statusAfter = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusAfter, 'status depois do publish').toBe('SEARCHING');

      const trailAfter = countLaunchTrail(patient.patientId);
      expect(trailAfter, 'trilha vacancy_launch depois do publish').toBe(1);
      const trailRow = readLaunchTrailRow(patient.patientId);
      expect(trailRow?.oldValue, 'old_value da linha de vacancy_launch').toBe('ADMISSION');
      expect(trailRow?.newValue, 'new_value da linha de vacancy_launch').toBe('SEARCHING');

      const columnAfterLaunch = await readPatientKanbanColumn(page, patient.patientId);
      expect(columnAfterLaunch, 'coluna do Kanban do paciente depois do lançamento').toBe('SEARCHING');

      console.log('[6.4] lancamento-move-para-busqueda', {
        vacancyId,
        patientId: patient.patientId,
        statusBefore,
        statusAfter,
        trailBefore,
        trailAfter,
        trailRow,
        columnAfterLaunch,
      });

      // ── Critério 5: match sem convite, sem tocar canal real ──────────────────────
      // readPatientKanbanColumn navegou para /admin/patients/kanban — voltar à vaga.
      await gotoVacancyDetail(page, vacancyId);
      await switchToKanban(page, vacancyId);

      const compatibleCount = await readStageCount(page, 'kanban-column-COMPATIBLE-count');
      expect(compatibleCount, 'contagem de Compatíveis (delta, nunca absoluto)').toBeGreaterThanOrEqual(2);

      const funnel = (await readFunnelApi(request, token, vacancyId)) as {
        stages?: Record<string, FunnelStageItem[]>;
      };
      const compatible = funnel.stages?.COMPATIBLE ?? [];
      const w1Item = compatible.find((it) => it.workerId === w1);
      const w2Item = compatible.find((it) => it.workerId === w2);
      expect(w1Item, 'W1 pertence a stages.COMPATIBLE').toBeTruthy();
      expect(w2Item, 'W2 pertence a stages.COMPATIBLE').toBeTruthy();
      const w1WjaId = w1Item!.id;

      await expect(
        page.locator(`[data-testid="kanban-column-COMPATIBLE"] [data-testid="kanban-card-${w1WjaId}"]`),
      ).toBeVisible({ timeout: 10_000 });
      await expect(
        page.locator(`[data-testid="kanban-column-COMPATIBLE"] [data-testid="kanban-card-${w2Item!.id}"]`),
      ).toBeVisible({ timeout: 10_000 });

      const outboundW1 = countOutboundSince(w1, t0);
      const outboundW2 = countOutboundSince(w2, t0);
      expect(outboundW1.outbox, 'outbox de W1 desde t0').toBe(0);
      expect(outboundW1.domainEvents, 'domain_events de W1 desde t0').toBe(0);
      expect(outboundW1.stageMessageLog, 'funnel_stage_message_log de W1 desde t0').toBe(0);
      expect(outboundW2.outbox, 'outbox de W2 desde t0').toBe(0);
      expect(outboundW2.domainEvents, 'domain_events de W2 desde t0').toBe(0);
      expect(outboundW2.stageMessageLog, 'funnel_stage_message_log de W2 desde t0').toBe(0);

      const apiHost = new URL(backendUrl()).host;
      const forbiddenCount = requestUrls.filter((u) => FORBIDDEN_HOSTS.test(new URL(u).host)).length;
      const localCount = requestUrls.filter((u) => new URL(u).host === apiHost).length;
      expect(forbiddenCount, 'requests do navegador a canal real (twilio/whatsapp/facebook/periskope/talentum.chat/groq/generativelanguage)').toBe(0);
      expect(localCount, 'controle positivo: requests à própria API').toBeGreaterThan(0);

      const talentumCreateCalls = stub.calls.filter(
        (c) => c.method === 'POST' && c.path === '/pre-screening/projects',
      ).length;
      expect(talentumCreateCalls, 'stub.calls POST /pre-screening/projects').toBe(1);

      console.log('[6.5] lancamento-move-para-busqueda', {
        compatibleCount,
        w1WorkerId: w1,
        w2WorkerId: w2,
        w1WjaId,
        w2WjaId: w2Item!.id,
        outboundW1,
        outboundW2,
        forbiddenCount,
        localCount,
        stubCalls: stub.calls,
      });

      // ── Critério 8: arrasto Compatíveis → Equipe de Resposta Rápida (JUMP, DX-5.6) ──
      const s0 = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(s0, 'status antes do arrasto no quadro B').toBe('SEARCHING');

      const w1Card = page.locator(`[data-testid="kanban-draggable-${w1WjaId}"]`);
      const targetColumn = page.locator('[data-testid="kanban-column-QUICK_RESPONSE_TEAM"]');

      const [firstPut] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'PUT' && /\/move$/.test(r.url())),
        dndKitDrag(page, w1Card, targetColumn),
      ]);
      expect(firstPut.status(), '1º PUT (sem motivo) tem de pedir motivo de salto').toBe(422);

      const moveReasonModal = page.getByTestId('move-reason-modal');
      await expect(moveReasonModal).toBeVisible();

      const [secondPut] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'PUT' && /\/move$/.test(r.url())),
        chooseReasonInModal(page, 'move-reason', 'ENCUADRE_ANTECIPADO'),
      ]);
      expect(secondPut.ok(), `2º PUT (com motivo) deveria ser 2xx, veio ${secondPut.status()}`).toBe(true);
      await expect(moveReasonModal).toHaveCount(0);

      await expect(
        page.locator(`[data-testid="kanban-column-QUICK_RESPONSE_TEAM"] [data-testid="kanban-card-${w1WjaId}"]`),
      ).toBeVisible({ timeout: 10_000 });

      const sAfterMove = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(sAfterMove, 'status do paciente não muda com o arrasto no quadro B').toBe(s0);

      const trailAfterMove = countLaunchTrail(patient.patientId);
      expect(trailAfterMove, 'trilha vacancy_launch não ganha linha nova com o arrasto').toBe(1);
      const trailRowTeardown = readLaunchTrailRow(patient.patientId);

      console.log('[6.8] lancamento-move-para-busqueda', {
        s0,
        firstPutStatus: firstPut.status(),
        secondPutStatus: secondPut.status(),
        sAfterMove,
        trailAfterMove,
        trailRowTeardown,
      });
    } finally {
      await stub.close();
      patient.cleanup();
      cleanupTestWorker(w1);
      cleanupTestWorker(w2);
    }
  });
});
