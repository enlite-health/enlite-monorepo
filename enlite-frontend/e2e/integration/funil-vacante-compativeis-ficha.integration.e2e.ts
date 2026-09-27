/**
 * funil-vacante-compativeis-ficha.integration.e2e.ts @integration
 *
 * Integration E2E — Fase 5 (change cadeia-paciente-vacante-itinerario, G4 — fecho do
 * gate `revisao-pr`, BLOCKER-1 do `veredito-fecho.md`): a ficha do prestador (aba
 * Encuadres) precisa mostrar o MESMO `deriveKanbanColumn(stage, source, messaged_at)`
 * que o Kanban/lista da vaga já mostram (DX-5.2, `execucao/fase-5.md:82-93`: "as duas
 * superfícies must agree"). Até este arquivo, a "Consequência visível na stage" (candidato
 * do match passa de 'Invitados' para 'Compatibles' na ficha) só tinha unit
 * (`WorkerApplicationRepository.engagements.test.ts`, pool mockado) e um e2e MOCKADO
 * (`worker-detail-blocked-encuadre.e2e.ts`, projeto `chromium-admin`, dado inteiro via
 * `page.route`) — nenhum caso sem mock, contra backend + Postgres reais.
 *
 * Dado real: `WorkerApplicationRepository.listEngagementsByWorker` (`WF/infrastructure/
 * WorkerApplicationRepository.ts:224-270`) faz `SELECT wja.messaged_at` e passa como 3º
 * argumento a `deriveKanbanColumn`; `AdminWorkersDetailBuilder.ts` expõe isso em
 * `data.encuadres[].kanbanStage` (`GET /api/admin/workers/:id`); o frontend
 * (`WorkerEncuadresCard.tsx:79-83`) renderiza `t('admin.kanban.columns.<kanbanStage>')` —
 * "Compatibles" para COMPATIBLE, "Invitados" para INVITED (`es.json` namespace `kanban.columns`).
 *
 * 3 testes independentes, sem `serial` (molde `funil-vacante-compativeis.integration.e2e.ts`,
 * P17) — cada um semeia e limpa o seu:
 *   funil-compativeis-ficha-chip     — feliz: candidato do match (INVITED/system, sem
 *                                      `messaged_at`) → chip "Compatibles" na ficha + a
 *                                      API (`GET /api/admin/workers/:id`) devolve
 *                                      `kanbanStage: 'COMPATIBLE'` para essa vaga.
 *   funil-compativeis-ficha-invitado — alternativo: o MESMO tipo de worker, mas com
 *                                      `messaged_at` carimbado (convite já enviado) →
 *                                      chip "Invitados", nunca "Compatibles"
 *                                      (`isMatchedNotInvited` exige `messaged_at` nulo).
 *   funil-compativeis-ficha-sem-vaga — alternativo: worker sem nenhuma candidatura →
 *                                      estado vazio da aba (nenhum chip, nenhuma linha).
 *
 * Reusa sem copiar: `seedVacancyWithCards` (`funnel-move-e2e-helper.ts`, vaga sem cards
 * quando chamado com `[]`), `seedCompatibleCard`/`cleanupCompatibleCard`
 * (`compativeis-e2e-helper.ts`, P16), `insertTestWorker`/`cleanupTestWorker`
 * (`db-test-helper.ts`), `seedMockStaff`/`cleanupMockStaff` (`vacancy-notes-e2e-helper.ts`),
 * `loginAs` (`abac-stack-helper.ts`), `runSQL` (`patient-detail-a-helper.ts`). Nenhuma
 * função nova no helper — a navegação da ficha (diferente da vaga) só existe aqui.
 *
 * Nunca `fill()`. Host/porta sempre de `E2E_BACKEND_URL`/`PW_BASE_URL` (nunca literal).
 * `role: 'admin'` sem `grantCell` — `ContainerGate resource="match"` só filtra com o
 * engine ABAC LIGADO (`useCellAccess.ts:93`: `enforcement !== 'on' → visible: true`), e
 * esta stack padrão roda com o engine OFF (a variante ligada é outro stack, `compativeis-
 * sem-celula.integration.e2e.ts`, fora do escopo deste arquivo).
 */

import { test, expect, type Page, type Response as PlaywrightResponse } from '@playwright/test';
import { seedVacancyWithCards } from '../helpers/funnel-move-e2e-helper';
import { seedCompatibleCard, cleanupCompatibleCard } from '../helpers/compativeis-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import { loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';

// ── Constants ─────────────────────────────────────────────────────────────────

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-funil-compativeis-ficha',
  email: 'staff.funil.compativeis.ficha@e2e.test',
  role: 'admin',
  country: 'AR',
};

interface FichaEncuadreRow {
  id: string;
  kanbanStage: string;
}

// ── Navegação da ficha (só existe aqui — diferente de gotoVacancyDetail/switchToKanban) ─

/**
 * Abre `/admin/workers/:id`, espera a resposta de `GET /api/admin/workers/:id` (devolve o
 * `data.encuadres` cru, pra conferir a API sem depender só da tela) e abre a aba
 * "Encuadre" (`WorkerProfileTabs`, molde `worker-detail-blocked-encuadre.e2e.ts:151-153`).
 */
async function gotoWorkerFichaEncuadres(page: Page, workerId: string): Promise<FichaEncuadreRow[]> {
  const workerRe = new RegExp(`/api/admin/workers/${workerId}(\\?|$)`);
  const [response] = await Promise.all([
    page.waitForResponse((r: PlaywrightResponse) => workerRe.test(r.url()) && r.request().method() === 'GET'),
    page.goto(`/admin/workers/${workerId}`),
  ]);
  expect(response.ok(), 'GET /api/admin/workers/:id falhou').toBe(true);
  const body = (await response.json()) as { data?: { encuadres?: FichaEncuadreRow[] } };

  const encuadresTab = page.getByRole('button', { name: 'Encuadre', exact: true });
  await expect(encuadresTab, 'aba "Encuadre" visível').toBeVisible({ timeout: 15_000 });
  await encuadresTab.click();
  await expect(page.getByTestId('worker-encuadres-card'), 'card da aba Encuadres renderizado').toBeVisible({
    timeout: 10_000,
  });

  return body.data?.encuadres ?? [];
}

// ── Tests ──────────────────────────────────────────────────────────────────────

test.describe('ficha do prestador — aba Encuadres reflete o chip Compatibles (G4) @integration', () => {
  test.use({
    viewport: { width: 1366, height: 768 },
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Funil Compatíveis Ficha');
  });

  test.afterAll(() => {
    cleanupMockStaff(MOCK_STAFF);
  });

  // ── Feliz: candidato do match → chip "Compatibles" na ficha + API ────────────
  test('funil-compativeis-ficha-chip', async ({ page }) => {
    const seed = seedVacancyWithCards([]);
    const compat = seedCompatibleCard(seed.vacancyId);

    try {
      await loginAs(page, MOCK_STAFF);
      const encuadres = await gotoWorkerFichaEncuadres(page, compat.workerId);

      const card = page.getByTestId('worker-encuadres-card');
      await expect(card.getByText('Compatibles', { exact: true }), 'chip "Compatibles" na ficha').toBeVisible({
        timeout: 10_000,
      });
      await expect(card.getByText('Invitados', { exact: true }), 'não aparece como "Invitados"').toHaveCount(0);

      const own = encuadres.find((e) => e.id === compat.wjaId);
      console.log('[G4] chip — API kanbanStage=', own?.kanbanStage);
      expect(own?.kanbanStage, 'API GET /workers/:id: encuadres[].kanbanStage do candidato do match').toBe(
        'COMPATIBLE',
      );
    } finally {
      cleanupCompatibleCard(compat.workerId, seed.vacancyId);
      seed.cleanup();
    }
  });

  // ── Alternativo: convite já enviado (messaged_at) → "Invitados", nunca "Compatibles" ──
  test('funil-compativeis-ficha-invitado', async ({ page }) => {
    const seed = seedVacancyWithCards([]);
    const compat = seedCompatibleCard(seed.vacancyId);
    // Mesma origem do candidato do match (INVITED/system), mas já mensageado — sai de
    // "Compatibles" e passa a contar como "Invitados" (isMatchedNotInvited exige
    // messaged_at NULO; molde da UPDATE em `funnel-move-e2e-helper.ts:112-114`).
    runSQL(`UPDATE worker_job_applications SET messaged_at = NOW() WHERE id = '${compat.wjaId}'`);

    try {
      await loginAs(page, MOCK_STAFF);
      const encuadres = await gotoWorkerFichaEncuadres(page, compat.workerId);

      const card = page.getByTestId('worker-encuadres-card');
      await expect(card.getByText('Invitados', { exact: true }), 'chip "Invitados" (já mensageado)').toBeVisible({
        timeout: 10_000,
      });
      await expect(card.getByText('Compatibles', { exact: true }), 'não é mais "Compatibles"').toHaveCount(0);

      const own = encuadres.find((e) => e.id === compat.wjaId);
      console.log('[G4] invitado — API kanbanStage=', own?.kanbanStage);
      expect(own?.kanbanStage, 'API GET /workers/:id: encuadres[].kanbanStage após envio').toBe('INVITED');
    } finally {
      cleanupCompatibleCard(compat.workerId, seed.vacancyId);
      seed.cleanup();
    }
  });

  // ── Alternativo: worker sem candidatura → estado vazio da aba, nenhum chip ──────
  test('funil-compativeis-ficha-sem-vaga', async ({ page }) => {
    const workerId = insertTestWorker({
      firstName: 'CompativeisFichaSemVaga',
      lastName: `Seed-${Date.now()}`,
    });

    try {
      await loginAs(page, MOCK_STAFF);
      const encuadres = await gotoWorkerFichaEncuadres(page, workerId);

      const card = page.getByTestId('worker-encuadres-card');
      await expect(card.getByText('Compatibles', { exact: true }), 'sem chip "Compatibles"').toHaveCount(0);
      await expect(card.getByText('Invitados', { exact: true }), 'sem chip "Invitados"').toHaveCount(0);
      await expect(card, 'estado vazio da aba (i18n admin.workerDetail.noEncuadres)').toContainText(
        'Sin encuadres registrados',
      );

      console.log('[G4] sem-vaga — API encuadres.length=', encuadres.length);
      expect(encuadres.length, 'API GET /workers/:id: encuadres vazio').toBe(0);
    } finally {
      cleanupTestWorker(workerId);
    }
  });
});
