/**
 * home-postularse-incomplete.integration.e2e.ts @integration
 *
 * CAMADA 0 — bug #2 (versão sem servidor novo, parecer lex 10/09): clicar
 * "Postularse"/"Ver Detalles" na HOME com cadastro incompleto abria um modal
 * genérico que não nomeava o que faltava e não reaproveitava o caminho real
 * de /vacantes/:id. Agora os dois botões abrem o MESMO IncompleteRegistrationModal,
 * alimentado por `missingFields` que a home já tem do GET /api/workers/me —
 * SEM chamar track-channel (LEX C1, cumprido pela ausência da chamada).
 *
 * Frontend real + backend real (USE_MOCK_AUTH=true) + Postgres real. A lista
 * de vagas vem de /api/public/v1/jobs (dado real do banco, via o toggle de
 * teste window.__USE_PUBLIC_JOBS_API — não é page.route de dado, é escolher
 * qual endpoint REAL a home consulta) — o scraper legado /api/jobs bate num
 * WordPress externo de verdade e não entra em teste automatizado.
 *
 * Pré-condições: docker (postgres + api) + pnpm dev. Run: pnpm test:e2e:integration
 */

import { test, expect, type Page, type Request } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.use({ video: 'on' });

test.describe('@integration Home — Postularse/Ver Detalles com cadastro incompleto (bug #2)', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];
  const vacancies: string[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
    for (const v of vacancies) cleanupMinimalVacancy(v);
  });

  async function loginAndGoHome(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await page.addInitScript(() => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    });
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
    await expect(page.locator('#jobs-section')).toBeVisible({ timeout: 20_000 });
  }

  test('feliz — AT sem antecedentes clica Postularse → modal lista Documentos → "Ir a" cai na aba com o aviso nomeando "Antecedentes penales"', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });
    await loginAndGoHome(page, w);

    const postularseBtn = page.getByRole('button', { name: 'Postularse' }).first();
    await expect(postularseBtn).toBeVisible({ timeout: 15_000 });
    await postularseBtn.click();

    const modal = page.getByRole('heading', { name: 'Registro incompleto' });
    await expect(modal).toBeVisible({ timeout: 10_000 });
    const docsItem = page.getByRole('button', { name: /Ir a Documentos/i });
    await expect(docsItem).toBeVisible();

    await expect(page.locator('[data-testid="incomplete-modal-pending-list"]')).toHaveScreenshot(
      'home-incomplete-modal-at-docs.png',
      { maxDiffPixels: 200 },
    );

    await docsItem.click();
    await expect(page).toHaveURL(/\/worker\/profile\?tab=documents/, { timeout: 15_000 });

    const notice = page.locator('[data-testid="at-required-notice"]');
    await expect(notice).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText('Antecedentes penales');
  });

  test('alt — falta telefone → modal nomeia "Teléfono" e leva à aba geral', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', phone: false });
    await loginAndGoHome(page, w);

    const postularseBtn = page.getByRole('button', { name: 'Postularse' }).first();
    await expect(postularseBtn).toBeVisible({ timeout: 15_000 });
    await postularseBtn.click();

    const phoneItem = page.getByRole('button', { name: /Ir a Teléfono/i });
    await expect(phoneItem).toBeVisible({ timeout: 10_000 });
    await phoneItem.click();

    await expect(page).toHaveURL(/\/worker\/profile\?tab=general&focus=phone/, { timeout: 15_000 });
    await expect(page.locator('[data-testid="tab-btn-general"]')).toBeVisible({ timeout: 15_000 });
  });

  test('alt — "Ver Detalles" com cadastro incompleto abre o MESMO modal e NENHUMA request pra track-channel', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ includeInPublicListing: true });
    vacancies.push(vacancyId);
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });

    const trackChannelRequests: Request[] = [];
    page.on('request', (req) => {
      if (req.url().includes('track-channel')) trackChannelRequests.push(req);
    });

    await loginAndGoHome(page, w);

    const detailsBtn = page.getByRole('button', { name: 'Ver Detalles' }).first();
    await expect(detailsBtn).toBeVisible({ timeout: 15_000 });

    // O link externo da vaga NUNCA deve abrir com cadastro incompleto —
    // interceptamos popup pra provar que nenhuma nova aba/navegação ocorre.
    let popupOpened = false;
    page.once('popup', () => { popupOpened = true; });

    await detailsBtn.click();

    const modal = page.getByRole('heading', { name: 'Registro incompleto' });
    await expect(modal).toBeVisible({ timeout: 10_000 });

    expect(popupOpened).toBe(false);
    expect(trackChannelRequests).toHaveLength(0);
  });
});
