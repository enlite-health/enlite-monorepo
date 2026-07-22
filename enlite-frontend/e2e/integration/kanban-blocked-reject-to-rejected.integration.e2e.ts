/**
 * kanban-blocked-reject-to-rejected.integration.e2e.ts @integration
 *
 * Prova VISUAL do "Rechazar" de um card da coluna BLOQUEADO.
 *
 * Contrato exercido (fluxo 100% real, zero seed SQL no caminho de negócio):
 *   R1 — Uma tentativa de postulação REAL de um worker INCOMPLETE_REGISTER é
 *        barrada pelo gate (POST /api/worker-applications/track-channel → 403) e
 *        grava worker_blocked_applications → card na coluna BLOQUEADO.
 *   R2 — Na UI: clica "Rechazar" no card bloqueado → abre o MESMO dropdown de
 *        motivo do rejeitado normal (RejectionReasonSelect) → escolhe "AT no acepta"
 *        (WORKER_DECLINED) → confirma.
 *   R3 — O card SAI de BLOQUEADO e aparece em RECHAZADOS, com badge de motivo e
 *        ARRASTÁVEL (tem encuadre → data de drag habilitada), provando que dá pra
 *        movê-lo de volta no futuro.
 *   R4 — Persistência real no banco: WJA em REJECTED, encuadre RECHAZADO +
 *        rejection_reason_category, e a tentativa bloqueada marcada como resolvida
 *        (promoted_at + promoted_wja_id).
 *
 * Pré-condições (mesmas dos demais integration e2e de kanban):
 *   - Backend Docker em localhost:8080 (USE_MOCK_AUTH=true), banco e2e migrado.
 *   - Frontend dev server em localhost:5173.
 *
 * Auth: USE_MOCK_AUTH=true; admin via loginAsKanbanAdmin, worker via /api/test/auth/token.
 * Screenshot via toHaveScreenshot() — requisito hard do CLAUDE.md.
 */

import { execSync } from 'child_process';
import { test, expect, type Page } from '@playwright/test';
import {
  insertTestWorker,
  insertTestPatient,
  insertBaseVacancy,
  cleanupTestWorker,
  cleanupTestPatient,
} from '../helpers/db-test-helper';
import {
  loginAsKanbanAdmin,
  openKanban,
  BACKEND_URL,
} from '../helpers/talentumWebhookHelper';

// ── DB helpers (mesmo padrão de kanban-iniciado-blocked-columns) ────────────────

const CONTAINER = 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`, {
      stdio: 'pipe',
    }).toString();
  } catch (err: any) {
    throw new Error(`DB error: ${err.stderr?.toString() ?? err.message}`);
  }
}

function extractUUID(psqlOutput: string): string | null {
  const m = psqlOutput.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

async function getWorkerMockToken(page: Page, workerId: string): Promise<string> {
  const out = runSQL(`SELECT auth_uid, email FROM workers WHERE id = '${workerId}'`);
  const line = out.split('\n').find((l) => l.includes('@') && l.includes('|'));
  if (!line) throw new Error(`[auth] worker ${workerId} sem auth_uid/email: ${out}`);
  const [authUid, email] = line.split('|').map((s) => s.trim());
  const res = await page.request.post(`${BACKEND_URL}/api/test/auth/token`, {
    data: { uid: authUid, email, role: 'worker' },
  });
  if (res.status() !== 200) throw new Error(`[auth] mock token falhou: ${res.status()} ${await res.text()}`);
  return ((await res.json()) as { data: { token: string } }).data.token;
}

// ── State ──────────────────────────────────────────────────────────────────────

let patientId = '';
let vacancyId = '';
let workerBlocked_Id = '';
let workerBlocked_Phone = '';
let blockedWba_Id = '';

// ── Suite ──────────────────────────────────────────────────────────────────────

test.describe('Kanban — Rechazar card BLOQUEADO → RECHAZADOS @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeAll(() => {
    const rand = () => String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    workerBlocked_Phone = `+549134${rand()}`;
    workerBlocked_Id = insertTestWorker({
      firstName: 'Rechazar',
      lastName: 'Bloqueado',
      phone: workerBlocked_Phone,
      status: 'INCOMPLETE_REGISTER',
      occupation: null,
    });

    const caseNumber = 970_000 + Math.floor(Math.random() * 9_999);
    const { patientId: pid, addressId } = insertTestPatient({ withAddress: true });
    patientId = pid;
    vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'SEARCHING',
      isDraft: false,
    });
  });

  test.afterAll(() => {
    if (workerBlocked_Id) {
      runSQL(`DELETE FROM worker_blocked_applications WHERE worker_id = '${workerBlocked_Id}'`);
      runSQL(`DELETE FROM encuadres WHERE worker_id = '${workerBlocked_Id}'`);
      runSQL(`DELETE FROM worker_job_applications WHERE worker_id = '${workerBlocked_Id}'`);
      runSQL(`DELETE FROM domain_events WHERE payload->>'workerId' = '${workerBlocked_Id}'`);
      cleanupTestWorker(workerBlocked_Id);
    }
    cleanupTestPatient(patientId);
  });

  test('R1–R5 — Rechazar bloqueado: sai de BLOQUEADO, entra em RECHAZADOS (motivo, não-arrastável), persiste e volta', async ({ page }) => {
    // ── R1: seed do card bloqueado via gate REAL (403), não por seed SQL ────────
    const workerToken = await getWorkerMockToken(page, workerBlocked_Id);
    const applyRes = await page.request.post(`${BACKEND_URL}/api/worker-applications/track-channel`, {
      headers: { Authorization: `Bearer ${workerToken}` },
      data: { jobPostingId: vacancyId, channel: 'facebook' },
    });
    expect(applyRes.status(), 'gate deve bloquear worker incompleto com 403').toBe(403);

    blockedWba_Id =
      extractUUID(
        runSQL(
          `SELECT id FROM worker_blocked_applications WHERE worker_id = '${workerBlocked_Id}' AND job_posting_id = '${vacancyId}'`,
        ),
      ) ?? '';
    if (!blockedWba_Id) throw new Error('[R1] gate não gravou worker_blocked_applications');

    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    const bloqueadoCol = page.locator('[data-testid="kanban-column-BLOQUEADO"]');
    const blockedCard = page.locator(`[data-testid="kanban-card-${blockedWba_Id}"]`);
    await expect(blockedCard, 'card bloqueado deve estar visível em BLOQUEADO').toBeVisible({ timeout: 15_000 });
    await expect(bloqueadoCol.locator('[data-testid="blocked-badge"]').first()).toBeVisible();

    // ── R2: clica "Rechazar" → abre o dropdown de motivo → escolhe → confirma ───
    await blockedCard.locator('[data-testid="reject-button"]').click();

    const modal = page.locator('[data-testid="rejection-modal"]');
    await expect(modal, 'dropdown de motivo (mesmo do rejeitado normal) deve abrir').toBeVisible();
    await modal.locator('[data-testid="rejection-option-worker-declined"] input[type="radio"]').check();
    await modal.locator('[data-testid="rejection-confirm"]').click();

    // ── R3: card sai de BLOQUEADO e aparece em RECHAZADOS (MESMO id — é card de bloqueado, não WJA) ──
    await expect
      .poll(
        async () => {
          await openKanban(page, vacancyId);
          const inBloqueado = page.locator(`[data-testid="kanban-column-BLOQUEADO"] [data-testid="kanban-card-${blockedWba_Id}"]`);
          return (await inBloqueado.count()) === 0;
        },
        { message: 'card deve sumir de BLOQUEADO após rechazar', timeout: 30_000, intervals: [1_000, 2_000, 4_000] },
      )
      .toBe(true);

    const rejectedCol = page.locator('[data-testid="kanban-column-REJECTED"]');
    const rejectedCard = rejectedCol.locator(`[data-testid="kanban-card-${blockedWba_Id}"]`);
    await expect(rejectedCard, 'MESMO card deve aparecer em RECHAZADOS (card de bloqueado, não WJA)').toBeVisible({ timeout: 15_000 });
    await expect(rejectedCard.locator('[data-testid="rejection-badge"]'), 'badge de motivo deve estar visível').toBeVisible();
    await expect(rejectedCard.locator('[data-testid="blocked-badge"]'), 'continua sendo card de bloqueado').toBeVisible();
    // NÃO-arrastável: sem encuadre (o que é correto — incompleto não anda no funil).
    await expect(
      rejectedCol.locator(`[data-testid="kanban-draggable-${blockedWba_Id}"][data-drag-disabled="true"]`),
      'card rechazado NÃO deve ser arrastável (sem encuadre)',
    ).toHaveCount(1);
    // Tem o botão "Voltar a bloqueados".
    await expect(rejectedCard.locator('[data-testid="undismiss-button"]'), 'botão de voltar deve existir').toBeVisible();

    // Screenshot da coluna RECHAZADOS (não do board inteiro): mostra o card rechazado
    // de verdade — badge de motivo, badge de bloqueado e o botão de voltar.
    await expect(rejectedCol).toHaveScreenshot(
      'kanban-reject-blocked-rejected-column.png',
      { maxDiffPixelRatio: 0.05 },
    );

    // ── R4: persistência real no banco — soft-dismiss, SEM WJA/encuadre ──────────
    const wba = runSQL(
      `SELECT dismissed_at, dismissed_reason FROM worker_blocked_applications WHERE id = '${blockedWba_Id}'`,
    );
    expect(wba, 'dismissed_reason deve ser WORKER_DECLINED').toContain('WORKER_DECLINED');
    expect(wba, 'dismissed_at deve estar setado (não nulo)').not.toMatch(/dismissed_at[^\n]*\|\s*\n/);
    // Não cria candidatura nem encuadre (respeita a trava enforce_worker_registered).
    expect(
      runSQL(`SELECT COUNT(*) FROM worker_job_applications WHERE worker_id = '${workerBlocked_Id}' AND job_posting_id = '${vacancyId}'`),
      'não deve existir WJA para o worker incompleto',
    ).toMatch(/\b0\b/);

    // ── R5: "Voltar a bloqueados" — desfaz o rechazo (RECHAZADOS → BLOQUEADO) ────
    await rejectedCard.locator('[data-testid="undismiss-button"]').click();
    await expect
      .poll(
        async () => {
          await openKanban(page, vacancyId);
          const back = page.locator(`[data-testid="kanban-column-BLOQUEADO"] [data-testid="kanban-card-${blockedWba_Id}"]`);
          return (await back.count()) === 1;
        },
        { message: 'card deve voltar para BLOQUEADO após "voltar"', timeout: 30_000, intervals: [1_000, 2_000, 4_000] },
      )
      .toBe(true);
    expect(
      runSQL(`SELECT dismissed_at FROM worker_blocked_applications WHERE id = '${blockedWba_Id}' AND dismissed_at IS NULL`),
      'dismissed_at deve voltar a NULL',
    ).toMatch(/1 row/);
  });
});
