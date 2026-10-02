/**
 * funil-vacante-lancamento-recusa.integration.e2e.ts @integration
 *
 * P14 (Fase 6, cadeia-paciente-vacante-itinerario) — 1 teste, critério 7:
 *
 * `lancamento-talentum-recusa-nao-move`:
 *   7. quando a Talentum RECUSA o `POST /pre-screening/projects` (502, `stub.mode = 'reject'`),
 *      o publish falha ANTES do commit (`PublishVacancyToTalentumUseCase.ts:159-179` roda antes
 *      da UPDATE de `:195-207` e do gancho pós-commit `:235-240`) — a vaga continua rascunho
 *      (`is_draft = true`, `talentum_project_id` nulo), o paciente continua `ADMISSION`, a
 *      trilha `vacancy_launch` fica em 0. A tela mostra o
 *      erro (`publishError`, `TalentumConfigPage.tsx:134-138`) sem sair de `/talentum`. Controle:
 *      `stub.calls` tem o `POST /pre-screening/projects` — o backend TENTOU e o stub recusou (a
 *      recusa é do stub, no mesmo processo do teste, nunca de rede).
 *
 *   Alternativo, no MESMO teste: `stub.mode = 'accept'` e publicar de novo — mesmo botão, mesma
 *      tela, sem reload — → 200 → `SEARCHING`, trilha 1 (a recusa não deixa
 *      estado que impeça o lançamento seguinte).
 *
 * Compatíveis (`stages.COMPATIBLE`) é da Fase 4, fora da rota (b) (D455): a asserção sai daqui e
 * volta na rota (a).
 *
 * Único mock de navegador: `/generate-ai-content` (Gemini custaria) — instalado DEPOIS do login
 * (mesma ordem do P12/P13: `swapToken` do `loginAs` vence rotas registradas antes dele).
 * `publish-talentum` NUNCA é mockado por `page.route`: a recusa vem do backend, que vai ao stub
 * da Talentum (porta 9914, `startTalentumStub`, `stub.mode = 'reject'`).
 *
 * Helpers: `lancamento-e2e-helper.ts` (P4), `funnel-move-e2e-helper.ts` (P12),
 * `lancamento-leituras-helper.ts` (`readPatientStatusApi`), `patient-detail-a-helper.ts` (`runSQL`),
 * `abac-stack-helper.ts`/`vacancy-notes-e2e-helper.ts` (staff mock).
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
} from '../helpers/lancamento-e2e-helper';
import { readPatientStatusApi, countSystemInvitedApplications } from '../helpers/lancamento-leituras-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { cleanupTestWorker } from '../helpers/db-test-helper';

const MOCK_ADMIN_USER = mockAdminUserFor('recusa');

/** `is_draft`/`talentum_project_id` da vaga — prova de que a recusa não gravou nada (critério 7). */
function readDraftState(vacancyId: string): { isDraft: string; talentumProjectId: string | null } {
  const out = runSQL(
    `SELECT is_draft, COALESCE(talentum_project_id, '') FROM job_postings WHERE id = '${vacancyId}'`,
  );
  const [isDraft, talentumProjectId] = out.split('|');
  return { isDraft, talentumProjectId: talentumProjectId || null };
}

test.describe('funil-vacante lancamento recusa @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  test.setTimeout(120_000);

  useLancamentoStaff(MOCK_ADMIN_USER, 'E2E Lancamento Recusa F6');

  test('lancamento-talentum-recusa-nao-move', async ({ page, request }) => {
    // Coordenada própria do arquivo (DX-6.9) — a mesma que o texto do passo dá.
    const LAT = -50.338;
    const LNG = -72.2648;

    const token = tokenFor(MOCK_ADMIN_USER);
    const stub = await startTalentumStub();
    stub.mode = 'reject';

    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });
    const [w] = seedWorkersNear(LAT, LNG, 1);

    try {
      // DEPOIS do login — mesma ordem e mesmo motivo do P12/P13 (`swapToken` resolve antes de
      // qualquer rota registrada mais cedo; instalar antes do login mandaria `/generate-ai-content`
      // para a API real). `loginAndMockAi` (helper, G2) encapsula essa ordem.
      await loginAndMockAi(page, MOCK_ADMIN_USER);

      // (1) Foguete pela ficha.
      const vacancyId = await clickFoguete(page, patient.patientId, patient.serviceId);

      // (2) Borrador → wizard (profissão AT, salário, meet) → /talentum.
      await completeDraftViaWizard(page, vacancyId);

      // ── Critério 7: a Talentum recusa (502) — a tela mostra o erro, sem sair de /talentum ──
      const publishStatus = await publishOnTalentumPage(page, vacancyId);
      expect(publishStatus, 'POST /publish-talentum com stub.mode=reject').toBe(502);

      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}/talentum$`), { timeout: 10_000 });

      const errorText = page.locator('span.text-red-600.text-right');
      await expect(errorText).toBeVisible({ timeout: 10_000 });
      const errorMessage = (await errorText.textContent())?.trim() ?? '';
      expect(errorMessage.length, 'publishError visível e não vazio').toBeGreaterThan(0);

      const draftState = readDraftState(vacancyId);
      expect(draftState.isDraft, 'is_draft continua true depois da recusa').toBe('t');
      expect(draftState.talentumProjectId, 'talentum_project_id continua nulo depois da recusa').toBeNull();

      const statusAfterReject = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusAfterReject, 'paciente continua ADMISSION depois da recusa').toBe('ADMISSION');

      const trailAfterReject = countLaunchTrail(patient.patientId);
      expect(trailAfterReject, 'trilha vacancy_launch continua 0 depois da recusa').toBe(0);

      const createCallsAfterReject = stub.calls.filter(
        (c) => c.method === 'POST' && c.path === '/pre-screening/projects',
      ).length;
      expect(
        createCallsAfterReject,
        'controle: stub.calls tem o POST /pre-screening/projects — o backend TENTOU e o stub recusou',
      ).toBeGreaterThanOrEqual(1);

      console.log('[6.7] lancamento-talentum-recusa-nao-move (recusa)', {
        vacancyId,
        patientId: patient.patientId,
        publishStatus,
        errorMessage,
        draftState,
        statusAfterReject,
        trailAfterReject,
        createCallsAfterReject,
      });

      // ── Alternativo: a recusa não deixa estado que impeça o lançamento seguinte ─────
      stub.mode = 'accept';

      const publishBtn = page.getByRole('button', { name: /Publicar en Talentum/i });
      await expect(publishBtn).toBeVisible({ timeout: 10_000 });
      const secondPublish = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/publish-talentum$/.test(r.url()),
        { timeout: 30_000 },
      );
      await publishBtn.click();
      const secondRes = await secondPublish;
      expect(secondRes.status(), 'POST /publish-talentum com stub.mode=accept (2º clique, mesma tela)').toBe(200);
      await expect(page).toHaveURL(new RegExp(`/admin/vacancies/${vacancyId}$`), { timeout: 15_000 });

      const statusAfterAccept = await readPatientStatusApi(request, backendUrl(), token, patient.patientId);
      expect(statusAfterAccept, 'paciente SEARCHING depois do lançamento aceito').toBe('SEARCHING');

      const trailAfterAccept = countLaunchTrail(patient.patientId);
      expect(trailAfterAccept, 'trilha vacancy_launch = 1 depois do lançamento aceito').toBe(1);

      // D466: nesta rota o lançamento só move o paciente — o match NÃO roda, então a vaga não
      // ganha nenhuma linha INVITED/system (o convite automático pularia quem já tem linha).
      // `w` foi semeado perto da coordenada: com o match religado ele seria gravado aqui.
      const systemInvitedAfterAccept = countSystemInvitedApplications(vacancyId);
      expect(systemInvitedAfterAccept, 'vaga tem 0 linhas INVITED/system depois do lançamento aceito').toBe(0);

      console.log('[6.7] lancamento-talentum-recusa-nao-move (alternativo aceito)', {
        vacancyId,
        patientId: patient.patientId,
        workerId: w,
        secondPublishStatus: secondRes.status(),
        statusAfterAccept,
        trailAfterAccept,
        systemInvitedAfterAccept,
      });
    } finally {
      await stub.close();
      patient.cleanup();
      cleanupTestWorker(w);
    }
  });
});
