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
import type { SeedLaunchablePatientResult } from '../helpers/lancamento-e2e-helper';
import {
  activateRecruitmentViaApi,
  createServiceViaApi,
  readItineraryApi,
  seedAssignment,
  cleanupItinerary,
} from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { openPatientKanban, readSubcardPair, pairFromItinerary } from '../helpers/kanban-subcard-e2e-helper';
import { collectDataRequests } from '../helpers/kanban-subcard-e2e-helper';

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
      console.log('[8.1]', 'com-vacante URL final', finalUrl);
      expect(finalUrl).toMatch(new RegExp(`/admin/vacancies/${vacancyId}(/|$)`));
    } finally {
      cleanupItinerary(patientId);
      seed.cleanup();
    }
  });

  // ── critério 4: um card por paciente, mesmo com 2 serviços — 2 subcards no
  //    MESMO card, nenhum duplicado em outro card/coluna (DX-8.11) ────────────
  test('kanban-paciente-card-unico', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -53.77, lng: -67.77 });
    const { patientId, serviceId: serviceId1, addressId } = seed;
    const serviceId2 = await createServiceViaApi(request, patientId, { addressId });

    try {
      await loginAs(page, MOCK_ADMIN_USER);
      await openPatientKanban(page);

      // O `getByTestId` casa o valor EXATO: `-open`/`-contact` etc. não entram.
      const card = page.getByTestId(`patient-kanban-card-${patientId}`);
      await expect(card).toHaveCount(1);
      await card.scrollIntoViewIfNeeded();

      const subcardsNoCard = card.getByTestId('patient-kanban-subcard');
      await expect(subcardsNoCard).toHaveCount(2);

      for (const sid of [serviceId1, serviceId2]) {
        await expect(
          page.locator(`[data-testid="patient-kanban-subcard"][data-service-id="${sid}"]`),
        ).toHaveCount(1);
      }

      console.log('[8.4]', 'cards', await card.count(), 'subcards', await subcardsNoCard.count());
    } finally {
      cleanupItinerary(patientId);
      seed.cleanup();
    }
  });

  // ── critérios 5 e 6: sem N+1 (1 listagem + 1 agregado por carga do board,
  //    mesmo com 20 pacientes) e nada de clínico no agregado (DX-8.13, DX-8.14) ──
  test('kanban-paciente-sem-n-mais-1', async ({ page, request }) => {
    test.setTimeout(180_000);
    const seeds: SeedLaunchablePatientResult[] = [];
    for (let i = 0; i < 20; i++) {
      seeds.push(await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -54.0 - i * 0.001, lng: -67.9 }));
    }

    try {
      await loginAs(page, MOCK_ADMIN_USER);

      // Registrado ANTES do `goto` do board (DX-8.14).
      const reqs = collectDataRequests(page);
      const listWaiter = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/patients\?/.test(r.url()));
      const aggWaiter = page.waitForResponse((r) => r.request().method() === 'GET' && /\/api\/admin\/patients\/kanban\/services/.test(r.url()));

      await openPatientKanban(page);
      const [listResponse, aggResponse] = await Promise.all([listWaiter, aggWaiter]);

      // Só mede depois que os 20 subcards estão visíveis (valida com 20 cards de
      // serviço na tela — o board não pagina).
      for (const s of seeds) {
        await expect(
          page.locator(`[data-testid="patient-kanban-subcard"][data-service-id="${s.serviceId}"]`),
        ).toHaveCount(1);
      }

      const all = reqs();
      console.log('[8.6]', all);
      const listCount = all.filter((r) => r === 'GET /api/admin/patients').length;
      const aggCount = all.filter((r) => r === 'GET /api/admin/patients/kanban/services').length;
      const byIdCount = all.filter((r) => /^GET \/api\/admin\/patients\/[0-9a-f-]{36}$/.test(r)).length;
      expect(listCount).toBe(1);
      expect(aggCount).toBe(1);
      expect(byIdCount).toBe(0);
      expect(all.length).toBeLessThanOrEqual(2);

      const aggBody = await aggResponse.json();
      const aggText = JSON.stringify(aggBody);
      const aggClinicalHits = (aggText.match(/diagnos|clinic/gi) ?? []).length;
      const aggServiceCodeHits = (aggText.match(/serviceCode/g) ?? []).length;
      console.log('[8.5] agregado', aggClinicalHits, aggServiceCodeHits);
      expect(aggClinicalHits).toBe(0);
      expect(aggServiceCodeHits).toBeGreaterThan(0);

      const listBody = await listResponse.json();
      const listText = JSON.stringify(listBody);
      const listClinicalHits = (listText.match(/diagnos|clinic/gi) ?? []).length;
      const listCaseNumberHits = (listText.match(/caseNumber/g) ?? []).length;
      console.log('[8.5] listagem', listClinicalHits, 'caseNumber', listCaseNumberHits);
      // Sem asserção que reprove pelo clínico da listagem (dado pré-existente,
      // fora do escopo da fase — Q-8.1); só o controle de que a leitura funciona.
      expect(listCaseNumberHits).toBeGreaterThan(0);
    } finally {
      for (const s of seeds) {
        cleanupItinerary(s.patientId);
        s.cleanup();
      }
    }
  });
});
