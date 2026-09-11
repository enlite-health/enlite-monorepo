/**
 * worker-home-progress-cta.integration.e2e.ts @integration
 *
 * CAMADA 0 — bug #1 original: o CTA do card de progresso na home gerava uma
 * rota morta (`useWorkerProfileProgress.ts`, versão antiga). Fase 2 de
 * postulacao-documento-pendente (DD1/DD2) substituiu o card inteiro:
 * `ProfileCompletionCard` (uma barra + 1 CTA pro PRIMEIRO pendente) virou
 * `PendingTasksCard` (uma linha por pendência — `missingFields` do
 * servidor, Fase 1 — cada uma com seu próprio botão e destino). Os 3
 * cenários abaixo são os do "Termina quando" de `fase-2.md`.
 *
 * Prova de fluxo REAL: frontend real + backend real (USE_MOCK_AUTH=true) +
 * Postgres real. O worker é semeado no banco (fn_worker_missing_fields decide
 * a completude — SSOT), login via helper pass-through, e o clique navega de
 * verdade (sem page.route de dado).
 *
 * Pré-condições: docker (postgres + api desta worktree) + pnpm dev.
 * Run: PW_BASE_URL=<url> E2E_PG_CONTAINER=<container> pnpm test:e2e:integration
 *      --grep "worker-home-progress-cta"
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.use({ video: 'on' }); // definição de pronto exige vídeo do fluxo real

test.describe('@integration Home — lista de tarefas (Fase 2, DD2)', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  async function loginAndGoHome(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
  }

  test('feliz — AT só sem antecedentes: "Te falta 1 paso" + linha "Antecedentes penales" + botão leva ao slot destacado', async ({ page }) => {
    const w = insertEligibilityWorker({
      occupation: 'AT',
      docCriminalRecord: false,
    });
    await loginAndGoHome(page, w);

    const card = page.locator('[data-testid="pending-tasks-card"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('Te falta 1 paso para postularte')).toBeVisible();
    await expect(card.getByText('Antecedentes penales')).toBeVisible();

    const cta = card.getByRole('button', { name: /Subir ahora — Antecedentes penales/i });
    await expect(cta).toBeVisible();
    await cta.click();

    await expect(page).toHaveURL(/\/worker\/profile\?tab=documents&focus=criminal_record/, {
      timeout: 15_000,
    });

    const slot = page.locator('[data-testid="doc-slot-criminal_record"]');
    await expect(slot).toBeVisible({ timeout: 15_000 });
    // Highlight transitório aplicado pelo WorkerProfilePage ao alvo do focus.
    await expect(slot).toHaveClass(/ring-2/, { timeout: 5_000 });

    await expect(slot).toHaveScreenshot('home-cta-doc-slot-highlighted.png', { maxDiffPixels: 200 });
  });

  test('alt — dado geral e documento pendentes juntos: os dois grupos aparecem, registro ANTES de documento (ordem DD2)', async ({ page }) => {
    const w = insertEligibilityWorker({
      occupation: 'CAREGIVER',
      phone: false,
      docIdentityDocument: false,
    });
    await loginAndGoHome(page, w);

    const card = page.locator('[data-testid="pending-tasks-card"]');
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByText('Te faltan 2 pasos para postularte')).toBeVisible();

    const registrationRow = card.getByText('Información General');
    const documentRow = card.getByText('Documento de identidad');
    await expect(registrationRow).toBeVisible();
    await expect(documentRow).toBeVisible();

    // Ordem no DOM: registro antes de documento (DD2).
    const rowsOrder = await card.locator('[data-testid="pending-tasks-rows"] > div').allTextContents();
    const generalIdx = rowsOrder.findIndex((t) => t.includes('Información General'));
    const docIdx = rowsOrder.findIndex((t) => t.includes('Documento de identidad'));
    expect(generalIdx).toBeGreaterThanOrEqual(0);
    expect(docIdx).toBeGreaterThan(generalIdx);

    await expect(card.locator('[data-testid="pending-tasks-rows"]')).toHaveScreenshot(
      'home-pending-tasks-two-groups.png',
      { maxDiffPixels: 200 },
    );

    // O botão de registro leva à aba (sem focus — o `incompleteFieldDestinations`
    // decide, sem segundo mapa token→destino, DD2).
    const registrationCta = card.getByRole('button', { name: /Completar — Información General/i });
    await registrationCta.click();
    await expect(page).toHaveURL(/\/worker\/profile\?tab=general$/, { timeout: 15_000 });
  });

  test('cadastro + documentos completos: a lista de tarefas não aparece', async ({ page }) => {
    const w = insertEligibilityWorker({ occupation: 'CAREGIVER' }); // todos os campos/docs default=true
    await loginAndGoHome(page, w);

    const jobsSection = page.locator('[data-testid="jobs-section"], #jobs-section');
    await expect(jobsSection).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="pending-tasks-card"]')).toHaveCount(0);
    // Prova visual de que NADA (nenhuma lista de tarefas) renderiza acima da
    // seção de vagas quando o cadastro está completo.
    //
    // Achado do gate (11/09): screenshotar `#jobs-section` inteira incluía a
    // lista de VAGAS de verdade (dado externo, não-determinístico — a
    // baseline tinha congelado "0 vacantes", quebrando sempre que houvesse
    // vaga real). O que este teste precisa provar é só a área ESTÁVEL —
    // cabeçalho + filtros + ausência do card de tarefas acima — então a
    // lista de vagas em si (`jobs-list`) é mascarada, não removida do
    // screenshot: ela continua visível pra quem revisar, só não entra na
    // comparação de pixels.
    await expect(jobsSection).toHaveScreenshot('home-no-progress-card-jobs-section.png', {
      maxDiffPixels: 300,
      mask: [page.getByTestId('jobs-list')],
    });
  });
});
