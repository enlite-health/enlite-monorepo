/**
 * funil-vacante-lancamento-idempotente.integration.e2e.ts @integration
 *
 * P15 (Fase 6, cadeia-paciente-vacante-itinerario) — 1 teste, critério 9:
 *
 * `lancamento-idempotente`:
 *   9. despublicar e publicar de novo pelo MESMO switch (`talentum-card`, aba "Talentum" da
 *      `VacancyDetailPage`) é idempotente: o publish SEMPRE chama o gancho pós-commit
 *      (`onVacancyLaunched`, DX-6.1) — mas na 2ª chamada o paciente já saiu do funil de
 *      admissão (está `SEARCHING`, não `ADMISSION`/`SOLICITANTE`/`PENDING_ADMISSION`), então
 *      `isAdmissionFunnelStatus` dá falso e o outcome é `patient: 'unchanged'` (P7,
 *      `VacancyLaunchHook.ts:372`): a trilha `vacancy_launch` continua com 1 linha (nenhuma
 *      nova), e o match que roda de novo NÃO ressuscita quem já saiu do estado de candidato do
 *      match — o rejeitado pela tela continua `REJECTED` (F53: o upsert de `saveMatchResults`
 *      não sobrescreve `application_funnel_stage`, mesmo molde do P19,
 *      `funil-vacante-compativeis-rematch.integration.e2e.ts`). O despublicar sozinho NÃO
 *      desfaz nada: o gancho só roda no publish, nunca no unpublish
 *      (`PublishVacancyToTalentumUseCase.unpublish` intocado pelo P8) — o paciente continua
 *      `SEARCHING` e a trilha continua 1 mesmo depois do DELETE.
 *
 * Único mock de navegador: `/generate-ai-content` (Gemini custaria). `publish-talentum`
 * (POST) e o despublicar (DELETE no mesmo caminho) NUNCA são mockados: vão ao backend, que vai
 * ao stub da Talentum (porta 9914, `startTalentumStub`) — por isso `stub.calls` prova os 2
 * `POST /projects` (1º lançamento + republicação) e o 1 `DELETE` (despublicar).
 *
 * Helpers: `lancamento-e2e-helper.ts` (P4 — stub, seed do paciente lançável, caminho foguete→
 * wizard→publish), `funnel-move-e2e-helper.ts` (`readPatientStatusApi`, `chooseReasonInModal`),
 * `compativeis-e2e-helper.ts` (`readFunnelApi`/`gotoVacancyDetail`/`switchToKanban`/
 * `readStageCount`), `wja-test-helper.ts` (`getWjaByWorkerAndJob` — estágio real do rejeitado),
 * `dndKitDrag.ts` (arrasto compatível com dnd-kit, molde do P12), `patient-detail-a-helper.ts`
 * (`runSQL`, `is_draft` depois do despublicar).
 */

import { test, expect } from '@playwright/test';
import {
  startTalentumStub,
  seedLaunchablePatient,
  seedWorkersNear,
  clickFoguete,
  completeDraftViaWizard,
  publishOnTalentumPage,
  countLaunchTrail,
  backendUrl,
  mockAdminUserFor,
  useLancamentoStaff,
  loginAndMockAi,
  LANCAMENTO_VIEWPORT_ES_AR,
  type FunnelStageItem,
} from '../helpers/lancamento-e2e-helper';
import { readPatientStatusApi, chooseReasonInModal } from '../helpers/funnel-move-e2e-helper';
import { readFunnelApi, gotoVacancyDetail, switchToKanban, readStageCount } from '../helpers/compativeis-e2e-helper';
import { getWjaByWorkerAndJob } from '../helpers/wja-test-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { cleanupTestWorker } from '../helpers/db-test-helper';

const MOCK_ADMIN_USER = mockAdminUserFor('idemp');

/** `is_draft` da vaga — prova de que o despublicar gravou o estado (critério 9). */
function readIsDraft(vacancyId: string): string {
  return runSQL(`SELECT is_draft FROM job_postings WHERE id = '${vacancyId}'`).trim();
}

test.describe('funil-vacante lancamento idempotente @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  test.setTimeout(120_000);

  useLancamentoStaff(MOCK_ADMIN_USER, 'E2E Lancamento Idempotente F6');

  test('lancamento-idempotente', async ({ page, request }) => {
    // Coordenada própria do arquivo (DX-6.9) — distinta de P1/P10/P11/P12/P13/P14/P24.
    const LAT = -52.1553;
    const LNG = -69.2185;

    const token = tokenFor(MOCK_ADMIN_USER);
    const stub = await startTalentumStub();

    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });
    const [workerR, workerC1, workerC2] = seedWorkersNear(LAT, LNG, 3);

    try {
      // DEPOIS do login — mesmo motivo do P12/P13/P14 (`swapToken` de `loginAs` vence rotas
      // registradas antes dele). `loginAndMockAi` (helper, G2) encapsula essa ordem.
      await loginAndMockAi(page, MOCK_ADMIN_USER);

      // (1) Foguete → wizard (profissão AT, salário, meet) → /talentum → 1º lançamento.
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);
      await completeDraftViaWizard(page, vacancyId);

      const publishStatus = await publishOnTalentumPage(page, vacancyId);
      expect(publishStatus, 'POST /publish-talentum (1º lançamento)').toBe(200);
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`), { timeout: 15_000 });

      const statusAfterLaunch = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusAfterLaunch, 'paciente SEARCHING depois do 1º lançamento').toBe('SEARCHING');

      const trailAfterLaunch = countLaunchTrail(patient.patientId);
      expect(trailAfterLaunch, 'trilha vacancy_launch = 1 depois do 1º lançamento').toBe(1);

      const funnelAfterLaunch = (await readFunnelApi(request, token, vacancyId)) as {
        stages?: Record<string, FunnelStageItem[]>;
      };
      const compatibleAfterLaunch = funnelAfterLaunch.stages?.COMPATIBLE ?? [];
      expect(compatibleAfterLaunch.length, 'os 3 workers semeados em Compatíveis depois do 1º lançamento').toBe(3);
      const wjaR0 = compatibleAfterLaunch.find((it) => it.workerId === workerR);
      expect(wjaR0, 'R pertence a Compatíveis antes de ser rejeitado').toBeTruthy();
      const wjaRId = wjaR0!.id;

      console.log('[6.9] lancamento-idempotente (1º lançamento)', {
        vacancyId,
        patientId: patient.patientId,
        statusAfterLaunch,
        trailAfterLaunch,
        compatibleCount: compatibleAfterLaunch.length,
        wjaRId,
      });

      // ── Rejeitar R pela tela — Kanban da vaga ────────────────────────────────────
      await gotoVacancyDetail(page, vacancyId);
      await switchToKanban(page, vacancyId);

      const rCard = page.locator(`[data-testid="kanban-draggable-${wjaRId}"]`);
      const rejectedColumn = page.locator('[data-testid="kanban-column-REJECTED"]');
      await dndKitDrag(page, rCard, rejectedColumn);

      const rejectionModal = page.getByTestId('rejection-modal');
      await expect(rejectionModal).toBeVisible();
      const [rejectPut] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'PUT' && /\/move$/.test(r.url())),
        chooseReasonInModal(page, 'rejection', 'DISTANCE'),
      ]);
      expect(rejectPut.ok(), `PUT /move (rejeição de R) deveria ser 2xx, veio ${rejectPut.status()}`).toBe(true);
      await expect(rejectionModal).toHaveCount(0);
      await expect(
        page.locator(`[data-testid="kanban-column-REJECTED"] [data-testid="kanban-card-${wjaRId}"]`),
        'R em Rejeitados logo após o arrasto',
      ).toBeVisible({ timeout: 10_000 });

      const compat0 = await readStageCount(page, 'kanban-column-COMPATIBLE-count');
      expect(compat0, 'kanban-column-COMPATIBLE-count = N-1 depois da rejeição de R').toBe(2);

      const funnelAfterReject = (await readFunnelApi(request, token, vacancyId)) as {
        stages?: Record<string, FunnelStageItem[]>;
      };
      const compatAfterReject = funnelAfterReject.stages?.COMPATIBLE ?? [];
      expect(compatAfterReject.length, 'stages.COMPATIBLE.length = N-1 depois da rejeição de R').toBe(2);

      console.log('[6.9] lancamento-idempotente (rejeição)', {
        wjaRId,
        compat0,
        compatAfterReject: compatAfterReject.length,
      });

      // ── Despublicar pela tela — aba Talentum, switch ─────────────────────────────
      await gotoVacancyDetail(page, vacancyId);
      await page.getByTestId('vacancy-tab-talentum').click();
      const talentumCard = page.getByTestId('talentum-card');
      await expect(talentumCard).toBeVisible({ timeout: 15_000 });
      const talentumSwitch = talentumCard.locator('[role="switch"]');
      await expect(talentumSwitch).toHaveAttribute('aria-checked', 'true');

      page.once('dialog', (d) => d.accept());
      const [unpublishResp] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === 'DELETE' && /\/publish-talentum$/.test(r.url())),
        talentumSwitch.click(),
      ]);
      expect(unpublishResp.status(), 'DELETE /publish-talentum (despublicar)').toBe(200);

      // DESVIO DO PASSO: o unpublish (pré-existente, `PublishVacancyToTalentumUseCase.ts:290`)
      // seta `is_draft = true`, e `VacancyDetailPage.tsx:102-104` (Fase 2, pré-existente)
      // redireciona TODA vaga `is_draft = true` para `/borrador` — a página inteira (com o
      // `talentum-card`) some do DOM assim que o `refetch()` do despublicar resolve. Medido:
      // `expect(talentumSwitch).toHaveAttribute('aria-checked','false')` dava "element(s) not
      // found". Não é vermelho do meu passo — é a composição de duas regras pré-existentes que
      // o texto do P15 não previu juntas. Por isso confirmo pela URL do redirect + `is_draft` via
      // SQL, e a republicação usa a MESMA tela do 1º lançamento (`/talentum`, TalentumConfigPage —
      // só checa ABAC, nunca `is_draft`, `TalentumConfigPage.tsx:116`) em vez do switch, que não
      // está mais montado.
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/borrador$`), { timeout: 10_000 });

      const isDraftAfterUnpublish = readIsDraft(vacancyId);
      expect(isDraftAfterUnpublish, 'is_draft = t depois do despublicar').toBe('t');

      const statusAfterUnpublish = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(
        statusAfterUnpublish,
        'paciente continua SEARCHING depois do despublicar (o gancho não roda no unpublish)',
      ).toBe('SEARCHING');

      const trailAfterUnpublish = countLaunchTrail(patient.patientId);
      expect(trailAfterUnpublish, 'trilha vacancy_launch continua 1 depois do despublicar').toBe(1);

      const deleteCallsToStub = stub.calls.filter(
        (c) => c.method === 'DELETE' && /^\/projects\/stub-proj-\d+$/.test(c.path),
      ).length;
      expect(deleteCallsToStub, 'stub.calls tem o DELETE (o backend encaminhou o despublicar à Talentum)').toBe(1);

      console.log('[6.9] lancamento-idempotente (despublicar)', {
        unpublishStatus: unpublishResp.status(),
        isDraftAfterUnpublish,
        statusAfterUnpublish,
        trailAfterUnpublish,
        deleteCallsToStub,
      });

      // ── Publicar de novo — mesma tela de publish do 1º lançamento (DESVIO acima: o switch
      // da VacancyDetailPage não sobrevive ao despublicar) ─────────────────────────────
      const republishStatus = await publishOnTalentumPage(page, vacancyId);
      expect(republishStatus, 'POST /publish-talentum (republicação)').toBe(200);
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`), { timeout: 15_000 });

      // Bônus: com is_draft=false de novo, a VacancyDetailPage não redireciona — o switch da
      // aba Talentum reflete ON (prova de que o publish, mesmo pela outra tela, é o mesmo
      // mecanismo que o switch aciona).
      await page.getByTestId('vacancy-tab-talentum').click();
      const talentumCardAfterRepublish = page.getByTestId('talentum-card');
      await expect(talentumCardAfterRepublish).toBeVisible({ timeout: 15_000 });
      await expect(talentumCardAfterRepublish.locator('[role="switch"]')).toHaveAttribute(
        'aria-checked',
        'true',
        { timeout: 10_000 },
      );

      const trailAfterRepublish = countLaunchTrail(patient.patientId);
      expect(
        trailAfterRepublish,
        'trilha vacancy_launch continua 1 depois de republicar (paciente já fora do funil → unchanged)',
      ).toBe(1);

      const funnelAfterRepublish = (await readFunnelApi(request, token, vacancyId)) as {
        stages?: Record<string, FunnelStageItem[]>;
      };
      const compatAfterRepublish = funnelAfterRepublish.stages?.COMPATIBLE ?? [];
      expect(
        compatAfterRepublish.length,
        'stages.COMPATIBLE.length continua = compat0 depois de republicar (o upsert não ressuscita)',
      ).toBe(compat0);
      expect(
        compatAfterRepublish.some((it) => it.workerId === workerR),
        'R NÃO voltou a Compatíveis depois de republicar',
      ).toBe(false);

      const wjaRAfter = getWjaByWorkerAndJob(workerR, vacancyId);
      expect(
        wjaRAfter?.funnelStage,
        'R continua REJECTED depois de republicar (F53: o upsert do match não sobrescreve estágio)',
      ).toBe('REJECTED');

      await gotoVacancyDetail(page, vacancyId);
      await switchToKanban(page, vacancyId);
      const compatOnScreenAfterRepublish = await readStageCount(page, 'kanban-column-COMPATIBLE-count');
      expect(
        compatOnScreenAfterRepublish,
        'kanban-column-COMPATIBLE-count = compat0 depois de republicar (recarregada)',
      ).toBe(compat0);
      await expect(
        page.locator(`[data-testid="kanban-column-REJECTED"] [data-testid="kanban-card-${wjaRId}"]`),
        'R continua em Rejeitados (recarregada)',
      ).toBeVisible({ timeout: 10_000 });

      const createCallsToStub = stub.calls.filter(
        (c) => c.method === 'POST' && c.path === '/projects',
      ).length;
      expect(createCallsToStub, 'stub.calls com 2 POST /projects (1º lançamento + republicação)').toBe(2);
      const totalDeleteCallsToStub = stub.calls.filter((c) => c.method === 'DELETE').length;
      expect(totalDeleteCallsToStub, 'stub.calls com 1 DELETE (só o despublicar)').toBe(1);

      console.log('[6.9] lancamento-idempotente (republicar)', {
        republishStatus,
        trailAfterRepublish,
        compatAfterRepublish: compatAfterRepublish.length,
        wjaRAfterStage: wjaRAfter?.funnelStage,
        compatOnScreenAfterRepublish,
        createCallsToStub,
        totalDeleteCallsToStub,
        stubCalls: stub.calls,
      });
    } finally {
      await stub.close();
      patient.cleanup();
      cleanupTestWorker(workerR);
      cleanupTestWorker(workerC1);
      cleanupTestWorker(workerC2);
    }
  });
});
