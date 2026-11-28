/**
 * patient-kanban-suspendido-saida-motivo.integration.e2e.ts @integration
 *
 * PONTA A PONTA SEM MOCK DE DADO: navegador real → worker-functions real (Docker) → Postgres real →
 * auth pelo mock do stack de CI (`loginComoStaffMock`: click + `keyboard.type`; token `mock_*`, padrão kanban-pacientes).
 *
 * Reescrito na F5 de estado-automatico-do-paciente: o Kanban de pacientes NÃO tem mais arrasto (nem o diálogo de motivo que ele abria). O
 * que era "arrastar Suspendido → Búsqueda pedindo o motivo" virou a ação "Retomar" da ficha (a saída de Suspendido continua pedindo o motivo),
 * lida de volta no Kanban:
 *   1. feliz — o card de Suspendido não tem atributo de arrasto e arrastar não faz NADA (nenhum diálogo, nenhuma escrita); pela ficha,
 *      "Retomar" com motivo move o paciente (re-derivado: Búsqueda) e o Kanban o mostra na coluna nova, com `reason`/`actor_uid` na trilha;
 *   2. alt1 — "Cancelar" na ação: o card CONTINUA em Suspendido, nada foi enviado;
 *   3. alt2 — Activo → arrastar para Suspendido não move (sem diálogo, sem escrita); a ação "Suspender" da ficha é que move.
 * Gestos humanos: `click`, foco, `keyboard.type`, arrasto de MOUSE (`dndKitDrag`); sem `page.route` de dado.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { escolherNoCombo } from '../helpers/combobox';

const STAFF: MockUser = { uid: 'e2e-int-admin-486-kanban', email: 'admin.486.kanban@e2e.test', role: 'admin', country: 'AR' };
const STAMP = Date.now().toString().slice(-6);

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

const statusDe = (id: string): string => runSQL(`SELECT status FROM patients WHERE id = '${id}'`).trim();

/** Registra toda escrita que a PÁGINA tenta (nenhuma pode sair de um arrasto). */
function escritasDaPagina(page: Page): string[] {
  const escritas: string[] = [];
  page.on('request', (r) => {
    if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method()) && /\/api\/admin\/patients\//.test(r.url())) escritas.push(`${r.method()} ${r.url()}`);
  });
  return escritas;
}

/** O card do paciente está NESTA coluna do Kanban (lido da tela, depois de carregar o board). */
async function cardNaColuna(page: Page, patientId: string, coluna: string): Promise<void> {
  await page.goto('/admin/patients/kanban');
  await expect(page.getByTestId('patient-kanban-board')).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId(`kanban-column-${coluna}`).getByTestId(`patient-kanban-card-${patientId}`);
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
}

/** Arrasta o card (gesto de mouse) para a coluna e prova que NADA aconteceu: sem diálogo, sem escrita, banco e coluna intactos. */
async function arrastarNaoFazNada(page: Page, patientId: string, de: string, para: string, estadoDoBanco: string): Promise<void> {
  const escritas = escritasDaPagina(page);
  await cardNaColuna(page, patientId, de);
  await expect(page.getByTestId(`kanban-card-${patientId}`)).not.toHaveAttribute('aria-roledescription', /.+/);
  await dndKitDrag(page, page.getByTestId(`patient-kanban-card-${patientId}`), page.getByTestId(`kanban-column-${para}`));
  await expect(page.getByRole('dialog').filter({ hasNotText: 'Notificaciones' })).toHaveCount(0);
  expect(escritas, 'nenhuma escrita sai do arrasto').toEqual([]);
  expect(statusDe(patientId)).toBe(estadoDoBanco);
  await cardNaColuna(page, patientId, de); // recarregado: continua onde estava
}

test.describe('Kanban sem arrasto — saída de SUSPENDED pede motivo na ação "Retomar" da ficha @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('feliz: arrastar Suspendido → Búsqueda não faz nada; Retomar na ficha (com motivo) move e grava o motivo', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Kanban', lastName: `Feliz${STAMP} QA` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D486 Kanban');
      const actorUid = STAFF.uid; // principal.id do token mock (AuthMiddleware.ts:156-157)
      await arrastarNaoFazNada(page, patientId, 'SUSPENDED', 'SEARCHING', 'SUSPENDED');

      // Pela ficha: Retomar pede o motivo de saída e só então habilita.
      await page.goto(`/admin/patients/${patientId}`);
      await page.getByTestId('patient-status-action-retomar').click({ timeout: 30_000 });
      const confirmar = page.getByTestId('patient-status-action-confirm');
      await expect(confirmar).toBeDisabled();
      await escolherNoCombo(page, page.getByTestId('patient-status-action-exit-reason'), 'Retomó el servicio (fin de vacaciones/internación)'); // RESUMED_SERVICE
      await confirmar.click();
      await expect(page.getByTestId('patient-status-badge')).toContainText('Búsqueda', { timeout: 20_000 });

      await expect.poll(() => statusDe(patientId)).toBe('SEARCHING');
      const hist = runSQL(
        `SELECT old_value || '|' || new_value || '|' || change_source || '|' || COALESCE(reason,'<NULL>') || '|' || COALESCE(actor_uid,'<NULL>')
           FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`,
      ).trim();
      expect(hist).toBe(`SUSPENDED|SEARCHING|resume|RESUMED_SERVICE|${actorUid}`);

      await cardNaColuna(page, patientId, 'SEARCHING'); // o Kanban lê o novo estado
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt1: cancelar a ação Retomar — o card continua em Suspendido, nada foi enviado', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'D486Kanban', lastName: `Alt1${STAMP} QA` });
    try {
      const escritas = escritasDaPagina(page);
      await loginComoStaffMock(page, STAFF, 'E2E D486 Kanban');
      await page.goto(`/admin/patients/${patientId}`);
      await page.getByTestId('patient-status-action-retomar').click({ timeout: 30_000 });
      await expect(page.getByTestId('patient-status-action-form')).toBeVisible();

      await page.getByTestId('patient-status-action-cancel').click();
      await expect(page.getByTestId('patient-status-action-form')).toHaveCount(0);

      expect(escritas).toEqual([]);
      expect(statusDe(patientId)).toBe('SUSPENDED');
      await cardNaColuna(page, patientId, 'SUSPENDED');
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt2: Activo → arrastar para Suspendido não move; a ação "Suspender" da ficha é que move (sem diálogo de motivo)', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'D486Kanban', lastName: `Alt2${STAMP} QA` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D486 Kanban');
      await arrastarNaoFazNada(page, patientId, 'ACTIVE', 'SUSPENDED', 'ACTIVE');

      await page.goto(`/admin/patients/${patientId}`);
      await page.getByTestId('patient-status-action-suspender').click({ timeout: 30_000 });
      await expect(page.getByTestId('patient-status-badge')).toContainText('Suspendido', { timeout: 20_000 });
      await expect.poll(() => statusDe(patientId)).toBe('SUSPENDED');
      await cardNaColuna(page, patientId, 'SUSPENDED');
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
