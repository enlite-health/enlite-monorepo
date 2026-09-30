/**
 * kanban-suspension-exit-helper.ts
 *
 * Extraído de `patient-kanban-suspendido-saida-motivo.integration.e2e.ts` (migration 486,
 * decisão do Gabriel 29/09/2026 — D444) para uso também em `kanban-pacientes.integration.e2e.ts`
 * (conserto do e2e antigo pós-D444) — zero duplicação do "escolher motivo + confirmar" no
 * `SuspensionExitReasonDialog` do Kanban.
 *
 * `selectOption` é a forma canônica desta suíte para `<select>` (nunca fill/evaluate). O
 * `waitForResponse` some DENTRO do helper: o PUT só sai ao clicar `kanban-suspension-confirm`
 * (o drag sozinho não dispara nada — o diálogo abriu e nada se moveu ainda).
 */
import { expect, type Page } from '@playwright/test';

export type KanbanSuspensionExitReason =
  | 'RESUMED_SERVICE'
  | 'FAMILY_REQUESTED'
  | 'NEEDS_NEW_WORKER'
  | 'WRONG_STATUS'
  | 'OTHER';

/**
 * Assume que o diálogo (`kanban-suspension-dialog`) já está visível (drag concluído,
 * origem SUSPENDED). Escolhe o motivo, confirma, e espera o PUT `/status` sair junto do clique.
 */
export async function confirmKanbanSuspensionExit(
  page: Page,
  reason: KanbanSuspensionExitReason,
): Promise<void> {
  const dialogo = page.getByTestId('kanban-suspension-dialog');
  await expect(dialogo).toBeVisible();

  await page.getByTestId('kanban-suspension-exit-reason').selectOption(reason);
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'PUT' && /\/status$/.test(r.url())),
    page.getByTestId('kanban-suspension-confirm').click(),
  ]);

  await expect(dialogo).toBeHidden({ timeout: 15_000 });
}
