/**
 * patient-kanban-suspendido-saida-motivo.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK: navegador real → worker-functions real (Docker) → Postgres real →
 * auth pelo mock do stack de CI (`loginComoStaffMock`: click + `keyboard.type`; token `mock_*`, padrão kanban-pacientes).
 * Arrasto real via mouse (`dndKitDrag`, o helper compatível com o `PointerSensor` do dnd-kit —
 * nada de `dragTo()` genérico nem `page.evaluate` simulando o drop).
 *
 * O que prova (decisão do Gabriel 29/09/2026, 2ª rodada — Kanban PEDE o motivo no arrasto):
 *   1. feliz — arrastar um card de "Suspendido" para "Búsqueda": o diálogo abre, NADA se move
 *      antes de confirmar; escolhido o motivo e confirmado, o card cai na coluna nova e a
 *      Historial (via banco) tem a linha com reason/actor_uid;
 *   2. alt1 — cancelar no diálogo: o card CONTINUA em "Suspendido" (nada foi enviado — nem
 *      otimismo para desfazer, porque nunca houve otimismo);
 *   3. alt2 — arrastar entre DUAS colunas que não são "Suspendido" (Activo → Suspendido, a
 *      ENTRADA em Suspendido, não a saída) segue instantâneo, SEM diálogo — não-regressão.
 */
import { test, expect } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { confirmKanbanSuspensionExit } from '../helpers/kanban-suspension-exit-helper';

const STAFF: MockUser = { uid: 'e2e-int-admin-486-kanban', email: 'admin.486.kanban@e2e.test', role: 'admin', country: 'AR' };
const STAMP = Date.now().toString().slice(-6);

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

test.describe('Kanban — saída de SUSPENDED pede motivo no arrasto (decisão do Gabriel, 2ª rodada) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('feliz: arrastar Suspendido → Búsqueda abre o diálogo; confirmar move o card e grava o motivo', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Kanban', lastName: `Feliz${STAMP}` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D486 Kanban');
      const actorUid = STAFF.uid; // principal.id do token mock (AuthMiddleware.ts:156-157)
      await page.goto('/admin/patients/kanban');

      const card = page.locator(`[data-testid="kanban-draggable-${patientId}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      const destino = page.locator('[data-testid="kanban-column-SEARCHING"]');

      await card.scrollIntoViewIfNeeded();
      await dndKitDrag(page, card, destino);

      // o diálogo abriu — e NADA se moveu ainda (nem o banco, nem o card na tela).
      const dialogo = page.getByTestId('kanban-suspension-dialog');
      await expect(dialogo).toBeVisible();
      expect(runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`).trim()).toBe('SUSPENDED');

      // escolhe o motivo e confirma — helper compartilhado com `kanban-pacientes.integration.e2e.ts`
      // (zero duplicação, mesmo `selectOption` canônico desta suíte, nunca fill/evaluate).
      await confirmKanbanSuspensionExit(page, 'RESUMED_SERVICE');

      // o card saiu da coluna Suspendido e está em Búsqueda.
      await expect(page.locator('[data-testid="kanban-column-SUSPENDED"]').locator(`[data-testid="kanban-draggable-${patientId}"]`)).toHaveCount(0);
      await expect(page.locator('[data-testid="kanban-column-SEARCHING"]').locator(`[data-testid="kanban-draggable-${patientId}"]`)).toBeVisible({ timeout: 15_000 });

      await expect.poll(() => runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`).trim()).toBe('SEARCHING');
      const hist = runSQL(
        `SELECT old_value || '|' || new_value || '|' || COALESCE(reason,'<NULL>') || '|' || COALESCE(actor_uid,'<NULL>')
           FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`,
      );
      expect(hist).toBe(`SUSPENDED|SEARCHING|RESUMED_SERVICE|${actorUid}`);

      await expect(page).toHaveScreenshot('d486-kanban-feliz-apos-mover.png', { maxDiffPixelRatio: 0.05 });
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt1: cancelar no diálogo — o card continua em Suspendido, nada foi enviado', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Kanban', lastName: `Alt1${STAMP}` });
    try {
      let putChamado = false;
      await page.route('**/api/admin/patients/*/status', (route) => {
        putChamado = true;
        return route.continue();
      });
      await loginComoStaffMock(page, STAFF, 'E2E D486 Kanban');
      await page.goto('/admin/patients/kanban');

      const card = page.locator(`[data-testid="kanban-draggable-${patientId}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      const destino = page.locator('[data-testid="kanban-column-ON_HOLD"]');

      await card.scrollIntoViewIfNeeded();
      await dndKitDrag(page, card, destino);

      const dialogo = page.getByTestId('kanban-suspension-dialog');
      await expect(dialogo).toBeVisible();
      await expect(page).toHaveScreenshot('d486-kanban-alt1-dialogo-aberto.png', { maxDiffPixelRatio: 0.05 });

      await page.getByTestId('kanban-suspension-cancel').click();
      await expect(dialogo).toBeHidden();

      expect(putChamado).toBe(false);
      expect(runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`).trim()).toBe('SUSPENDED');
      await expect(page.locator('[data-testid="kanban-column-SUSPENDED"]').locator(`[data-testid="kanban-draggable-${patientId}"]`)).toBeVisible();
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt2: arrastar entre colunas que NÃO são Suspendido (Activo → Suspendido) segue instantâneo, sem diálogo', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'D486Kanban', lastName: `Alt2${STAMP}` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D486 Kanban');
      await page.goto('/admin/patients/kanban');

      const card = page.locator(`[data-testid="kanban-draggable-${patientId}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      const destino = page.locator('[data-testid="kanban-column-SUSPENDED"]');

      await card.scrollIntoViewIfNeeded();
      await dndKitDrag(page, card, destino);

      // sem diálogo — a origem NÃO é Suspendido (é a ENTRADA em Suspendido, não a saída).
      await expect(page.getByTestId('kanban-suspension-dialog')).toHaveCount(0);
      await expect(page.locator('[data-testid="kanban-column-SUSPENDED"]').locator(`[data-testid="kanban-draggable-${patientId}"]`)).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => runSQL(`SELECT status FROM patients WHERE id = '${patientId}'`).trim()).toBe('SUSPENDED');
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
