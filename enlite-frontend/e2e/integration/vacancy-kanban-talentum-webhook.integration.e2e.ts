/**
 * vacancy-kanban-talentum-webhook.integration.e2e.ts @integration
 *
 * Valida o ciclo completo: webhook Talentum → Kanban da vaga.
 * Cobre 7 cenários com snapshot visual para regressão.
 *
 * Pré-condições: backend Docker em localhost:8080 (USE_MOCK_AUTH=true),
 * frontend dev server em localhost:5173.
 * Firebase Emulator NÃO é necessário.
 */

import { test, expect } from '@playwright/test';
import {
  insertTestWorker,
  insertTestPatient,
  insertBaseVacancy,
  cleanupTestWorker,
  cleanupTestPatient,
} from '../helpers/db-test-helper';
import {
  sendTalentumWebhook,
  loginAsKanbanAdmin,
  openKanban,
  waitForCardInStage,
  getEncuadreId,
  BACKEND_URL,
  type TalentumWebhookOpts,
} from '../helpers/talentumWebhookHelper';

// ── State compartilhado pela suite ────────────────────────────────────────────

let patientId = '';
let vacancyId = '';
let vacancyTitle = '';
let prescreeningId = '';

let worker1Id = '';
let worker1Email = '';
let worker1ProfileId = '';
let worker1Phone = '';

let worker2Id = '';
let worker2Email = '';
let worker2ProfileId = '';
let worker2Phone = '';

let worker3Id = '';
let worker3Phone = '';
let worker4Id = '';
let worker4Phone = '';

const cleanupWorkerIds: string[] = [];

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('Vacancy Kanban × Talentum Webhook @integration', () => {
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeAll(() => {
    const ts = Date.now();
    const rand = () =>
      String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    prescreeningId = `e2e-psc-${ts}-${rand()}`;

    worker1Phone = `+549118${rand()}`;
    worker1Email = `e2e-w1-${ts}-${rand()}@test.com`;
    worker1ProfileId = `prof-w1-${ts}-${rand()}`;
    worker1Id = insertTestWorker({ firstName: 'Worker', lastName: 'Uno', phone: worker1Phone });
    cleanupWorkerIds.push(worker1Id);

    worker2Phone = `+549119${rand()}`;
    worker2Email = `e2e-w2-${ts}-${rand()}@test.com`;
    worker2ProfileId = `prof-w2-${ts}-${rand()}`;
    worker2Id = insertTestWorker({ firstName: 'Worker', lastName: 'Dos', phone: worker2Phone });
    cleanupWorkerIds.push(worker2Id);

    worker3Phone = `+549120${rand()}`;
    worker3Id = insertTestWorker({ firstName: 'Worker', lastName: 'Tres', phone: worker3Phone });
    cleanupWorkerIds.push(worker3Id);

    worker4Phone = `+549121${rand()}`;
    worker4Id = insertTestWorker({ firstName: 'Worker', lastName: 'Cuatro', phone: worker4Phone });
    cleanupWorkerIds.push(worker4Id);

    const caseNumber = 980_000 + Math.floor(Math.random() * 19_999);
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true });
    patientId = pid;
    vacancyTitle = `CASO ${caseNumber}-base`;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });
  });

  test.afterAll(() => {
    for (const wid of cleanupWorkerIds) cleanupTestWorker(wid);
    cleanupTestPatient(patientId);
  });

  // ── C1 — Estado vazio ─────────────────────────────────────────────────────

  test('C1 — kanban vazio: 7 colunas com 0 cards', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    const colIds = ['INVITED', 'INITIATED', 'IN_PROGRESS', 'COMPLETED', 'CONFIRMED', 'SELECTED', 'REJECTED'];
    for (const id of colIds) {
      await expect(page.locator(`[data-testid="kanban-column-${id}-count"]`)).toHaveText('0');
    }

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'vacancy-kanban-empty.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── C2 — INITIATED ────────────────────────────────────────────────────────

  test('C2 — webhook INITIATED: card aparece na coluna INITIATED', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);

    const opts: TalentumWebhookOpts = {
      prescreeningId: `${prescreeningId}-w1`,
      prescreeningName: vacancyTitle,
      profileId: worker1ProfileId,
      profileEmail: worker1Email,
      profilePhone: worker1Phone,
      profileFirstName: 'Worker',
      profileLastName: 'Uno',
      subtype: 'INITIATED',
    };
    expect(await sendTalentumWebhook(request, opts)).toBe(200);

    const encId = await getEncuadreId(request, worker1Id, vacancyId);
    await waitForCardInStage(page, vacancyId, `kanban-card-${encId}`, 'INITIATED');

    await expect(page.locator('[data-testid="kanban-column-INITIATED-count"]')).toHaveText('1');
    await expect(page.locator('[data-testid="kanban-column-INVITED-count"]')).toHaveText('0');

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'vacancy-kanban-initiated.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── C3 — IN_PROGRESS ─────────────────────────────────────────────────────

  test('C3 — webhook IN_PROGRESS: card migra para coluna IN_PROGRESS', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);

    expect(
      await sendTalentumWebhook(request, {
        prescreeningId: `${prescreeningId}-w1`,
        prescreeningName: vacancyTitle,
        profileId: worker1ProfileId,
        profileEmail: worker1Email,
        profilePhone: worker1Phone,
        profileFirstName: 'Worker',
        profileLastName: 'Uno',
        subtype: 'IN_PROGRESS',
      }),
    ).toBe(200);

    const encId = await getEncuadreId(request, worker1Id, vacancyId);
    await waitForCardInStage(page, vacancyId, `kanban-card-${encId}`, 'IN_PROGRESS');

    await expect(page.locator('[data-testid="kanban-column-IN_PROGRESS-count"]')).toHaveText('1');
    await expect(page.locator('[data-testid="kanban-column-INITIATED-count"]')).toHaveText('0');

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'vacancy-kanban-in-progress.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── C4 — COMPLETED ────────────────────────────────────────────────────────

  test('C4 — webhook COMPLETED: card migra para coluna COMPLETED', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);

    expect(
      await sendTalentumWebhook(request, {
        prescreeningId: `${prescreeningId}-w1`,
        prescreeningName: vacancyTitle,
        profileId: worker1ProfileId,
        profileEmail: worker1Email,
        profilePhone: worker1Phone,
        profileFirstName: 'Worker',
        profileLastName: 'Uno',
        subtype: 'COMPLETED',
      }),
    ).toBe(200);

    const encId = await getEncuadreId(request, worker1Id, vacancyId);
    await waitForCardInStage(page, vacancyId, `kanban-card-${encId}`, 'COMPLETED');

    await expect(page.locator('[data-testid="kanban-column-COMPLETED-count"]')).toHaveText('1');
    await expect(page.locator('[data-testid="kanban-column-IN_PROGRESS-count"]')).toHaveText('0');

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'vacancy-kanban-completed.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── C5 — QUALIFIED ────────────────────────────────────────────────────────

  test('C5 — webhook ANALYZED+QUALIFIED: card em COMPLETED com badge QUALIFIED', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);

    expect(
      await sendTalentumWebhook(request, {
        prescreeningId: `${prescreeningId}-w1`,
        prescreeningName: vacancyTitle,
        profileId: worker1ProfileId,
        profileEmail: worker1Email,
        profilePhone: worker1Phone,
        profileFirstName: 'Worker',
        profileLastName: 'Uno',
        subtype: 'ANALYZED',
        statusLabel: 'QUALIFIED',
        score: 85,
      }),
    ).toBe(200);

    const encId = await getEncuadreId(request, worker1Id, vacancyId);
    // QUALIFIED agrupa em COMPLETED no EncuadreFunnelController
    await waitForCardInStage(page, vacancyId, `kanban-card-${encId}`, 'COMPLETED');

    await expect(page.locator('[data-testid="kanban-column-COMPLETED-count"]')).toHaveText('1');
    await expect(
      page.locator(`[data-testid="kanban-card-${encId}"] [data-testid="talentum-badge"]`),
    ).toBeVisible();

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'vacancy-kanban-qualified.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── C6 — NOT_QUALIFIED ───────────────────────────────────────────────────

  test('C6 — segundo worker NOT_QUALIFIED: 2 cards em COMPLETED', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);

    const psc2 = `${prescreeningId}-w2`;
    await sendTalentumWebhook(request, {
      prescreeningId: psc2,
      prescreeningName: vacancyTitle,
      profileId: worker2ProfileId,
      profileEmail: worker2Email,
      profilePhone: worker2Phone,
      profileFirstName: 'Worker',
      profileLastName: 'Dos',
      subtype: 'INITIATED',
    });
    expect(
      await sendTalentumWebhook(request, {
        prescreeningId: psc2,
        prescreeningName: vacancyTitle,
        profileId: worker2ProfileId,
        profileEmail: worker2Email,
        profilePhone: worker2Phone,
        profileFirstName: 'Worker',
        profileLastName: 'Dos',
        subtype: 'ANALYZED',
        statusLabel: 'NOT_QUALIFIED',
        score: 30,
      }),
    ).toBe(200);

    const enc2Id = await getEncuadreId(request, worker2Id, vacancyId);
    // NOT_QUALIFIED também agrupa em COMPLETED no EncuadreFunnelController
    await waitForCardInStage(page, vacancyId, `kanban-card-${enc2Id}`, 'COMPLETED');

    // worker1 (QUALIFIED) + worker2 (NOT_QUALIFIED) = 2 cards em COMPLETED
    await expect(page.locator('[data-testid="kanban-column-COMPLETED-count"]')).toHaveText('2');

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'vacancy-kanban-not-qualified.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── C7 — Contadores multi-card ───────────────────────────────────────────

  test('C7 — contadores corretos com workers em stages diferentes', async ({ page, request }) => {
    await loginAsKanbanAdmin(page);

    // Worker 3: INITIATED
    await sendTalentumWebhook(request, {
      prescreeningId: `${prescreeningId}-w3`,
      prescreeningName: vacancyTitle,
      profileId: `prof-w3-${worker3Id}`,
      profileEmail: `e2e-w3-${worker3Id}@test.com`,
      profilePhone: worker3Phone,
      profileFirstName: 'Worker',
      profileLastName: 'Tres',
      subtype: 'INITIATED',
    });

    // Worker 4: INITIATED → IN_PROGRESS
    const psc4 = `${prescreeningId}-w4`;
    await sendTalentumWebhook(request, {
      prescreeningId: psc4,
      prescreeningName: vacancyTitle,
      profileId: `prof-w4-${worker4Id}`,
      profileEmail: `e2e-w4-${worker4Id}@test.com`,
      profilePhone: worker4Phone,
      profileFirstName: 'Worker',
      profileLastName: 'Cuatro',
      subtype: 'INITIATED',
    });
    expect(
      await sendTalentumWebhook(request, {
        prescreeningId: psc4,
        prescreeningName: vacancyTitle,
        profileId: `prof-w4-${worker4Id}`,
        profileEmail: `e2e-w4-${worker4Id}@test.com`,
        profilePhone: worker4Phone,
        profileFirstName: 'Worker',
        profileLastName: 'Cuatro',
        subtype: 'IN_PROGRESS',
      }),
    ).toBe(200);

    const enc3Id = await getEncuadreId(request, worker3Id, vacancyId);
    await waitForCardInStage(page, vacancyId, `kanban-card-${enc3Id}`, 'INITIATED');

    // Contadores esperados:
    // INITIATED=1 (worker3), IN_PROGRESS=1 (worker4), COMPLETED=2 (worker1 QUALIFIED + worker2 NOT_QUALIFIED)
    await expect(page.locator('[data-testid="kanban-column-INITIATED-count"]')).toHaveText('1');
    await expect(page.locator('[data-testid="kanban-column-IN_PROGRESS-count"]')).toHaveText('1');
    await expect(page.locator('[data-testid="kanban-column-COMPLETED-count"]')).toHaveText('2');

    await expect(page.locator('[data-testid="kanban-board"]')).toHaveScreenshot(
      'vacancy-kanban-counters.png',
      { maxDiffPixelRatio: 0.05 },
    );
  });

  // ── Health check ──────────────────────────────────────────────────────────

  test('health — backend acessível antes da suite', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/health`);
    expect(res.status()).toBe(200);
  });
});
