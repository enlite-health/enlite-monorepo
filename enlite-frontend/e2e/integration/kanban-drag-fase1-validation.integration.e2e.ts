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
 * - Seeds no banco:
 *   - Vacancy: 8e7e8447-8619-45d6-a60b-a507ec0fc1ab
 *   - Orphan WJA (INVITED, encuadreId=null): fcf6aeb8-1394-4ef7-8647-8d030f53ddcb
 *   - Positive WJA (INVITED, encuadreId=cccccccc-0001-0001-0001-000000000001):
 *       id=bbbbbbbb-0001-0001-0001-000000000001
 *       worker=aaaaaaaa-0001-0001-0001-000000000001 (status=REGISTERED)
 */

import { execSync } from 'child_process';
import { test, expect, Page, Route } from '@playwright/test';
import {
  loginAsKanbanAdmin,
  MOCK_TOKEN,
  BACKEND_URL,
} from '../helpers/talentumWebhookHelper';
import { dndKitDrag } from '../helpers/dndKitDrag';

// ── Seed IDs (pre-seeded, verified via DB) ────────────────────────────────────

const VACANCY_ID = '8e7e8447-8619-45d6-a60b-a507ec0fc1ab';
const ORPHAN_WJA_ID = 'fcf6aeb8-1394-4ef7-8647-8d030f53ddcb';
const POSITIVE_WJA_ID = 'bbbbbbbb-0001-0001-0001-000000000001';
const POSITIVE_ENCUADRE_ID = 'cccccccc-0001-0001-0001-000000000001';
const POSITIVE_WORKER_ID = 'aaaaaaaa-0001-0001-0001-000000000001';
const OUTPUT_DIR = '/tmp/kanban-validation';

// ── Mock for vacancy detail (not the funnel endpoint) ─────────────────────────

const VACANCY_DETAIL_MOCK = {
  success: true,
  data: {
    id: VACANCY_ID,
    title: 'CASO 98001-orphan-test',
    status: 'SEARCHING',
    is_draft: false,
    case_number: 98001,
    vacancy_number: 9001,
    patient_first_name: 'Paciente',
    patient_last_name: 'KanbanTest',
    patient_diagnosis: 'TEA',
    patient_zone: null,
    patient_city: null,
    patient_neighborhood: null,
    patient_address_formatted: 'Av. Corrientes 1234, CABA, AR',
    patient_address_raw: 'Av. Corrientes 1234, CABA',
    dependency_level: 'SEVERE',
    required_professions: ['AT'],
    providers_needed: 1,
    encuadres: [],
    publications: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    closes_at: null,
    published_at: null,
  },
};

async function installVacancyDetailMock(page: Page): Promise<void> {
  const pat = new RegExp(`/api/admin/vacancies/${VACANCY_ID}$`);
  await page.route('**/api/admin/vacancies/**', async (route: Route) => {
    if (route.request().method() === 'GET' && pat.test(route.request().url())) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(VACANCY_DETAIL_MOCK),
      });
      return;
    }
    await route.fallback();
  });
}

async function openKanbanBoard(page: Page): Promise<void> {
  await loginAsKanbanAdmin(page);
  await installVacancyDetailMock(page);
  await page.addInitScript(
    ([key]: [string]) => { window.localStorage.setItem(key, 'kanban'); },
    [`vacancy-funnel-view-${VACANCY_ID}`],
  );
  await page.goto(`/admin/vacancies/${VACANCY_ID}`);
  await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 25_000 });
  await page.waitForTimeout(1_500);
}

/**
 * Resets the positive control WJA back to INVITED stage via direct DB access.
 * Called after a positive drag test so the next run starts from the same state.
 */
function resetPositiveWja(): void {
  execSync(
    `docker exec enlite-postgres psql -U enlite_admin -d enlite_e2e -c ` +
    `"UPDATE worker_job_applications SET application_funnel_stage='INVITED', updated_at=NOW() ` +
    `WHERE id='${POSITIVE_WJA_ID}';"`,
    { stdio: 'pipe' },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Kanban Drag Fase 1 Validation @integration', () => {
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  // ── Cenário 0 — API contract ───────────────────────────────────────────────

  test('Cenário0 — API retorna encuadreId correto (null p/ órfãos, uuid p/ positivo)', async ({ request }) => {
    const res = await request.get(
      `${BACKEND_URL}/api/admin/vacancies/${VACANCY_ID}/funnel`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
    );
    expect(res.status()).toBe(200);

    const body = await res.json() as {
      success: boolean;
      data: { stages: Record<string, Array<{ id: string; encuadreId: string | null }>> };
    };
    expect(body.success).toBe(true);

    const allCards = Object.values(body.data.stages).flat();

    const positive = allCards.find(c => c.id === POSITIVE_WJA_ID);
    expect(positive, 'Positive control card must be present in funnel').toBeTruthy();
    expect(positive?.encuadreId, 'Positive control must have encuadreId').toBe(POSITIVE_ENCUADRE_ID);

    const orphan = allCards.find(c => c.id === ORPHAN_WJA_ID);
    expect(orphan, 'Orphan card must be present in funnel').toBeTruthy();
    expect(orphan?.encuadreId, 'Orphan must have encuadreId=null').toBeNull();

    console.log('[C0] API contract OK: orphan=null, positive=', POSITIVE_ENCUADRE_ID);
  });

  // ── Cenário 1 — Card SEM encuadre (órfão): drag bloqueado ─────────────────

  test('Cenário1 — drag de card órfão bloqueado: sem request + visual confirmado', async ({ page }) => {
    const moveRequests: string[] = [];

    await loginAsKanbanAdmin(page);
    await installVacancyDetailMock(page);

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

    await page.addInitScript(
      ([key]: [string]) => { window.localStorage.setItem(key, 'kanban'); },
      [`vacancy-funnel-view-${VACANCY_ID}`],
    );
    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 25_000 });
    await page.waitForTimeout(1_500);

    const orphanWrapper = page.locator(`[data-testid="kanban-draggable-${ORPHAN_WJA_ID}"]`);
    await expect(orphanWrapper, 'Orphan draggable must be visible').toBeVisible();

    const dragDisabled = await orphanWrapper.getAttribute('data-drag-disabled');
    expect(dragDisabled, 'Orphan must have data-drag-disabled=true').toBe('true');

    const classAttr = await orphanWrapper.getAttribute('class');
    expect(classAttr, 'Orphan wrapper must have cursor-not-allowed class').toContain('cursor-not-allowed');

    const titleAttr = await orphanWrapper.getAttribute('title');
    expect(titleAttr, 'Orphan must have tooltip').toBeTruthy();
    console.log(`[C1] Orphan tooltip: "${titleAttr}"`);

    await orphanWrapper.screenshot({ path: `${OUTPUT_DIR}/drag-orphan-blocked.png` });
    console.log(`[C1] Screenshot: ${OUTPUT_DIR}/drag-orphan-blocked.png`);

    const confirmedCol = page.locator('[data-testid="kanban-column-CONFIRMED"]');
    await dndKitDrag(page, orphanWrapper, confirmedCol);
    await page.waitForTimeout(2_000);

    console.log(`[C1] Move requests captured: ${moveRequests.length}`);
    expect(moveRequests.length, 'Orphan drag must fire 0 move requests').toBe(0);

    await expect(orphanWrapper).toHaveScreenshot('kanban-orphan-drag-disabled.png');
    console.log('[C1] Visual snapshot taken for orphan drag blocked state');
  });

  // ── Cenário 2 — Drag positivo real: end-to-end com assertivas obrigatórias ─

  test('Cenário2 — drag positivo: PUT usa encuadre.id, card move no DOM e persiste após refresh', async ({ page }) => {
    const capturedMoves: { url: string; body: string; status: number }[] = [];

    // Guarantee the WJA starts in INVITED (idempotent reset)
    resetPositiveWja();

    await loginAsKanbanAdmin(page);
    await installVacancyDetailMock(page);

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

    await page.addInitScript(
      ([key]: [string]) => { window.localStorage.setItem(key, 'kanban'); },
      [`vacancy-funnel-view-${VACANCY_ID}`],
    );
    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 25_000 });
    await page.waitForTimeout(1_500);

    // Verify positive card is visible and NOT drag-disabled
    const positiveWrapper = page.locator(`[data-testid="kanban-draggable-${POSITIVE_WJA_ID}"]`);
    await expect(positiveWrapper, 'Positive control card must be visible in INVITED').toBeVisible();

    const dragDisabled = await positiveWrapper.getAttribute('data-drag-disabled');
    expect(dragDisabled, 'Positive card must NOT be drag-disabled').not.toBe('true');

    // Screenshot before drag
    await page.locator('[data-testid="kanban-board"]').screenshot({
      path: `${OUTPUT_DIR}/drag-positive-before-real.png`,
    });
    console.log(`[C2] Before screenshot: ${OUTPUT_DIR}/drag-positive-before-real.png`);

    // Verify card is in INVITED column initially
    const invitedColBefore = page.locator('[data-testid="kanban-column-INVITED"]');
    const cardInInvitedBefore = invitedColBefore.locator(`[data-testid="kanban-draggable-${POSITIVE_WJA_ID}"]`);
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
      `PUT URL must contain encuadre.id (${POSITIVE_ENCUADRE_ID}), got: ${encIdInUrl}`,
    ).toBe(POSITIVE_ENCUADRE_ID);

    expect(
      encIdInUrl,
      `PUT URL must NOT use wja.id (${POSITIVE_WJA_ID})`,
    ).not.toBe(POSITIVE_WJA_ID);

    expect(
      encIdInUrl,
      `PUT URL must NOT use worker.id (${POSITIVE_WORKER_ID})`,
    ).not.toBe(POSITIVE_WORKER_ID);

    // ── ASSERTIVA 3: request succeeded ────────────────────────────────────────
    expect(
      move.status,
      `PUT /move must return 2xx, got ${move.status}`,
    ).toBeLessThan(300);

    console.log(`[C2] Request OK: encuadreId=${encIdInUrl}, status=${move.status}`);

    // Screenshot after drag (before refresh)
    await page.locator('[data-testid="kanban-board"]').screenshot({
      path: `${OUTPUT_DIR}/drag-positive-after-real.png`,
    });
    console.log(`[C2] After screenshot: ${OUTPUT_DIR}/drag-positive-after-real.png`);

    // ── ASSERTIVA 4: card disappeared from INVITED column ─────────────────────
    const cardInInvitedAfter = invitedColBefore.locator(`[data-testid="kanban-draggable-${POSITIVE_WJA_ID}"]`);
    await expect(
      cardInInvitedAfter,
      'Card must have left the INVITED column after drag',
    ).not.toBeVisible();

    // ── ASSERTIVA 5: card appeared in CONFIRMED column ────────────────────────
    const cardInConfirmed = confirmedCol.locator(`[data-testid="kanban-draggable-${POSITIVE_WJA_ID}"]`);
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
      .locator(`[data-testid="kanban-draggable-${POSITIVE_WJA_ID}"]`);

    await expect(
      cardInConfirmedAfterReload,
      'Card must still be in CONFIRMED after page refresh (persistence check)',
    ).toBeVisible();

    console.log('[C2] Persistence OK: card still in CONFIRMED after reload');

    // Screenshot after refresh
    await page.locator('[data-testid="kanban-board"]').screenshot({
      path: `${OUTPUT_DIR}/drag-positive-after-refresh.png`,
    });
    console.log(`[C2] Refresh screenshot: ${OUTPUT_DIR}/drag-positive-after-refresh.png`);

    // ── VISUAL SNAPSHOT ───────────────────────────────────────────────────────
    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'kanban-after-positive-drag.png',
    );

    // ── CLEANUP: reset WJA to INVITED for test isolation ──────────────────────
    resetPositiveWja();
    console.log('[C2] Cleanup: WJA reset to INVITED');
  });

  // ── Cenário 3 — Network proof ──────────────────────────────────────────────

  test('Cenário3 — network proof: órfão=0 requests, positivo usa encuadre.id', async ({ page }) => {
    const orphanMoves: string[] = [];
    const allMoves: { wja: string; url: string; status: number }[] = [];

    await loginAsKanbanAdmin(page);
    await installVacancyDetailMock(page);

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

    await page.addInitScript(
      ([key]: [string]) => { window.localStorage.setItem(key, 'kanban'); },
      [`vacancy-funnel-view-${VACANCY_ID}`],
    );
    await page.goto(`/admin/vacancies/${VACANCY_ID}`);
    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'attached', timeout: 25_000 });
    await page.waitForTimeout(1_500);

    // -- Orphan drag attempt using dndKitDrag --
    const confirmedCol = page.locator('[data-testid="kanban-column-CONFIRMED"]');
    const orphanWrapper = page.locator(`[data-testid="kanban-draggable-${ORPHAN_WJA_ID}"]`);

    const prevCount = allMoves.length;
    await dndKitDrag(page, orphanWrapper, confirmedCol);
    await page.waitForTimeout(2_000);

    const addedByOrphan = allMoves.length - prevCount;
    for (let i = prevCount; i < allMoves.length; i++) orphanMoves.push(allMoves[i].url);
    console.log(`[C3] Orphan drag: ${addedByOrphan} move requests (expected 0)`);

    // Take kanban screenshot
    await page.locator('[data-testid="kanban-board"]').screenshot({
      path: `${OUTPUT_DIR}/network-proof-board.png`,
    });

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
        const usedWjaId = encId === ORPHAN_WJA_ID || encId === POSITIVE_WJA_ID;
        const usedEncuadreId = encId === POSITIVE_ENCUADRE_ID;
        console.log(
          `  ${isOrphan ? '[ORPHAN]' : '[POSITIVE]'} PUT .../encuadres/${encId}/move → ` +
          `${m.status} | wja.id used: ${usedWjaId} | encuadre.id used: ${usedEncuadreId}`,
        );
      }
    }

    // Core assertion: orphan must fire 0 requests
    expect(orphanMoves.length, 'Orphan drag must produce 0 move requests').toBe(0);

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot('kanban-network-proof-board.png');
  });
});
