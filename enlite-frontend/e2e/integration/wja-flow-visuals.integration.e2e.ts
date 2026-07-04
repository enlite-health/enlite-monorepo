/**
 * wja-flow-visuals.integration.e2e.ts @integration
 *
 * Fase B — Massa de testes visuais WJA: 6 cenários capturando estados-chave
 * do Kanban via toHaveScreenshot() contra docker stack real.
 *
 * Pré-condições:
 *   - Backend Docker em localhost:8080 (USE_MOCK_AUTH=true)
 *   - Frontend dev server em localhost:5173
 *   - Migrations 188-197 aplicadas no banco enlite_e2e
 *
 * Cenários:
 *   V1 — Card INVITED com match_score (source=system, sem badge social)
 *   V2 — Card INVITED com badge acquisition_channel=instagram
 *   V3 — Coluna COMPLETED com 3 badges (QUALIFIED / IN_DOUBT / COMPLETED)
 *   V4 — Card CONFIRMED com badge REMARCADO (interview_response=awaiting_reschedule)
 *   V5 — Card REJECTED com rejection_reason_category=WORKER_DECLINED
 *   V6 — Card CONFIRMED com entrevista agendada (happy path)
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
  loginAsKanbanAdmin,
  waitForCardInStage,
  BACKEND_URL,
} from '../helpers/talentumWebhookHelper';
import {
  insertWJA,
  upsertEncuadre,
  cleanupWJAAndEncuadre,
} from '../helpers/wja-test-helper';

// ── State compartilhado pela suite ────────────────────────────────────────────

let patientId = '';
let vacancyId = '';

// Workers por cenário
let workerV1Id = '';
let workerV2Id = '';
let workerV3aId = '';
let workerV3bId = '';
let workerV3cId = '';
let workerV4Id = '';
let workerV5Id = '';
let workerV6Id = '';

// WJA IDs (= card IDs no Kanban)
let wjaV1Id = '';
let wjaV2Id = '';
let wjaV3aId = '';
let wjaV3bId = '';
let wjaV3cId = '';
let wjaV4Id = '';
let wjaV5Id = '';
let wjaV6Id = '';

const cleanupWorkerIds: string[] = [];

// ── Suite ─────────────────────────────────────────────────────────────────────

test.describe('WJA Flow Visuals @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(60_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  // ── Setup global ──────────────────────────────────────────────────────────

  test.beforeAll(() => {
    const rand = () =>
      String(Math.floor(Math.random() * 9_000_000) + 1_000_000);

    const caseNumber = 960_000 + Math.floor(Math.random() * 9_999);
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true });
    patientId = pid;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });

    // V1 — INVITED system + match_score
    workerV1Id = insertTestWorker({ firstName: 'WjaV1', lastName: 'SystemCard', phone: `+549181${rand()}` });
    cleanupWorkerIds.push(workerV1Id);

    // V2 — INVITED instagram
    workerV2Id = insertTestWorker({ firstName: 'WjaV2', lastName: 'Instagram', phone: `+549182${rand()}` });
    cleanupWorkerIds.push(workerV2Id);

    // V3 — 3 workers em COMPLETADO com badges diferentes
    workerV3aId = insertTestWorker({ firstName: 'WjaV3a', lastName: 'Qualified', phone: `+549183${rand()}` });
    cleanupWorkerIds.push(workerV3aId);

    workerV3bId = insertTestWorker({ firstName: 'WjaV3b', lastName: 'InDoubt', phone: `+549184${rand()}` });
    cleanupWorkerIds.push(workerV3bId);

    workerV3cId = insertTestWorker({ firstName: 'WjaV3c', lastName: 'Completed', phone: `+549185${rand()}` });
    cleanupWorkerIds.push(workerV3cId);

    // V4 — CONFIRMED + awaiting_reschedule sem meet_link
    workerV4Id = insertTestWorker({ firstName: 'WjaV4', lastName: 'Reprogram', phone: `+549186${rand()}` });
    cleanupWorkerIds.push(workerV4Id);

    // V5 — REJECTED com rejection_reason_category
    workerV5Id = insertTestWorker({ firstName: 'WjaV5', lastName: 'Rejected', phone: `+549187${rand()}` });
    cleanupWorkerIds.push(workerV5Id);

    // V6 — CONFIRMED com entrevista agendada
    workerV6Id = insertTestWorker({ firstName: 'WjaV6', lastName: 'Confirmed', phone: `+549188${rand()}` });
    cleanupWorkerIds.push(workerV6Id);

    // Inserir WJAs via SQL direto
    // (trigger migration 189/193 cria encuadre automaticamente via auto-trigger)

    wjaV1Id = insertWJA({
      workerId: workerV1Id,
      jobPostingId: vacancyId,
      funnelStage: 'INVITED',
      source: 'system',
      acquisitionChannel: null,
      matchScore: 87,
    });

    wjaV2Id = insertWJA({
      workerId: workerV2Id,
      jobPostingId: vacancyId,
      funnelStage: 'INVITED',
      source: 'manual',
      acquisitionChannel: 'instagram',
    });

    wjaV3aId = insertWJA({
      workerId: workerV3aId,
      jobPostingId: vacancyId,
      funnelStage: 'QUALIFIED',
      source: 'system',
    });

    wjaV3bId = insertWJA({
      workerId: workerV3bId,
      jobPostingId: vacancyId,
      funnelStage: 'IN_DOUBT',
      source: 'system',
    });

    wjaV3cId = insertWJA({
      workerId: workerV3cId,
      jobPostingId: vacancyId,
      funnelStage: 'COMPLETED',
      source: 'system',
    });

    wjaV4Id = insertWJA({
      workerId: workerV4Id,
      jobPostingId: vacancyId,
      funnelStage: 'CONFIRMED',
      source: 'manual',
      interviewResponse: 'awaiting_reschedule',
      meetLink: null,
      interviewDatetime: null,
    });

    wjaV5Id = insertWJA({
      workerId: workerV5Id,
      jobPostingId: vacancyId,
      funnelStage: 'REJECTED',
      source: 'manual',
    });

    // Encuadre com rejection_reason_category para V5
    // (trigger criou encuadre; upsertEncuadre faz ON CONFLICT UPDATE p/ setar campos de rejeição)
    upsertEncuadre({
      workerId: workerV5Id,
      jobPostingId: vacancyId,
      resultado: 'RECHAZADO',
      rejectionReasonCategory: 'WORKER_DECLINED',
    });

    wjaV6Id = insertWJA({
      workerId: workerV6Id,
      jobPostingId: vacancyId,
      funnelStage: 'CONFIRMED',
      source: 'manual',
      interviewResponse: 'confirmed',
      meetLink: 'https://meet.google.com/visual-test',
      interviewDatetime: '2099-08-10T14:00:00Z',
    });
  });

  test.afterAll(() => {
    // Cleanup WJAs + encuadres (prescrever antes de workers por FK ordering)
    cleanupWJAAndEncuadre(workerV1Id, vacancyId);
    cleanupWJAAndEncuadre(workerV2Id, vacancyId);
    cleanupWJAAndEncuadre(workerV3aId, vacancyId);
    cleanupWJAAndEncuadre(workerV3bId, vacancyId);
    cleanupWJAAndEncuadre(workerV3cId, vacancyId);
    cleanupWJAAndEncuadre(workerV4Id, vacancyId);
    cleanupWJAAndEncuadre(workerV5Id, vacancyId);
    cleanupWJAAndEncuadre(workerV6Id, vacancyId);

    for (const wid of cleanupWorkerIds) cleanupTestWorker(wid);
    cleanupTestPatient(patientId);
  });

  // ── V1 — Card INVITED com match_score (source=system, sem badge social) ───

  test('V1 — card INVITED system com match_score=87, sem badge acquisition_channel', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaV1Id}`, 'INVITED');

    const card = page.locator(`[data-testid="kanban-card-${wjaV1Id}"]`);

    // Score visível (Star + número 87)
    await expect(card.locator('text=87')).toBeVisible();

    // Sem badge de canal social (acquisition_channel=null → ACQUISITION_CHANNEL_STYLE não renderiza)
    await expect(card.locator('[data-testid="acquisition-channel-badge"]')).not.toBeVisible();

    // Card na coluna correta
    const invitedCol = page.locator('[data-testid="kanban-column-INVITED"]');
    await expect(invitedCol.locator(`[data-testid="kanban-card-${wjaV1Id}"]`)).toBeVisible();

    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'visible' });
    await expect(card).toHaveScreenshot('wja-v1-invited-system-card.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── V2 — Card INICIADO (source='manual') com badge acquisition_channel=instagram ──
  //
  // Migration 230 (feature BLOQUEADO): stage=INVITED + source='manual' mapeia
  // para a coluna INICIADO (postulação real, não-bloqueada) — não mais INVITED.

  test('V2 — card INICIADO manual com badge instagram (bg-pink-100 text-pink-700)', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaV2Id}`, 'INICIADO');

    const card = page.locator(`[data-testid="kanban-card-${wjaV2Id}"]`);
    const badge = card.locator('[data-testid="acquisition-channel-badge"]');

    // Badge instagram visível
    await expect(badge).toBeVisible();

    // Classes corretas de acordo com ACQUISITION_CHANNEL_STYLE em KanbanCard.tsx
    await expect(badge).toHaveClass(/bg-pink-100/);
    await expect(badge).toHaveClass(/text-pink-700/);

    // Card na coluna INICIADO
    await expect(
      page.locator('[data-testid="kanban-column-INICIADO"]').locator(`[data-testid="kanban-card-${wjaV2Id}"]`),
    ).toBeVisible();

    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'visible' });
    await expect(card).toHaveScreenshot('wja-v2-iniciado-instagram-card.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── V3 — Coluna COMPLETED com 3 badges (QUALIFIED / IN_DOUBT / COMPLETED) ─

  test('V3 — coluna COMPLETED com 3 cards e badges coloridos distintos', async ({ page }) => {
    await loginAsKanbanAdmin(page);

    // Aguardar todos os 3 cards aparecerem em COMPLETED
    // (QUALIFIED, IN_DOUBT, COMPLETED mapeiam para a coluna COMPLETED via WJAFunnelController)
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaV3aId}`, 'COMPLETED');
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaV3bId}`, 'COMPLETED');
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaV3cId}`, 'COMPLETED');

    const completedCol = page.locator('[data-testid="kanban-column-COMPLETED"]');

    // V3a — QUALIFIED badge: bg-green-50 text-green-700
    const cardV3a = completedCol.locator(`[data-testid="kanban-card-${wjaV3aId}"]`);
    const badgeV3a = cardV3a.locator('[data-testid="completado-badge"]');
    await expect(badgeV3a).toBeVisible();
    await expect(badgeV3a).toHaveClass(/bg-green-50/);
    await expect(badgeV3a).toHaveClass(/text-green-700/);

    // V3b — IN_DOUBT badge: bg-orange-50 text-orange-700
    const cardV3b = completedCol.locator(`[data-testid="kanban-card-${wjaV3bId}"]`);
    const badgeV3b = cardV3b.locator('[data-testid="completado-badge"]');
    await expect(badgeV3b).toBeVisible();
    await expect(badgeV3b).toHaveClass(/bg-orange-50/);
    await expect(badgeV3b).toHaveClass(/text-orange-700/);

    // V3c — COMPLETED badge: bg-blue-50 text-blue-700
    const cardV3c = completedCol.locator(`[data-testid="kanban-card-${wjaV3cId}"]`);
    const badgeV3c = cardV3c.locator('[data-testid="completado-badge"]');
    await expect(badgeV3c).toBeVisible();
    await expect(badgeV3c).toHaveClass(/bg-blue-50/);
    await expect(badgeV3c).toHaveClass(/text-blue-700/);

    // Coluna COMPLETED tem pelo menos os 3 cards do cenário
    const count = await page.locator('[data-testid="kanban-column-COMPLETED-count"]').textContent();
    expect(Number(count)).toBeGreaterThanOrEqual(3);

    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'visible' });
    await expect(completedCol).toHaveScreenshot('wja-v3-completed-column-badges.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── V4 — Card CONFIRMED com badge REMARCADO ───────────────────────────────

  test('V4 — card CONFIRMED com badge REMARCADO (awaiting_reschedule + meetLink=null)', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaV4Id}`, 'CONFIRMED');

    const card = page.locator(`[data-testid="kanban-card-${wjaV4Id}"]`);
    const reprogramBadge = card.locator('[data-testid="reprogram-badge"]');

    // Badge REMARCADO visível com classes corretas (KanbanCard.tsx:185)
    await expect(reprogramBadge).toBeVisible();
    await expect(reprogramBadge).toHaveClass(/bg-amber-50/);
    await expect(reprogramBadge).toHaveClass(/text-amber-700/);

    // Sem badge de entrevista (meetLink=null e interviewDatetime=null)
    // O label de entrevista só aparece quando stage=CONFIRMED e interviewDate é não-nulo
    await expect(card.locator('.bg-cyan-50')).not.toBeVisible();

    // Card na coluna CONFIRMED
    await expect(
      page.locator('[data-testid="kanban-column-CONFIRMED"]').locator(`[data-testid="kanban-card-${wjaV4Id}"]`),
    ).toBeVisible();

    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'visible' });
    await expect(card).toHaveScreenshot('wja-v4-reprogramar-card.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── V5 — Card REJECTED com rejection_reason_category ────────────────────

  test('V5 — card REJECTED com badge rejection_reason_category=WORKER_DECLINED', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaV5Id}`, 'REJECTED');

    const card = page.locator(`[data-testid="kanban-card-${wjaV5Id}"]`);
    const rejectionBadge = card.locator('[data-testid="rejection-badge"]');

    // Badge de rejeição visível (KanbanCard.tsx:192-196)
    await expect(rejectionBadge).toBeVisible();
    await expect(rejectionBadge).toHaveClass(/bg-red-50/);
    await expect(rejectionBadge).toHaveClass(/text-red-600/);

    // Card na coluna REJECTED
    await expect(
      page.locator('[data-testid="kanban-column-REJECTED"]').locator(`[data-testid="kanban-card-${wjaV5Id}"]`),
    ).toBeVisible();

    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'visible' });
    await expect(card).toHaveScreenshot('wja-v5-rejected-with-reason-card.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── V6 — Card CONFIRMED com entrevista agendada ───────────────────────────

  test('V6 — card CONFIRMED com entrevista agendada (happy path, sem badge REMARCADO)', async ({ page }) => {
    await loginAsKanbanAdmin(page);
    await waitForCardInStage(page, vacancyId, `kanban-card-${wjaV6Id}`, 'CONFIRMED');

    const card = page.locator(`[data-testid="kanban-card-${wjaV6Id}"]`);

    // Badge de data/hora da entrevista visível (KanbanCard.tsx:152-159)
    // Formato: "10 ago., 14:00" (es-AR locale, day + short month + time)
    const interviewBadge = card.locator('.bg-cyan-50');
    await expect(interviewBadge).toBeVisible();

    // Sem badge REMARCADO — interviewResponse='confirmed', não 'awaiting_reschedule'
    await expect(card.locator('[data-testid="reprogram-badge"]')).not.toBeVisible();

    // Card na coluna CONFIRMED
    await expect(
      page.locator('[data-testid="kanban-column-CONFIRMED"]').locator(`[data-testid="kanban-card-${wjaV6Id}"]`),
    ).toBeVisible();

    await page.waitForSelector('[data-testid="kanban-board"]', { state: 'visible' });
    await expect(card).toHaveScreenshot('wja-v6-confirmed-with-interview-card.png', { maxDiffPixelRatio: 0.05 });
  });

  // ── Health check ──────────────────────────────────────────────────────────

  test('health — backend acessível antes da suite', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/health`);
    expect(res.status()).toBe(200);
  });
});
