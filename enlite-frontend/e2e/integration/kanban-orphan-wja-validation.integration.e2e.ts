/**
 * kanban-orphan-wja-validation.integration.e2e.ts @integration
 *
 * Validação do fix do JOIN invertido no WJAFunnelController (WJA LEFT JOIN
 * LATERAL encuadres, ao invés de encuadre LEFT JOIN wja) para WJAs órfãs
 * (sem encuadre vinculado) — cenário histórico anterior à migration 189
 * (trigger anti-órfã trg_ensure_encuadre_on_wja_insert), reproduzido aqui via
 * seed com o trigger temporariamente desabilitado (mesma técnica usada em
 * F7 de kanban-fase2-full-flow.integration.e2e.ts).
 *
 * Cenários:
 *   Gate 1 — backend retorna as 3 WJAs órfãs com encuadreId=null e card.id=wja.id
 *   Gate 2 — WJAs órfãs aparecem no Kanban visual (INVITED/PRE_SCREENING/IN_PROGRESS)
 *            com data-drag-disabled=true
 *   Gate 3 — WJA via webhook Talentum aparece no Kanban ao lado das órfãs
 *   Gate 4 — drag de card órfão (sem encuadreId) — diagnóstico do endpoint chamado
 *   Gate 5 — contrato da API íntegro: todos os stages presentes
 *
 * Nota histórica: a versão anterior deste arquivo usava um vacancyId e WJA ids
 * hardcoded (snapshot de dados de produção) que não existem no banco e2e limpo
 * — refatorado para semear vaga/workers/WJAs via helpers reais em beforeAll.
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

// ── State compartilhado pela suite ────────────────────────────────────────────

let patientId = '';
let vacancyId = '';
let vacancyTitle = '';

let workerInvitedId = '';
let workerPreScrId = '';
let workerInProgressId = '';

let orphanWjaIdInvited = '';
let orphanWjaIdPreScr = '';
let orphanWjaIdInProgress = '';

const cleanupWorkerIds: string[] = [];

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('Kanban Orphan WJA Validation @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeAll(() => {
    const caseNumber = 985_000 + Math.floor(Math.random() * 9_999);
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true });
    patientId = pid;
    vacancyTitle = `CASO ${caseNumber}-orphan-test`;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });

    const rand = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    workerInvitedId = insertTestWorker({ firstName: 'Orphan', lastName: 'Invited', phone: `+549140${rand()}` });
    cleanupWorkerIds.push(workerInvitedId);
    workerPreScrId = insertTestWorker({ firstName: 'Orphan', lastName: 'PreScreening', phone: `+549141${rand()}` });
    cleanupWorkerIds.push(workerPreScrId);
    workerInProgressId = insertTestWorker({ firstName: 'Orphan', lastName: 'InProgress', phone: `+549142${rand()}` });
    cleanupWorkerIds.push(workerInProgressId);

    // Seed de 3 WJAs órfãs (sem encuadre vinculado) — trigger anti-órfã
    // (migration 189) desabilitado temporariamente para reproduzir dados
    // legados pré-migration, exatamente como em F7 de kanban-fase2-full-flow.
    runSQL(
      `ALTER TABLE worker_job_applications DISABLE TRIGGER trg_ensure_encuadre_on_wja_insert;
       INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, created_at, updated_at) VALUES
         ('${workerInvitedId}', '${vacancyId}', 'INVITED', 'pre-migration-orphan', NOW(), NOW()),
         ('${workerPreScrId}', '${vacancyId}', 'PRE_SCREENING', 'pre-migration-orphan', NOW(), NOW()),
         ('${workerInProgressId}', '${vacancyId}', 'IN_PROGRESS', 'pre-migration-orphan', NOW(), NOW())
       ON CONFLICT (worker_id, job_posting_id) DO NOTHING;
       ALTER TABLE worker_job_applications ENABLE TRIGGER trg_ensure_encuadre_on_wja_insert;`,
    );

    orphanWjaIdInvited = getWjaIdByWorkerAndJob(workerInvitedId, vacancyId) ?? '';
    orphanWjaIdPreScr = getWjaIdByWorkerAndJob(workerPreScrId, vacancyId) ?? '';
    orphanWjaIdInProgress = getWjaIdByWorkerAndJob(workerInProgressId, vacancyId) ?? '';

    if (!orphanWjaIdInvited || !orphanWjaIdPreScr || !orphanWjaIdInProgress) {
      throw new Error('[beforeAll] Falha ao semear as 3 WJAs órfãs (INVITED/PRE_SCREENING/IN_PROGRESS)');
    }
  });

  test.afterAll(() => {
    runSQL(`DELETE FROM encuadres WHERE job_posting_id = '${vacancyId}'`);
    runSQL(`DELETE FROM worker_job_applications WHERE job_posting_id = '${vacancyId}'`);
    for (const wid of cleanupWorkerIds) cleanupTestWorker(wid);
    cleanupTestPatient(patientId);
  });

  // ── Gate 1 — Backend health + contrato (API pura, sem browser) ────────────

  test('Gate1 — backend retorna 3 WJAs órfãs com encuadreId=null e card.id=wja.id', async ({ request }) => {
    const healthRes = await request.get(`${BACKEND_URL}/health`);
    expect(healthRes.status(), 'Backend /health deve retornar 200').toBe(200);

    const funnelRes = await request.get(
      `${BACKEND_URL}/api/admin/vacancies/${vacancyId}/funnel`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
    );
    expect(funnelRes.status(), 'Funnel API deve retornar 200').toBe(200);

    const body = (await funnelRes.json()) as {
      success: boolean;
      data: {
        totalEncuadres: number;
        stages: Record<string, Array<{ id: string; encuadreId: string | null; workerId: string | null }>>;
      };
    };

    expect(body.success).toBe(true);
    expect(body.data.totalEncuadres, 'Devem existir exatamente as 3 WJAs de seed no funil').toBe(3);

    const allCards = Object.values(body.data.stages).flat();
    const orphans = allCards.filter((c) => c.encuadreId === null);
    expect(orphans.length, 'As 3 WJAs de seed devem ter encuadreId=null').toBe(3);

    // Confirmar que card.id = wja.id (não encuadre.id)
    const invitedCards = body.data.stages['INVITED'] ?? [];
    const foundOrphan = invitedCards.find((c) => c.id === orphanWjaIdInvited);
    expect(foundOrphan, `card.id=${orphanWjaIdInvited} deve estar em INVITED`).toBeTruthy();
    expect(foundOrphan?.encuadreId).toBeNull();
  });

  // ── Gate 2 — Kanban visual com as órfãs ────────────────────────────────────

  test('Gate2 — WJAs órfãs aparecem no Kanban com fix aplicado (visual)', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    const invited = await page.locator('[data-testid="kanban-column-INVITED-count"]').textContent();
    const preScrCount = await page.locator('[data-testid="kanban-column-PRE_SCREENING-count"]').textContent();
    const inProgress = await page.locator('[data-testid="kanban-column-IN_PROGRESS-count"]').textContent();

    expect(Number(invited), 'INVITED deve ter >= 1 card (órfã)').toBeGreaterThanOrEqual(1);
    expect(Number(preScrCount), 'PRE_SCREENING deve ter >= 1 card (órfã)').toBeGreaterThanOrEqual(1);
    expect(Number(inProgress), 'IN_PROGRESS deve ter >= 1 card (órfã)').toBeGreaterThanOrEqual(1);

    // DraggableCard deve existir pelo WJA id (card.id = wja.id)
    const orphanDraggable = page.locator(`[data-testid="kanban-draggable-${orphanWjaIdInvited}"]`);
    await expect(orphanDraggable, 'Card órfão deve estar visível no Kanban').toBeVisible();

    // Sem encuadre vinculado → contrato de drag-disabled (mesma invariante de F7)
    await expect(
      orphanDraggable,
      'Card órfão sem encuadreId deve ter data-drag-disabled=true',
    ).toHaveAttribute('data-drag-disabled', 'true');

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-orphan-gate2-board.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── Gate 3 — Path Talentum: webhook aparece ao lado das órfãs ─────────────

  test('Gate3 — WJA via webhook Talentum aparece no Kanban ao lado das órfãs', async ({ page, request }) => {
    const ts = Date.now();
    const phone = `+549143${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
    const email = `e2e-orphan-g3-${ts}@test.com`;

    const workerGate3Id = insertTestWorker({ firstName: 'Gate3', lastName: 'Worker', phone });
    cleanupWorkerIds.push(workerGate3Id);
    // insertTestWorker gera um email interno próprio — sobrescrevemos para casar
    // com o profile.email do payload do webhook (usado para reconciliar o worker).
    runSQL(`UPDATE workers SET email = '${email}' WHERE id = '${workerGate3Id}'`);

    const payload = {
      action: 'PRESCREENING_RESPONSE',
      subtype: 'INITIATED',
      data: {
        prescreening: { id: `psc-g3-${ts}`, name: vacancyTitle },
        profile: {
          id: `prof-g3-${ts}`,
          firstName: 'Gate3',
          lastName: 'Worker',
          email,
          phoneNumber: phone,
          registerQuestions: [],
        },
        response: { id: `resp-g3-${ts}`, state: [] },
      },
    };

    const webhookRes = await request.post(`${BACKEND_URL}/api/webhooks/talentum/prescreening`, {
      data: payload,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(webhookRes.status(), 'Webhook Talentum deve retornar 200').toBe(200);

    const funnelRes = await request.get(
      `${BACKEND_URL}/api/admin/vacancies/${vacancyId}/funnel`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
    );
    const body = (await funnelRes.json()) as {
      data: { totalEncuadres: number; stages: Record<string, Array<{ id: string }>> };
    };
    expect(body.data.totalEncuadres, 'Deve ter 4 cards (3 seeds órfãs + 1 gate3)').toBe(4);

    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    const preScreeningCount = await page.locator('[data-testid="kanban-column-PRE_SCREENING-count"]').textContent();
    expect(Number(preScreeningCount), 'PRE_SCREENING deve ter >= 2 cards (órfã + gate3)').toBeGreaterThanOrEqual(2);

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-orphan-gate3-webhook.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── Gate 4 — Drag de card órfão (sem encuadreId) ──────────────────────────
  //
  // Diagnóstico: identifica se o drag chega a disparar PUT /move e, se sim,
  // qual id é usado na URL e o status retornado. Não assume um cenário fixo —
  // preserva a natureza exploratória original do gate.

  test('Gate4 — drag de card órfão: identifica endpoint e Cenário A/B/C', async ({ page }) => {
    const capturedRequests: { method: string; url: string; body: string; status: number }[] = [];

    await loginAsKanbanAdmin(page);
    await page.route('**/api/admin/encuadres/**', async (route: Route) => {
      const req = route.request();
      if (req.method() === 'PUT' && req.url().includes('/move')) {
        const response = await route.fetch();
        capturedRequests.push({
          method: req.method(),
          url: req.url(),
          body: req.postData() ?? '',
          status: response.status(),
        });
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    await openKanban(page, vacancyId);

    const draggableCard = page.locator(`[data-testid="kanban-draggable-${orphanWjaIdInvited}"]`);
    await expect(draggableCard, 'Card órfão deve estar visível antes do drag').toBeVisible();

    // Scroll vertical para expor o board no viewport
    await page.evaluate(() => {
      const board = document.querySelector('[data-testid="kanban-board"]');
      if (board) board.scrollIntoView({ block: 'start' });
    });
    await page.waitForTimeout(200);

    // Card órfão está em INVITED (1ª coluna) — bounding box capturada ANTES de
    // rolar o board horizontalmente até CONFIRMED, senão o card sai do viewport
    // (9 colunas, feature BLOQUEADO, não cabem em 1920px de uma vez).
    const cardBox = await draggableCard.boundingBox();
    if (!cardBox) throw new Error('Não foi possível obter bounding box do card órfão');

    const startX = cardBox.x + cardBox.width / 2;
    const startY = cardBox.y + cardBox.height / 2;

    console.log(`[Gate 4] Card bbox: x=${Math.round(cardBox.x)}, y=${Math.round(cardBox.y)}, w=${Math.round(cardBox.width)}, h=${Math.round(cardBox.height)}`);

    // Drag simulado: PointerSensor tem activationConstraint distance=8
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.waitForTimeout(100);
    // Mover 12px primeiro para ativar o PointerSensor (distance=8)
    await page.mouse.move(startX + 12, startY, { steps: 3 });

    // Rolar o board até CONFIRMED ficar visível (mouse já pressionado no card
    // órfão) — mesma técnica de dndKitDrag.ts (scrollIntoViewIfNeeded mid-drag).
    const confirmedColumn = page.locator('[data-testid="kanban-column-CONFIRMED"]');
    await confirmedColumn.scrollIntoViewIfNeeded();
    const colBox = await confirmedColumn.boundingBox();
    if (!colBox) throw new Error('Não foi possível obter bounding box da coluna CONFIRMED');
    console.log(`[Gate 4] CONFIRMED col bbox: x=${Math.round(colBox.x)}, y=${Math.round(colBox.y)}`);

    const endX = colBox.x + colBox.width / 2;
    const endY = colBox.y + 100; // Dentro da coluna mas não no header

    // Mover para a coluna CONFIRMED
    await page.mouse.move(endX, endY, { steps: 20 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    // Aguardar API call + re-render
    await page.waitForTimeout(3_000);

    console.log(`\n[Gate 4] Requests de move capturadas: ${capturedRequests.length}`);
    for (const r of capturedRequests) {
      console.log(`  ${r.method} ${r.url} → ${r.status} | body: ${r.body}`);
    }

    let scenario: 'A' | 'B' | 'C' = 'C';

    if (capturedRequests.length === 0) {
      scenario = 'C';
      console.log('[Gate 4] Cenário C: drag não disparou request de move (esperado — card sem encuadreId)');
    } else {
      for (const r of capturedRequests) {
        if (r.url.includes('/encuadres/') && r.url.includes('/move')) {
          const encIdInUrl = r.url.split('/encuadres/')[1]?.split('/')[0] ?? '';
          console.log(`[Gate 4] ID na URL de move: ${encIdInUrl}`);
          console.log(`[Gate 4] WJA ID esperado:   ${orphanWjaIdInvited}`);

          if (encIdInUrl === orphanWjaIdInvited) {
            scenario = r.status === 404 ? 'B' : 'A';
            console.log(`[Gate 4] Frontend enviou card.id (wja.id) como encuadreId → status=${r.status}`);
          } else {
            scenario = r.status < 400 ? 'A' : 'B';
            console.log(`[Gate 4] Frontend enviou id diferente: ${encIdInUrl}`);
          }
        }
      }
    }

    const confirmedAfterDrag = await page.locator('[data-testid="kanban-column-CONFIRMED-count"]').textContent();
    console.log(`[Gate 4] CONFIRMED count após drag: ${confirmedAfterDrag}`);
    console.log(`\n[Gate 4] CENÁRIO: ${scenario}`);

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-orphan-gate4-drag-result.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── Gate 5 — Contrato da API ──────────────────────────────────────────────

  test('Gate5 — contrato da API íntegro: todos os stages presentes', async ({ request }) => {
    const funnelRes = await request.get(
      `${BACKEND_URL}/api/admin/vacancies/${vacancyId}/funnel`,
      { headers: { Authorization: `Bearer ${MOCK_TOKEN}` } },
    );
    expect(funnelRes.status()).toBe(200);

    const body = (await funnelRes.json()) as {
      success: boolean;
      data: { stages: Record<string, unknown[]>; totalEncuadres: number };
    };
    expect(body.success).toBe(true);

    const stages = body.data.stages;
    for (const stage of [
      'INVITED', 'BLOQUEADO', 'INICIADO', 'PRE_SCREENING', 'IN_PROGRESS',
      'COMPLETED', 'CONFIRMED', 'SELECTED', 'REJECTED',
    ]) {
      expect(stages, `Stage ${stage} deve estar presente`).toHaveProperty(stage);
    }

    console.log('[Gate 5] Contrato da API OK — todos os 9 stages presentes, fix não quebrou estrutura');
    console.log(`[Gate 5] Total cards: ${body.data.totalEncuadres}`);
  });
});
