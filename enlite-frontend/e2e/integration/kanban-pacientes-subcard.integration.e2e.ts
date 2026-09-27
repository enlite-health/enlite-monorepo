/**
 * kanban-pacientes-subcard.integration.e2e.ts @integration
 *
 * E2E de TELA do subcard do Kanban de pacientes (Fase 8, change
 * cadeia-paciente-vacante-itinerario). Frontend real + backend real (Docker) +
 * Postgres real — mesma estratégia de auth dos irmãos de lançamento (`loginAs`,
 * `abac-stack-helper.ts`, click + `keyboard.type`; nunca `fill()`).
 *
 * O caminho do arquivo contém `kanban-pacientes` — é assim que ele entra no
 * `--grep` do job padrão do CI (`.github/workflows/pr-gate.yml:142`), sem nenhuma
 * mudança de workflow (P17).
 *
 * P15 escreve os 3 primeiros títulos (DX-8.12, DX-8.17 (ii)):
 *   kanban-paciente-subcard              — critérios 1 e 8 (o feliz + a queda pra 0)
 *   kanban-paciente-subcard-sem-vacante  — critério 2 (foguete navega pra ficha)
 *   kanban-paciente-subcard-com-vacante  — critério 3 (ícone leva à vaga)
 * P16 acrescenta os 2 restantes (card único, sem N+1/sem clínico) no MESMO arquivo.
 *
 * Reusa sem copiar: `seedLaunchablePatient`/`LANCAMENTO_VIEWPORT_ES_AR`/
 * `mockAdminUserFor`/`useLancamentoStaff` (lancamento-e2e-helper.ts),
 * `activateRecruitmentViaApi`/`readItineraryApi`/`seedAssignment`/`cleanupItinerary`
 * (itinerario-e2e-helper.ts), `insertTestWorker`/`cleanupTestWorker`
 * (db-test-helper.ts), `insertWJA`/`cleanupWJAAndEncuadre` (wja-test-helper.ts),
 * `openPatientKanban`/`readSubcardPair`/`pairFromItinerary` (kanban-subcard-e2e-helper.ts,
 * novo neste passo). Cada teste semeia e limpa a própria semente — sem
 * `describe.serial` (um vermelho no 1º não pode derrubar os irmãos do arquivo no CI).
 */
import { test, expect } from '@playwright/test';
import { loginAs } from '../helpers/abac-stack-helper';
import {
  LANCAMENTO_VIEWPORT_ES_AR,
  mockAdminUserFor,
  useLancamentoStaff,
  seedLaunchablePatient,
} from '../helpers/lancamento-e2e-helper';
import {
  activateRecruitmentViaApi,
  readItineraryApi,
  seedAssignment,
  cleanupItinerary,
} from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { openPatientKanban, readSubcardPair, pairFromItinerary } from '../helpers/kanban-subcard-e2e-helper';

const MOCK_ADMIN_USER = mockAdminUserFor('subcard');

test.describe('kanban de pacientes — subcard (fase 8) @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  test.setTimeout(120_000);
  useLancamentoStaff(MOCK_ADMIN_USER, 'E2E Kanban Subcard Fase 8');

  // ── critérios 1 e 8: o par lido do DOM == o par do itinerário, antes e depois
  //    da alocação; a queda pra 0/20 sem alocação (DX-8.17) ────────────────────
  test('kanban-paciente-subcard', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -53.74, lng: -67.74 });
    const { patientId, serviceId } = seed;
    const vacancyId = await activateRecruitmentViaApi(request, patientId, serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    const applicationId = insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'INVITED' });

    try {
      await loginAs(page, MOCK_ADMIN_USER);

      // Antes da alocação: o subcard mostra 0/20, e o DOM bate com o itinerário
      // NA MESMA execução (nunca uma constante).
      await openPatientKanban(page);
      const domAntes = await readSubcardPair(page, serviceId);
      const itinAntes = await readItineraryApi(request, patientId);
      if (itinAntes.status !== 200 || !itinAntes.body.data) {
        throw new Error(`readItineraryApi (antes) falhou: ${itinAntes.status} ${JSON.stringify(itinAntes.body)}`);
      }
      const apiAntes = pairFromItinerary(itinAntes.body.data, serviceId);
      expect(domAntes).toBe('0/20');
      expect(domAntes).toBe(apiAntes);

      const svcAntes = itinAntes.body.data.services.find((s) => s.contractedServiceId === serviceId);
      const slotId = svcAntes?.slots[0]?.id;
      if (!slotId) {
        throw new Error(`kanban-paciente-subcard: slot do serviço não encontrado ao montar a semente: ${JSON.stringify(svcAntes)}`);
      }

      // A alocação vigente (7 dias atrás, sem fim) — a faixa seg 08:00-12:00 da
      // semente (`seedLaunchablePatient`) dá 4h cobertas.
      seedAssignment({ slotId, workerId, applicationId, validFromDaysAgo: 7, status: 'ACTIVE' });

      await page.reload();
      await openPatientKanban(page);
      const domDepois = await readSubcardPair(page, serviceId);
      const itinDepois = await readItineraryApi(request, patientId);
      if (itinDepois.status !== 200 || !itinDepois.body.data) {
        throw new Error(`readItineraryApi (depois) falhou: ${itinDepois.status} ${JSON.stringify(itinDepois.body)}`);
      }
      const apiDepois = pairFromItinerary(itinDepois.body.data, serviceId);
      expect(domDepois).toBe('4/20');
      expect(domDepois).toBe(apiDepois);
      expect(itinDepois.body.data.services[0].cobertas).toBe(4);

      // eslint-disable-next-line no-console
      console.log('[8.1]', 'DOM antes', domAntes, 'API antes', apiAntes, 'DOM depois', domDepois, 'API depois', apiDepois);

      const card = page.getByTestId(`patient-kanban-card-${patientId}`);
      await card.scrollIntoViewIfNeeded();
      // Testes visuais obrigatórios (CLAUDE.md do monorepo) — baseline darwin,
      // gerada por `--update-snapshots` só deste título; o CI roda `--ignore-snapshots`.
      // Mascara título (nome, muda por execução) e o chip de caso (número muda por execução).
      await expect(card).toHaveScreenshot('kanban-paciente-subcard-card.png', {
        mask: [card.getByTestId(`patient-kanban-card-${patientId}-open`), card.locator('span', { hasText: /^Caso #/ })],
        maxDiffPixelRatio: 0.05,
      });
    } finally {
      cleanupItinerary(patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  // ── critério 2: sem vaga viva, o foguete navega pra ficha (nunca dispara
  //    activate-recruitment — invariante 3, DX-8.8) ───────────────────────────
  test('kanban-paciente-subcard-sem-vacante', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -53.75, lng: -67.75 });
    const { patientId, serviceId } = seed;

    try {
      await loginAs(page, MOCK_ADMIN_USER);
      await openPatientKanban(page);

      const subcard = page.locator(`[data-testid="patient-kanban-subcard"][data-service-id="${serviceId}"]`);
      await subcard.scrollIntoViewIfNeeded();
      const rocket = subcard.getByTestId('patient-kanban-subcard-rocket');
      const vacancyLink = subcard.getByTestId('patient-kanban-subcard-vacancy');
      await expect(rocket).toBeVisible();
      await expect(vacancyLink).toHaveCount(0);

      // Clique real do locator — nunca `fill()`.
      await rocket.click();
      await expect(page).toHaveURL(new RegExp(`/admin/patients/${patientId}$`));
    } finally {
      seed.cleanup();
    }
  });

  // ── critério 3: com vaga viva, o ícone leva à vaga (rascunho → redireciona a
  //    /borrador, aprendizado da Fase 6; a asserção aceita o sufixo, o id tem de bater) ──
  test('kanban-paciente-subcard-com-vacante', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -53.76, lng: -67.76 });
    const { patientId, serviceId } = seed;
    const vacancyId = await activateRecruitmentViaApi(request, patientId, serviceId);

    try {
      await loginAs(page, MOCK_ADMIN_USER);
      await openPatientKanban(page);

      const subcard = page.locator(`[data-testid="patient-kanban-subcard"][data-service-id="${serviceId}"]`);
      await subcard.scrollIntoViewIfNeeded();
      const vacancyLink = subcard.getByTestId('patient-kanban-subcard-vacancy');
      const rocket = subcard.getByTestId('patient-kanban-subcard-rocket');
      await expect(vacancyLink).toBeVisible();
      await expect(rocket).toHaveCount(0);

      const href = await vacancyLink.getAttribute('href');
      expect(href).toBe(`/admin/vacancies/${vacancyId}`);

      await vacancyLink.click();
      await page.waitForURL(new RegExp(`/admin/vacancies/${vacancyId}(/|$)`));
      const finalUrl = page.url();
      // eslint-disable-next-line no-console
      console.log('[8.1]', 'com-vacante URL final', finalUrl);
      expect(finalUrl).toMatch(new RegExp(`/admin/vacancies/${vacancyId}(/|$)`));
    } finally {
      cleanupItinerary(patientId);
      seed.cleanup();
    }
  });
});
