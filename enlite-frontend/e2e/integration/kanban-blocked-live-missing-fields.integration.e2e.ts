/**
 * kanban-blocked-live-missing-fields.integration.e2e.ts @integration
 *
 * Regressão VISUAL do bug reportado: no card da coluna BLOQUEADO, ao editar o
 * nome/sobrenome do worker o nome do card atualizava, mas as tags de campos
 * faltantes "Nombre"/"Apellido" NÃO sumiam (vinham de um snapshot materializado
 * em worker_blocked_applications.missing_fields_at_attempt, só recalculado numa nova
 * tentativa de postulação).
 *
 * Fix provado aqui: BlockedApplicationQueryRepository recomputa missing_fields_at_attempt
 * ON-READ via fn_worker_missing_fields para registration_incomplete. Editar o
 * perfil reflete no card sem nova tentativa.
 *
 * Fluxo 100% real (backend localhost:8080 + Postgres real, zero mock no caminho):
 *   1. Worker INCOMPLETE_REGISTER sem nome → tentativa REAL de postulação
 *      (POST /api/worker-applications/track-channel → 403 do gate) grava a linha
 *      bloqueada com missing_fields_at_attempt incluindo first_name/last_name.
 *   2. ANTES: card em BLOQUEADO mostra "Sin nombre registrado" + tags Nombre/Apellido/Sexo.
 *   3. Operador edita o nome pelo MESMO endpoint do WorkerEditModal
 *      (PATCH /api/admin/workers/:id/profile { firstName, lastName }).
 *   4. DEPOIS: recarrega o kanban → card mostra o nome, tags Nombre/Apellido
 *      SOMEM, e a tag Sexo (ainda faltante) PERMANECE — prova o recompute seletivo.
 *
 * Auth: USE_MOCK_AUTH=true no backend; token mock injetado (admin) / /api/test/auth/token (worker).
 * Screenshot via toHaveScreenshot() em cada estado (requisito hard do CLAUDE.md).
 */

import { execSync } from 'child_process';
import { test, expect, type Page } from '@playwright/test';
import { insertEligibilityWorker, insertMinimalVacancy, cleanupMinimalVacancy } from '../helpers/eligibility-worker-helper';
import { loginAsKanbanAdmin, openKanban, BACKEND_URL, MOCK_TOKEN } from '../helpers/talentumWebhookHelper';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`, { stdio: 'pipe' }).toString();
  } catch (err: any) {
    throw new Error(`DB error: ${err.stderr?.toString() ?? err.message}`);
  }
}

/** Mock token de WORKER (USE_MOCK_AUTH=true) via POST /api/test/auth/token — mesmo caminho do K3. */
async function getWorkerMockToken(page: Page, workerId: string): Promise<string> {
  const out = runSQL(`SELECT auth_uid, email FROM workers WHERE id = '${workerId}'`);
  const line = out.split('\n').find((l) => l.includes('@') && l.includes('|'));
  if (!line) throw new Error(`[auth] worker ${workerId} sem auth_uid/email: ${out}`);
  const [authUid, email] = line.split('|').map((s) => s.trim());
  const res = await page.request.post(`${BACKEND_URL}/api/test/auth/token`, {
    data: { uid: authUid, email, role: 'worker' },
  });
  if (res.status() !== 200) throw new Error(`[auth] mock token de worker falhou: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { data: { token: string } };
  return body.data.token;
}

let vacancyId = '';
let workerId = '';

test.describe('Kanban Rejeitados (tentativa negada) — tags de campos faltantes recomputam ao editar perfil @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  test.use({ viewport: { width: 1920, height: 1080 } });

  test.beforeAll(async () => {
    // Vaga SEARCHING publicada (track-channel exige vaga elegível).
    vacancyId = insertMinimalVacancy();

    // Worker INCOMPLETE_REGISTER sem nome/sobrenome E sem sexo → fn_worker_missing_fields
    // reporta first_name + last_name + sex. Editaremos só o nome: Nombre/Apellido devem
    // sumir e Sexo (não editado) deve permanecer — prova de recompute SELETIVO.
    const seeded = insertEligibilityWorker({ firstName: false, lastName: false, sex: false });
    workerId = seeded.workerId;
  });

  test.afterAll(() => {
    if (workerId && vacancyId) {
      runSQL(`DELETE FROM worker_blocked_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`);
    }
    if (workerId) {
      runSQL(`DELETE FROM worker_service_areas WHERE worker_id = '${workerId}'`);
      runSQL(`DELETE FROM worker_availability WHERE worker_id = '${workerId}'`);
      runSQL(`DELETE FROM worker_documents WHERE worker_id = '${workerId}'`);
      runSQL(`DELETE FROM workers WHERE id = '${workerId}'`);
    }
    if (vacancyId) cleanupMinimalVacancy(vacancyId);
  });

  test('ANTES: card em Rejeitados mostra "Sin nombre" + tags Nombre/Apellido/Sexo', async ({ page }) => {
    // Tentativa REAL de postulação → 403 do gate grava worker_blocked_applications.
    const workerToken = await getWorkerMockToken(page, workerId);
    const applyRes = await page.request.post(`${BACKEND_URL}/api/worker-applications/track-channel`, {
      headers: { Authorization: `Bearer ${workerToken}` },
      data: { jobPostingId: vacancyId, channel: 'facebook' },
    });
    expect(applyRes.status(), 'gate deve bloquear worker incompleto com 403').toBe(403);

    // Snapshot inicial no banco DEVE conter first_name/last_name (estado obsoleto que o bug expunha).
    const missingBefore = runSQL(
      `SELECT missing_fields_at_attempt FROM worker_blocked_applications WHERE worker_id = '${workerId}' AND job_posting_id = '${vacancyId}'`,
    );
    expect(missingBefore, 'snapshot inicial deve listar first_name').toContain('first_name');
    expect(missingBefore, 'snapshot inicial deve listar last_name').toContain('last_name');

    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    const bloqueadoCol = page.locator('[data-testid="kanban-column-REJECTED"]');
    await expect(bloqueadoCol, 'coluna REJECTED visível').toBeVisible();
    await expect(
      page.locator('[data-testid="kanban-column-REJECTED-count"]'),
      'REJECTED deve ter ≥1 card',
    ).not.toHaveText('0', { timeout: 15_000 });

    const missingTags = bloqueadoCol.locator('[data-testid="blocked-missing-fields"]').first();
    await expect(missingTags, 'tags de campos faltantes visíveis').toBeVisible();
    // As três tags relevantes estão presentes ANTES do fix aplicar.
    await expect(missingTags).toContainText('Nombre');
    await expect(missingTags).toContainText('Apellido');
    await expect(missingTags).toContainText('Sexo');
    // Card sem nome registrado.
    await expect(bloqueadoCol).toContainText('Sin nombre registrado');

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-blocked-live-before.png', { maxDiffPixelRatio: 0.05 });
  });

  test('DEPOIS: editar nome via API admin → tags Nombre/Apellido somem, Sexo permanece', async ({ page }) => {
    // Edição pelo MESMO endpoint que o WorkerEditModal usa (PATCH real, escrita real no banco).
    const patchRes = await page.request.patch(`${BACKEND_URL}/api/admin/workers/${workerId}/profile`, {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
      data: { firstName: 'Gabriel', lastName: 'Stein' },
    });
    expect(patchRes.status(), `PATCH profile deve salvar (200). Body: ${await patchRes.text()}`).toBe(200);

    // Prova no banco: fn_worker_missing_fields (SSOT, on-read) já NÃO lista first_name/last_name.
    const missingAfter = runSQL(`SELECT fn_worker_missing_fields('${workerId}'::uuid)`);
    expect(missingAfter, 'após editar, SSOT não lista mais first_name').not.toContain('first_name');
    expect(missingAfter, 'após editar, SSOT não lista mais last_name').not.toContain('last_name');
    expect(missingAfter, 'sexo continua faltando (edição foi seletiva)').toContain('sex');
    // O snapshot materializado permanece obsoleto de propósito (só re-tentativa o atualiza):
    // é o recompute ON-READ do repositório que corrige a exibição, provado abaixo na UI.

    await loginAsKanbanAdmin(page);
    await openKanban(page, vacancyId);

    const bloqueadoCol = page.locator('[data-testid="kanban-column-REJECTED"]');
    await expect(bloqueadoCol, 'card continua em Rejeitados (worker ainda incompleto)').toBeVisible();
    await expect(
      page.locator('[data-testid="kanban-column-REJECTED-count"]'),
    ).not.toHaveText('0', { timeout: 15_000 });

    // Nome agora aparece no card (deixou de ser "Sin nombre registrado").
    await expect(bloqueadoCol).toContainText('Gabriel Stein');
    await expect(bloqueadoCol).not.toContainText('Sin nombre registrado');

    // O CERNE do bug: as tags Nombre/Apellido SOMEM; Sexo (ainda faltante) PERMANECE.
    const missingTags = bloqueadoCol.locator('[data-testid="blocked-missing-fields"]').first();
    await expect(missingTags, 'ainda há campos faltantes (Sexo)').toBeVisible();
    await expect(missingTags, 'tag Nombre deve sumir após editar o nome').not.toContainText('Nombre');
    await expect(missingTags, 'tag Apellido deve sumir após editar o sobrenome').not.toContainText('Apellido');
    await expect(missingTags, 'tag Sexo permanece (não foi editada)').toContainText('Sexo');

    await expect(
      page.locator('[data-testid="kanban-board"]'),
    ).toHaveScreenshot('kanban-blocked-live-after.png', { maxDiffPixelRatio: 0.05 });
  });
});
