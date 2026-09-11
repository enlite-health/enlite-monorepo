/**
 * antecedentes-help.integration.e2e.ts @integration
 *
 * Fase 3 de postulacao-documento-pendente (DD4 · consome F12): expansível
 * "¿No lo tenés? Cómo sacarlo" no documento de antecedentes penais — um
 * componente, dois usos: item `doc_criminal_record` da lista de tarefas da
 * home (`PendingTasksCard`) e slot `criminal_record` da aba Documentos
 * (`DocumentsGrid`). "Termina quando" de `fase-3.md`.
 *
 * Prova de fluxo REAL: frontend real + backend real (USE_MOCK_AUTH=true) +
 * Postgres real. O worker é semeado no banco (`country='AR'` fixo no
 * helper — condição pra ajuda aparecer), login via helper pass-through.
 *
 * Pré-condições: docker (postgres + api desta worktree) + pnpm dev.
 * Run: PW_BASE_URL=<url> E2E_PG_CONTAINER=<container> pnpm test:e2e:integration
 *      --grep "antecedentes-help"
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertEligibilityWorker,
  cleanupEligibilityWorker,
  type InsertEligibilityWorkerResult,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';

test.use({ video: 'on' }); // definição de pronto exige vídeo do fluxo real

const ANTECEDENTES_HELP_URL =
  'https://www.argentina.gob.ar/justicia/reincidencia/antecedentespenales';

test.describe('@integration Ajuda de antecedentes — "¿No lo tenés? Cómo sacarlo" (Fase 3, DD4)', () => {
  test.setTimeout(90_000);
  const workers: InsertEligibilityWorkerResult[] = [];

  test.afterAll(() => {
    for (const w of workers) cleanupEligibilityWorker(w.workerId);
  });

  async function login(page: Page, w: InsertEligibilityWorkerResult): Promise<void> {
    workers.push(w);
    await loginNewWorker(page, w.authUid, `${w.authUid}@test.local`);
  }

  test('feliz — home: abre o expansível no item de antecedentes e lê o texto', async ({ page }) => {
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });
    await login(page, w);
    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });

    const card = page.locator('[data-testid="pending-tasks-card"]');
    await expect(card).toBeVisible({ timeout: 20_000 });

    const toggle = card.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(
      card.getByText(
        'Se tramita online con Clave Fiscal o Mi Argentina y te llega por e-mail.',
        { exact: false },
      ),
    ).toBeVisible();

    // C9 do lex: link com href CONSTANTE (sem query string), target/rel
    // corretos — conferido por atributo, NUNCA clicado (não navega de
    // verdade pra fora da app).
    const link = card.getByRole('link', { name: 'Cómo sacarlo' });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', ANTECEDENTES_HELP_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

    const helpBlock = card.locator('[data-testid="antecedentes-help"]');
    await expect(helpBlock).toHaveScreenshot('fase3-ajuda-home.png', { maxDiffPixels: 200 });
  });

  test('alt — aba Documentos: abre o expansível no slot criminal_record', async ({ page }) => {
    const w = insertEligibilityWorker({ occupation: 'AT', docCriminalRecord: false });
    await login(page, w);
    await page.goto('/worker/profile?tab=documents', { waitUntil: 'networkidle', timeout: 30_000 });

    const slot = page.locator('[data-testid="doc-slot-criminal_record"]');
    await expect(slot).toBeVisible({ timeout: 20_000 });

    const toggle = slot.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i });
    await expect(toggle).toBeVisible();

    await toggle.click();
    await expect(
      slot.getByText(
        'Se tramita online con Clave Fiscal o Mi Argentina y te llega por e-mail.',
        { exact: false },
      ),
    ).toBeVisible();

    const link = slot.getByRole('link', { name: 'Cómo sacarlo' });
    await expect(link).toHaveAttribute('href', ANTECEDENTES_HELP_URL);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('alt — antecedentes NÃO pendente: a ajuda não aparece nem na home nem na aba Documentos', async ({ page }) => {
    // docCriminalRecord: true (default) → antecedentes já enviado, não
    // entra em missingFields nem fica "sem arquivo" no slot.
    const w = insertEligibilityWorker({ occupation: 'AT', phone: false });
    await login(page, w);

    await page.goto('/', { waitUntil: 'networkidle', timeout: 30_000 });
    const card = page.locator('[data-testid="pending-tasks-card"]');
    await expect(card).toBeVisible({ timeout: 20_000 }); // ainda tem o phone pendente
    await expect(card.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i })).toHaveCount(0);

    await page.goto('/worker/profile?tab=documents', { waitUntil: 'networkidle', timeout: 30_000 });
    const slot = page.locator('[data-testid="doc-slot-criminal_record"]');
    await expect(slot).toBeVisible({ timeout: 20_000 });
    await expect(slot.getByRole('button', { name: /¿No lo tenés\? Cómo sacarlo/i })).toHaveCount(0);
  });
});
