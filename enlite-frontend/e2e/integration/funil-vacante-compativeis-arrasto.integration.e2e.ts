/**
 * funil-vacante-compativeis-arrasto.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 5 da change cadeia-paciente-vacante-itinerario (P20):
 * Compatíveis é coluna DERIVADA e só leitura (DX-5.5/DX-5.6, D432) — o arrasto na tela
 * nunca escreve nela, nem por ela sai rumo a Invitados (virar convidado é ter sido
 * MENSAGEADO, não arrastado).
 *
 * Dois testes independentes, sem `serial` (DX-5.10) — cada um semeia e limpa o seu:
 *   funil-compativeis-sem-entrada-manual   — critério 6: arrastar Invitados → Compatíveis
 *                                             é recusado PELA TELA (droppable: false,
 *                                             nenhum PUT sai) e, pela API direta, 422
 *                                             COMPATIBLE_READ_ONLY/ENTER, nada muda.
 *                                             Controle positivo: o mesmo card arrastado
 *                                             para Rejeitados abre o modal de motivo (o
 *                                             drag funciona; só Compatíveis recusa).
 *   funil-compativeis-invitados-pelo-envio — DX-5.6: arrastar Compatíveis → Invitados
 *                                             sai 1 PUT, 422 COMPATIBLE_READ_ONLY/
 *                                             INVITE_BY_SEND, banner i18n visível, card
 *                                             continua em Compatíveis, nada gravado.
 *
 * Molde de navegação/collapse: `funil-vacante-compativeis-rematch.integration.e2e.ts` (P19).
 * `compativeis-e2e-helper.ts` (P16) semeia o card compatível; `funnel-move-e2e-helper.ts`
 * (P16, Fase 4) semeia o card Invitados/trilha/PUT direto; `dragKanbanCard`
 * (`kanban-notes-e2e-helper.ts`) faz o arrasto humano.
 */

import { test, expect, type Page } from '@playwright/test';
import { seedVacancyWithCards, putMove, countTrail } from '../helpers/funnel-move-e2e-helper';
import {
  seedCompatibleCard,
  cleanupCompatibleCard,
  gotoVacancyDetail,
  switchToKanban,
  readStageCount,
} from '../helpers/compativeis-e2e-helper';
import { getWjaByWorkerAndJob } from '../helpers/wja-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { dragKanbanCard } from '../helpers/kanban-notes-e2e-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { loginAs, tokenFor, type MockUser } from '../helpers/abac-stack-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-funil-compativeis-arrasto',
  email: 'staff.funil.compativeis.arrasto@e2e.test',
  role: 'admin',
  country: 'AR',
};
const MOCK_TOKEN = tokenFor(MOCK_STAFF);

/** As 9 colunas do quadro B (molde `funil-vacante-compativeis.integration.e2e.ts`, P17). */
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

/** Lê `worker_job_applications.messaged_at` cru (nenhum helper de leitura expõe — DX-5.10 não pediu um novo aqui). */
function readMessagedAt(wjaId: string): string | null {
  const out = runSQL(`SELECT COALESCE(messaged_at::text, '') FROM worker_job_applications WHERE id = '${wjaId}'`);
  const value = out.trim();
  return value.length > 0 ? value : null;
}

// `gotoVacancyDetail`/`switchToKanban`/`readStageCount` vivem em `compativeis-e2e-helper.ts`
// (achado 🟡-3 do gate parcial, G2) — importadas acima, byte-idênticas nos 4 specs novos.

/**
 * Molde `funil-vacante-motivo.integration.e2e.ts` (Fase 4) / P19, generalizado nos dois
 * sentidos (P20 precisa trocar QUAL par fica expandido no meio do teste — 1º
 * INVITED+COMPATIBLE, depois INVITED+REJECTED — nunca os três ao mesmo tempo: o board
 * não cabe 3×280px no viewport de 1366px sem rolagem). Coluna expandida tem o testid
 * `-collapse` (colapsa); coluna colapsada é o próprio `kanban-column-<id>`, um botão
 * (`data-collapsed="true"`) que expande ao clicar — idempotente nos dois sentidos.
 */
async function setExpandedColumns(page: Page, keep: readonly string[]): Promise<void> {
  for (const id of ALL_COLUMN_IDS) {
    const column = page.getByTestId(`kanban-column-${id}`);
    if (!(await column.count())) continue;
    const isCollapsed = (await column.getAttribute('data-collapsed')) === 'true';
    const shouldExpand = keep.includes(id);
    if (shouldExpand && isCollapsed) {
      await column.click();
    } else if (!shouldExpand && !isCollapsed) {
      const collapseButton = page.getByTestId(`kanban-column-${id}-collapse`);
      if (await collapseButton.count()) {
        await collapseButton.click();
      }
    }
  }
  await page.waitForTimeout(400);
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('funil da vacante — Compatíveis recusa entrada e saída manual (P20) @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Funil Compatíveis Arrasto');
  });

  test.afterAll(() => {
    cleanupMockStaff(MOCK_STAFF);
  });

  // ── Critério 6: sem entrada manual em Compatíveis ──────────────────────────────
  test('funil-compativeis-sem-entrada-manual', async ({ page, request }) => {
    const seed = seedVacancyWithCards([{ stage: 'INVITED' }]); // mensageado (messaged_at = NOW())
    const invited = seed.cards[0];
    const compat = seedCompatibleCard(seed.vacancyId);

    try {
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, seed.vacancyId);
      await switchToKanban(page, seed.vacancyId);
      await setExpandedColumns(page, ['INVITED', 'COMPATIBLE']);

      // Toda request desde agora — a prova de "0 PUT" é o filtro sobre esta lista.
      // O corpo de um eventual PUT /move fica logado para diagnóstico (ver "Se falhar").
      const requestUrls: string[] = [];
      page.on('request', (req) => {
        requestUrls.push(req.url());
        if (/\/move$/.test(req.url())) {
          console.log('[6] corpo do PUT /move inesperado:', req.postData());
        }
      });

      const compatCountBefore = await readStageCount(page, 'kanban-column-COMPATIBLE-count');
      const trailBefore = countTrail(invited.wjaId);

      // Arrastar o card de Invitados para Compatíveis — coluna droppable:false.
      await dragKanbanCard(page, invited.wjaId, 'COMPATIBLE');
      await page.waitForTimeout(1_000); // sem PUT esperado: dar tempo a um request tardio aparecer se existir.

      const putUrls = requestUrls.filter((u) => /\/move$/.test(u));
      console.log('[6] requests /move após o arrasto Invitados→Compatíveis:', putUrls);
      expect(putUrls.length, 'nenhum PUT .../move deveria sair do arrasto para Compatíveis').toBe(0);

      await expect(
        page.getByTestId('kanban-column-INVITED').getByTestId(`kanban-card-${invited.wjaId}`),
        'card continua em kanban-column-INVITED',
      ).toBeVisible();
      const compatCountAfter = await readStageCount(page, 'kanban-column-COMPATIBLE-count');
      console.log('[6] kanban-column-COMPATIBLE-count antes/depois do arrasto:', compatCountBefore, compatCountAfter);
      expect(compatCountAfter, 'kanban-column-COMPATIBLE-count inalterado').toBe(compatCountBefore);

      // API direta: PUT /move com targetStage COMPATIBLE no encuadre do convidado → 422.
      const moveResult = await putMove(request, BACKEND_URL, MOCK_TOKEN, invited.encuadreId, {
        targetStage: 'COMPATIBLE',
      });
      console.log('[6] PUT /move targetStage=COMPATIBLE →', moveResult.status, JSON.stringify(moveResult.body));
      expect(moveResult.status, 'PUT /move com targetStage COMPATIBLE deveria ser 422').toBe(422);
      expect((moveResult.body as { code?: string }).code, 'code').toBe('COMPATIBLE_READ_ONLY');
      expect((moveResult.body as { reason?: string }).reason, 'reason').toBe('ENTER');

      const wjaAfter = getWjaByWorkerAndJob(invited.workerId, seed.vacancyId);
      console.log('[6] etapa do convidado após o 422:', wjaAfter?.funnelStage);
      expect(wjaAfter?.funnelStage, 'etapa do convidado inalterada (continua INVITED)').toBe('INVITED');
      const messagedAtAfter = readMessagedAt(invited.wjaId);
      console.log('[6] messaged_at após o 422 (deve continuar preenchido, não nulo):', messagedAtAfter);
      expect(messagedAtAfter, 'messaged_at do convidado continua preenchido').not.toBeNull();

      const trailAfter = countTrail(invited.wjaId);
      console.log('[6] countTrail antes/depois:', trailBefore, trailAfter);
      expect(trailAfter, 'trilha inalterada (nenhuma linha nova)').toBe(trailBefore);

      // Controle positivo: o MESMO card arrastado para Rejeitados abre o modal de
      // motivo — o drag funciona; só Compatíveis recusa. Cancelar, sem gravar nada.
      // Troca o par expandido: Compatíveis já provou o que precisava, Rejeitados
      // entra para caber junto de Invitados no viewport de 1366px.
      await setExpandedColumns(page, ['INVITED', 'REJECTED']);
      await dragKanbanCard(page, invited.wjaId, 'REJECTED');
      const rejectionModal = page.getByTestId('rejection-modal');
      await expect(rejectionModal, 'controle positivo: REJECTED abre o modal de motivo').toBeVisible();
      await page.getByTestId('rejection-cancel').click();
      await expect(rejectionModal).toHaveCount(0);

      const trailAfterCancel = countTrail(invited.wjaId);
      console.log('[6] countTrail após cancelar o controle positivo:', trailAfterCancel);
      expect(trailAfterCancel, 'cancelar o modal não grava nada na trilha').toBe(trailBefore);
    } finally {
      cleanupCompatibleCard(compat.workerId, seed.vacancyId);
      seed.cleanup();
    }
  });

  // ── DX-5.6: Compatíveis → Invitados só pelo envio ─────────────────────────────
  test('funil-compativeis-invitados-pelo-envio', async ({ page, request }) => {
    const seed = seedVacancyWithCards([]); // só a vaga+paciente — sem card mensageado.
    const compat = seedCompatibleCard(seed.vacancyId);
    const wja = getWjaByWorkerAndJob(compat.workerId, seed.vacancyId);
    if (!wja) throw new Error('getWjaByWorkerAndJob não encontrou o WJA do card compatível recém-semeado');

    try {
      await loginAs(page, MOCK_STAFF);
      await gotoVacancyDetail(page, seed.vacancyId);
      await switchToKanban(page, seed.vacancyId);
      await setExpandedColumns(page, ['COMPATIBLE', 'INVITED']);

      const trailBefore = countTrail(wja.id);

      const [putResponse] = await Promise.all([
        page.waitForResponse((r) => /\/move$/.test(r.url()) && r.request().method() === 'PUT'),
        dragKanbanCard(page, wja.id, 'INVITED'),
      ]);
      console.log('[DX-5.6] PUT /move status ao arrastar Compatíveis→Invitados:', putResponse.status());
      expect(putResponse.status(), 'PUT /move deveria ser 422').toBe(422);
      const putBody = (await putResponse.json().catch(() => null)) as { code?: string; reason?: string } | null;
      console.log('[DX-5.6] corpo do 422:', JSON.stringify(putBody));
      expect(putBody?.code, 'code').toBe('COMPATIBLE_READ_ONLY');
      expect(putBody?.reason, 'reason').toBe('INVITE_BY_SEND');

      // Banner i18n visível — texto de compatibleReadOnlyTitle (es-AR), não o código cru.
      const banner = page.getByTestId('kanban-move-error');
      await expect(banner, 'banner de erro visível').toBeVisible();
      await expect(banner, 'texto do banner é o i18n de compatibleReadOnlyTitle').toContainText(
        'No se puede mover a Invitados',
      );
      const bannerText = (await banner.textContent()) ?? '';
      console.log('[DX-5.6] texto do banner:', bannerText);
      expect(bannerText, 'nenhum texto COMPATIBLE_READ_ONLY cru na página').not.toContain('COMPATIBLE_READ_ONLY');

      // O card continua em Compatíveis (nenhum movimento otimista).
      await expect(
        page.getByTestId('kanban-column-COMPATIBLE').getByTestId(`kanban-card-${wja.id}`),
        'card continua em kanban-column-COMPATIBLE',
      ).toBeVisible();

      const wjaAfter = getWjaByWorkerAndJob(compat.workerId, seed.vacancyId);
      console.log('[DX-5.6] etapa após o 422:', wjaAfter?.funnelStage);
      expect(wjaAfter?.funnelStage, 'etapa inalterada (continua INVITED, mas sem messaged_at)').toBe('INVITED');
      const messagedAtAfter = readMessagedAt(wja.id);
      console.log('[DX-5.6] messaged_at após o 422 (deve continuar nulo):', messagedAtAfter);
      expect(messagedAtAfter, 'messaged_at continua nulo').toBeNull();

      const trailAfter = countTrail(wja.id);
      console.log('[DX-5.6] countTrail antes/depois:', trailBefore, trailAfter);
      expect(trailAfter, 'trilha inalterada (nenhuma linha nova)').toBe(trailBefore);
    } finally {
      cleanupCompatibleCard(compat.workerId, seed.vacancyId);
      seed.cleanup();
    }
  });
});
