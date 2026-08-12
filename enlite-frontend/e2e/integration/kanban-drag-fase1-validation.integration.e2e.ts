/**
 * kanban-drag-fase1-validation.integration.e2e.ts @integration
 *
 * Valida Fase 1 do fix do drag no Kanban:
 * - Cenário 0: contrato de API — encuadreId null para órfãos, uuid para positivo
 * - Cenário 1: card sem encuadreId (órfão) → drag bloqueado, sem request
 * - Cenário 2: drag positivo real — card com encuadreId → PUT usa encuadre.id correto,
 *              card some da coluna INVITED, aparece em CONFIRMED, persiste após refresh
 * - Cenário 3: prova de rede — órfão=0 requests confirmado via rede
 *
 * Pré-condições:
 * - Backend local porta 8080 com USE_MOCK_AUTH=true
 * - Frontend dev server porta 5173
 *
 * Nota histórica: a versão anterior deste arquivo usava um vacancyId e WJA ids
 * hardcoded (snapshot de dados de produção) que não existem no banco e2e limpo
 * — refatorado para semear vaga/workers/WJAs via helpers reais em beforeAll,
 * na mesma linha de kanban-orphan-wja-validation.integration.e2e.ts.
 *
 * Seeds (beforeAll):
 *   - Vaga dedicada (patient + job_posting via insertTestPatient/insertBaseVacancy)
 *   - Worker órfão: WJA INVITED sem encuadre — trigger anti-órfã (migration 189)
 *     desabilitado temporariamente para reproduzir dados legados, como em F7 de
 *     kanban-fase2-full-flow.integration.e2e.ts
 *   - Worker positivo: WJA INVITED com encuadre real (trigger habilitado cria
 *     o encuadre automaticamente — origen='auto-trigger')
 */

import { execSync } from 'child_process';
import { test, expect, type Route } from '@playwright/test';
import {
  insertTestPatient,
  insertBaseVacancy,
  insertTestWorker,
  cleanupTestPatient,
  cleanupTestWorker,
} from '../helpers/db-test-helper';
import {
  loginAsKanbanAdmin,
  openKanban,
  MOCK_TOKEN,
  BACKEND_URL,
} from '../helpers/talentumWebhookHelper';
import { dndKitDrag } from '../helpers/dndKitDrag';

// ── DB helpers ─────────────────────────────────────────────────────────────────

const CONTAINER = 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  return execSync(
    `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
    { stdio: 'pipe' },
  ).toString();
}

function extractUUID(psqlOutput: string): string | null {
  const match = psqlOutput.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : null;
}

function getWjaIdByWorkerAndJob(workerId: string, jobPostingId: string): string | null {
  const out = runSQL(
    `SELECT id FROM worker_job_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}' ORDER BY created_at DESC LIMIT 1`,
  );
  return extractUUID(out);
}

function getEncuadreIdByWorkerAndJob(workerId: string, jobPostingId: string): string | null {
  const out = runSQL(
    `SELECT id FROM encuadres WHERE worker_id = '${workerId}' AND job_posting_id = '${jobPostingId}' ORDER BY created_at DESC LIMIT 1`,
  );
  return extractUUID(out);
}

/** Reseta a WJA positiva para INVITED via DB direto — usado para isolamento entre execuções. */
function resetPositiveWja(wjaId: string): void {
  runSQL(
    `UPDATE worker_job_applications SET application_funnel_stage='INVITED', updated_at=NOW() WHERE id='${wjaId}'`,
  );
}

// ── State compartilhado pela suite ────────────────────────────────────────────

let patientId = '';
let vacancyId = '';

let orphanWorkerId = '';
let orphanWjaId = '';

let positiveWorkerId = '';
let positiveWjaId = '';
let positiveEncuadreId = '';

const cleanupWorkerIds: string[] = [];

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('Kanban Drag Fase 1 Validation @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeAll(() => {
    const rand = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    const caseNumber = 986_000 + Math.floor(Math.random() * 9_999);
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true });
    patientId = pid;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });

    // Worker órfão: WJA INVITED sem encuadre vinculado — trigger anti-órfã
    // (migration 189) desabilitado temporariamente (mesma técnica de F7 em
    // kanban-fase2-full-flow.integration.e2e.ts).
    orphanWorkerId = insertTestWorker({ firstName: 'Drag1', lastName: 'Orphan', phone: `+549150${rand()}` });
    cleanupWorkerIds.push(orphanWorkerId);

    runSQL(
      `ALTER TABLE worker_job_applications DISABLE TRIGGER trg_ensure_encuadre_on_wja_insert;
       INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, created_at, updated_at)
       VALUES ('${orphanWorkerId}', '${vacancyId}', 'INVITED', 'pre-migration-orphan', NOW(), NOW())
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING;
       ALTER TABLE worker_job_applications ENABLE TRIGGER trg_ensure_encuadre_on_wja_insert;`,
    );
    orphanWjaId = getWjaIdByWorkerAndJob(orphanWorkerId, vacancyId) ?? '';

    // Worker positivo: WJA INVITED com trigger HABILITADO — cria encuadre real
    // automaticamente (origen='auto-trigger'), source != 'manual' para
    // permanecer na coluna INVITED (source='manual' iria para INICIADO —
    // migration 230 / feature BLOQUEADO).
    positiveWorkerId = insertTestWorker({ firstName: 'Drag1', lastName: 'Positive', phone: `+549151${rand()}` });
    cleanupWorkerIds.push(positiveWorkerId);

    runSQL(
      `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, created_at, updated_at)
       VALUES ('${positiveWorkerId}', '${vacancyId}', 'INVITED', 'system', NOW(), NOW())
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING`,
    );
    positiveWjaId = getWjaIdByWorkerAndJob(positiveWorkerId, vacancyId) ?? '';
    positiveEncuadreId = getEncuadreIdByWorkerAndJob(positiveWorkerId, vacancyId) ?? '';

    if (!orphanWjaId || !positiveWjaId || !positiveEncuadreId) {
      throw new Error(
        `[beforeAll] Falha ao semear WJAs (orphan=${orphanWjaId}, positive=${positiveWjaId}, encuadre=${positiveEncuadreId})`,
      );
    }
  });

  test.afterAll(() => {
    runSQL(`DELETE FROM encuadres WHERE job_posting_id = '${vacancyId}'`);
    runSQL(`DELETE FROM worker_job_applications WHERE job_posting_id = '${vacancyId}'`);
    for (const wid of cleanupWorkerIds) cleanupTestWorker(wid);
    cleanupTestPatient(patientId);
  });

  // ── Cenário 0 — API contract ───────────────────────────────────────────────

  test('Cenário0 — API retorna encuadreId correto (null p/ órfãos, uuid p/ positivo)', async ({ request }) => {
    const res = await request.get(
      `${BACKEND_URL}/api/admin/vacancies/${vacancyId}/funnel`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
    );
    expect(res.status()).toBe(200);

    const body = (await res.json()) as {
      success: boolean;
      data: { stages: Record<string, Array<{ id: string; encuadreId: string | null }>> };
    };
    expect(body.success).toBe(true);

    const allCards = Object.values(body.data.stages).flat();

    const positive = allCards.find((c) => c.id === positiveWjaId);
    expect(positive, 'Positive control card must be present in funnel').toBeTruthy();
    expect(positive?.encuadreId, 'Positive control must have encuadreId').toBe(positiveEncuadreId);

    const orphan = allCards.find((c) => c.id === orphanWjaId);
    expect(orphan, 'Orphan card must be present in funnel').toBeTruthy();
    expect(orphan?.encuadreId, 'Orphan must have encuadreId=null').toBeNull();

    console.log('[C0] API contract OK: orphan=null, positive=', positiveEncuadreId);
  });

  // ── Cenário 1 — Card SEM encuadre (órfão): drag bloqueado ─────────────────

  test('Cenário1 — drag de card órfão bloqueado: sem request + visual confirmado', async ({ page }) => {
    const moveRequests: string[] = [];

    await loginAsKanbanAdmin(page);
    await page.route('**/api/admin/encuadres/**', async (route: Route) => {
      const req = route.request();
      if (req.method() === 'PUT' && req.url().includes('/move')) {
        moveRequests.push(req.url());
        const resp = await route.fetch();
        await route.fulfill({ response: resp });
        return;
      }
      await route.continue();
    });

    await openKanban(page, vacancyId);

    // Scroll vertical para expor o board no viewport — a página de detalhe da
    // vaga (patient/schedule) empurra o board abaixo do fold em 1080px.
    await page.evaluate(() => {
      const board = document.querySelector('[data-testid="kanban-board"]');
      if (board) board.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(200);

    const orphanWrapper = page.locator(`[data-testid="kanban-draggable-${orphanWjaId}"]`);
    await expect(orphanWrapper, 'Orphan draggable must be visible').toBeVisible();

    const dragDisabled = await orphanWrapper.getAttribute('data-drag-disabled');
    expect(dragDisabled, 'Orphan must have data-drag-disabled=true').toBe('true');

    const classAttr = await orphanWrapper.getAttribute('class');
    expect(classAttr, 'Orphan wrapper must have cursor-not-allowed class').toContain('cursor-not-allowed');

    const titleAttr = await orphanWrapper.getAttribute('title');
    expect(titleAttr, 'Orphan must have tooltip').toBeTruthy();
    console.log(`[C1] Orphan tooltip: "${titleAttr}"`);

    const confirmedCol = page.locator('[data-testid="kanban-column-CONFIRMED"]');
    await dndKitDrag(page, orphanWrapper, confirmedCol);
    await page.waitForTimeout(2_000);

    console.log(`[C1] Move requests captured: ${moveRequests.length}`);
    expect(moveRequests.length, 'Orphan drag must fire 0 move requests').toBe(0);

    await expect(orphanWrapper).toHaveScreenshot('kanban-orphan-drag-disabled.png', { maxDiffPixelRatio: 0.05 });
    console.log('[C1] Visual snapshot taken for orphan drag blocked state');
  });

  // ── Cenário 2 — Drag positivo real: end-to-end com assertivas obrigatórias ─

  test('Cenário2 — drag positivo: PUT usa encuadre.id, card move no DOM e persiste após refresh', async ({ page }) => {
    const capturedMoves: { url: string; body: string; status: number }[] = [];

    // Guarantee the WJA starts in INVITED (idempotent reset)
    resetPositiveWja(positiveWjaId);

    await loginAsKanbanAdmin(page);

    // Capture all PUT .../encuadres/.../move requests BEFORE they complete,
    // forwarding them to the real backend (no mock — we need real persistence).
    //
    // NOTE: route.fetch() bypasses other page.route() handlers, including the
    // one in installKanbanInterceptors that injects the mock Authorization header.
    // We must inject the header explicitly here so the backend (USE_MOCK_AUTH=true)
    // accepts the request.
    await page.route('**/api/admin/encuadres/**', async (route: Route) => {
      const req = route.request();
      if (req.method() === 'PUT' && req.url().includes('/move')) {
        const headers = { ...req.headers(), authorization: `Bearer ${MOCK_TOKEN}` };
        const resp = await route.fetch({ headers });
        capturedMoves.push({
          url: req.url(),
          body: req.postData() ?? '',
          status: resp.status(),
        });
        await route.fulfill({ response: resp });
        return;
      }
      await route.continue();
    });

    await openKanban(page, vacancyId);

    // Scroll vertical para expor o board no viewport — a página de detalhe da
    // vaga (patient/schedule) empurra o board abaixo do fold em 1080px.
    await page.evaluate(() => {
      const board = document.querySelector('[data-testid="kanban-board"]');
      if (board) board.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(200);

    // Verify positive card is visible and NOT drag-disabled
    const positiveWrapper = page.locator(`[data-testid="kanban-draggable-${positiveWjaId}"]`);
    await expect(positiveWrapper, 'Positive control card must be visible in INVITED').toBeVisible();

    const dragDisabled = await positiveWrapper.getAttribute('data-drag-disabled');
    expect(dragDisabled, 'Positive card must NOT be drag-disabled').not.toBe('true');

    // Verify card is in INVITED column initially
    const invitedColBefore = page.locator('[data-testid="kanban-column-INVITED"]');
    const cardInInvitedBefore = invitedColBefore.locator(`[data-testid="kanban-draggable-${positiveWjaId}"]`);
    await expect(cardInInvitedBefore, 'Card must be in INVITED column before drag').toBeVisible();

    // Perform drag using dnd-kit compatible helper
    const confirmedCol = page.locator('[data-testid="kanban-column-CONFIRMED"]');
    await expect(confirmedCol, 'CONFIRMED column must be visible').toBeVisible();

    await dndKitDrag(page, positiveWrapper, confirmedCol, {
      activationSteps: 8,
      mainSteps: 30,
      pauseAfterDown: 80,
      pauseAfterUp: 500,
    });

    // Wait for the network request to settle
    await page.waitForTimeout(3_000);

    console.log(`\n[C2] Move requests captured: ${capturedMoves.length}`);
    for (const r of capturedMoves) {
      console.log(`  PUT ${r.url} → ${r.status} | body: ${r.body}`);
    }

    // ── ASSERTIVA 1: exactly 1 PUT request was fired ──────────────────────────
    expect(
      capturedMoves.length,
      `Expected exactly 1 PUT /move request, got ${capturedMoves.length}. ` +
      'dnd-kit PointerSensor may not have activated — check dndKitDrag helper.',
    ).toBe(1);

    const move = capturedMoves[0];
    const encIdInUrl = move.url.split('/encuadres/')[1]?.split('/')[0] ?? '';

    // ── ASSERTIVA 2: URL contains the encuadre.id (NOT the wja.id) ────────────
    expect(
      encIdInUrl,
      `PUT URL must contain encuadre.id (${positiveEncuadreId}), got: ${encIdInUrl}`,
    ).toBe(positiveEncuadreId);

    expect(
      encIdInUrl,
      `PUT URL must NOT use wja.id (${positiveWjaId})`,
    ).not.toBe(positiveWjaId);

    expect(
      encIdInUrl,
      `PUT URL must NOT use worker.id (${positiveWorkerId})`,
    ).not.toBe(positiveWorkerId);

    // ── ASSERTIVA 3: request succeeded ────────────────────────────────────────
    expect(
      move.status,
      `PUT /move must return 2xx, got ${move.status}`,
    ).toBeLessThan(300);

    console.log(`[C2] Request OK: encuadreId=${encIdInUrl}, status=${move.status}`);

    // ── ASSERTIVA 4: card disappeared from INVITED column ─────────────────────
    const cardInInvitedAfter = invitedColBefore.locator(`[data-testid="kanban-draggable-${positiveWjaId}"]`);
    await expect(
      cardInInvitedAfter,
      'Card must have left the INVITED column after drag',
    ).not.toBeVisible();

    // ── ASSERTIVA 5: card appeared in CONFIRMED column ────────────────────────
    const cardInConfirmed = confirmedCol.locator(`[data-testid="kanban-draggable-${positiveWjaId}"]`);
    await expect(
      cardInConfirmed,
      'Card must appear in CONFIRMED column after drag',
    ).toBeVisible();

    console.log('[C2] DOM assertions OK: card moved INVITED → CONFIRMED');

    // ── PERSISTÊNCIA: reload and verify ───────────────────────────────────────
    await page.reload();
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 20_000 });
    await page.waitForTimeout(1_500);

    const cardInConfirmedAfterReload = page
      .locator('[data-testid="kanban-column-CONFIRMED"]')
      .locator(`[data-testid="kanban-draggable-${positiveWjaId}"]`);

    await expect(
      cardInConfirmedAfterReload,
      'Card must still be in CONFIRMED after page refresh (persistence check)',
    ).toBeVisible();

    console.log('[C2] Persistence OK: card still in CONFIRMED after reload');

    // ── VISUAL SNAPSHOT ───────────────────────────────────────────────────────
    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'kanban-after-positive-drag.png',
      { maxDiffPixelRatio: 0.05 },
    );

    // ── CLEANUP: reset WJA to INVITED for test isolation ──────────────────────
    resetPositiveWja(positiveWjaId);
    console.log('[C2] Cleanup: WJA reset to INVITED');
  });

  // ── Cenário 3 — Network proof ──────────────────────────────────────────────

  test('Cenário3 — network proof: órfão=0 requests, positivo usa encuadre.id', async ({ page }) => {
    const orphanMoves: string[] = [];
    const allMoves: { wja: string; url: string; status: number }[] = [];

    await loginAsKanbanAdmin(page);
    await page.route('**/api/admin/encuadres/**', async (route: Route) => {
      const req = route.request();
      if (req.method() === 'PUT' && req.url().includes('/move')) {
        // Inject mock token — route.fetch() bypasses other page.route() handlers.
        const headers = { ...req.headers(), authorization: `Bearer ${MOCK_TOKEN}` };
        const resp = await route.fetch({ headers });
        allMoves.push({ wja: 'unknown', url: req.url(), status: resp.status() });
        await route.fulfill({ response: resp });
        return;
      }
      await route.continue();
    });

    await openKanban(page, vacancyId);

    // Scroll vertical para expor o board no viewport — a página de detalhe da
    // vaga (patient/schedule) empurra o board abaixo do fold em 1080px.
    await page.evaluate(() => {
      const board = document.querySelector('[data-testid="kanban-board"]');
      if (board) board.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(200);

    // -- Orphan drag attempt using dndKitDrag --
    const confirmedCol = page.locator('[data-testid="kanban-column-CONFIRMED"]');
    const orphanWrapper = page.locator(`[data-testid="kanban-draggable-${orphanWjaId}"]`);

    const prevCount = allMoves.length;
    await dndKitDrag(page, orphanWrapper, confirmedCol);
    await page.waitForTimeout(2_000);

    const addedByOrphan = allMoves.length - prevCount;
    for (let i = prevCount; i < allMoves.length; i++) orphanMoves.push(allMoves[i].url);
    console.log(`[C3] Orphan drag: ${addedByOrphan} move requests (expected 0)`);

    // Print network summary
    console.log('\n[C3] Network proof summary:');
    console.log(`  Orphan drag requests: ${orphanMoves.length} (expected: 0)`);
    for (const url of orphanMoves) {
      console.log(`    [UNEXPECTED] ${url}`);
    }
    if (allMoves.length > 0) {
      for (const m of allMoves) {
        const encId = m.url.split('/encuadres/')[1]?.split('/')[0] ?? '';
        const isOrphan = orphanMoves.includes(m.url);
        const usedWjaId = encId === orphanWjaId || encId === positiveWjaId;
        const usedEncuadreId = encId === positiveEncuadreId;
        console.log(
          `  ${isOrphan ? '[ORPHAN]' : '[POSITIVE]'} PUT .../encuadres/${encId}/move → ` +
          `${m.status} | wja.id used: ${usedWjaId} | encuadre.id used: ${usedEncuadreId}`,
        );
      }
    }

    // Core assertion: orphan must fire 0 requests
    expect(orphanMoves.length, 'Orphan drag must produce 0 move requests').toBe(0);

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot('kanban-network-proof-board.png', { maxDiffPixelRatio: 0.05 });
  });
});
