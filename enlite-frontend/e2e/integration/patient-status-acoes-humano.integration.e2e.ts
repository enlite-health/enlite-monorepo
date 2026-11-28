/**
 * patient-status-acoes-humano.integration.e2e.ts @integration — estado-automatico-do-paciente, F3 (D5/D9): as AÇÕES dos estados humanos na ficha do
 * paciente (Pausar, Suspender, Dar de alta, Dar de baja, Retomar, Reactivar), pela TELA.
 *
 * E2E DE TELA, sem `page.route` de dado: navegador + API docker (mock auth, engine ABAC OFF → `cells===null`, a FSM decide) + Postgres reais. O login é
 * `loginComoStaffMock` (click + `keyboard.type`; só intercepta o Identity Toolkit e troca o header). Gestos humanos: `click`, foco, `keyboard.type`;
 * valor LIDO da tela (badge do estado, coluna do Kanban), nunca `evaluate`/`fill`. Screenshot + vídeo.
 *
 * Outbound mapeado: as ações só fazem SELECT/UPDATE em Postgres (lock do paciente, FSM, alocação, trilha por trigger). Alta/Baja NÃO enfileiram mensagem,
 * não chamam Talentum, WhatsApp, Ana Care, Google nem Short.io — nenhum canal real no caminho. Fixtures sintéticas (sobrenome " QA"), nenhum texto clínico.
 *
 *  feliz  — Pausar (motivo escolhido digitando no campo) → a ficha e o card do Kanban mostram "En espera"; Retomar → o estado RE-DERIVADO ("Búsqueda",
 *           sem itinerário), na ficha e na coluna do Kanban.
 *  alt 1  — Retomar de Suspendido: sem o motivo de saída "Confirmar" fica desabilitado; com o motivo passa.
 *  alt 2  — ação bloqueada por alocação viva: as ações ficam desabilitadas e o AVISO de alocação aparece; o estado não muda.
 *  alt 3  — Reactivar (D9) a partir de Baja (semeada por SQL, sem itinerário): um clique → "Búsqueda" lido da tela depois de recarregar (ficha e card).
 *
 * Roda no job padrão (`grep:` do `pr-gate.yml`, engine OFF). Molde: `patient-status-suspendido-saida-motivo.integration.e2e.ts`.
 */
import { test, expect, type Page } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { escolherNoCombo } from '../helpers/combobox';
import { seedItinerary, seedTitularAllocation, cleanupItinerary } from '../helpers/itinerary-db-helper';

const STAFF: MockUser = { uid: 'e2e-int-admin-f3-acoes', email: 'admin.f3.acoes@e2e.test', role: 'admin', country: 'AR' };
const STAMP = Date.now().toString().slice(-6);

test.use({ viewport: { width: 1600, height: 1000 }, video: 'on' });

const statusDe = (id: string): string => runSQL(`SELECT status FROM patients WHERE id = '${id}'`).trim();
const ultimaLinha = (id: string): string =>
  runSQL(`SELECT old_value || '|' || new_value || '|' || change_source FROM patient_status_history WHERE patient_id = '${id}' ORDER BY created_at DESC, id DESC LIMIT 1`).trim();

async function abrirFicha(page: Page, patientId: string): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  await expect(page.getByTestId('patient-status-control')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('patient-status-actions')).toBeVisible({ timeout: 20_000 }); // a lista vem do SERVIDOR
}

/** O card do paciente está NESTA coluna do Kanban (lido da tela, depois de carregar o board). */
async function cardNaColuna(page: Page, patientId: string, coluna: string): Promise<void> {
  await page.goto('/admin/patients/kanban');
  await expect(page.getByTestId('patient-kanban-board')).toBeVisible({ timeout: 20_000 });
  const card = page.getByTestId(`kanban-column-${coluna}`).getByTestId(`patient-kanban-card-${patientId}`);
  await expect(card).toHaveCount(1, { timeout: 20_000 });
  await card.scrollIntoViewIfNeeded();
}

test.describe('F3 — ações dos estados humanos na ficha (D5/D9) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  test('feliz: Pausar com motivo → En espera (ficha e Kanban); Retomar → estado re-derivado "Búsqueda" (ficha e Kanban)', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'ACTIVE', firstName: 'F3Feliz', lastName: `Acciones${STAMP} QA` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E F3');
      await abrirFicha(page, patientId);
      await expect(page.getByTestId('patient-status-badge')).toContainText('Activo');

      // Pausar: abre o motivo (obrigatório); "Confirmar" só habilita depois de escolhê-lo digitando no campo
      await page.getByTestId('patient-status-action-pausar').click();
      const confirmar = page.getByTestId('patient-status-action-confirm');
      await expect(confirmar).toBeDisabled();
      await escolherNoCombo(page, page.getByTestId('patient-status-action-reason'), 'Obra social'); // INSURER
      await expect(confirmar).toBeEnabled();
      await expect(page).toHaveScreenshot('f3-feliz-pausar-motivo.png', { maxDiffPixelRatio: 0.05 });
      await confirmar.click();
      await expect(page.getByTestId('patient-status-badge')).toContainText('En espera', { timeout: 20_000 }); // lido da TELA
      await expect.poll(() => statusDe(patientId)).toBe('ON_HOLD');
      expect(ultimaLinha(patientId)).toBe('ACTIVE|ON_HOLD|admin_panel');

      await cardNaColuna(page, patientId, 'ON_HOLD'); // o card do Kanban está em "En espera"
      await expect(page).toHaveScreenshot('f3-feliz-kanban-en-espera.png', { maxDiffPixelRatio: 0.05 });

      // Retomar: sem itinerário, o servidor RE-DERIVA (Búsqueda) — o cliente não escolhe
      await abrirFicha(page, patientId);
      await page.getByTestId('patient-status-action-retomar').click();
      await expect(page.getByTestId('patient-status-badge')).toContainText('Búsqueda', { timeout: 20_000 });
      await expect.poll(() => statusDe(patientId)).toBe('SEARCHING');
      expect(ultimaLinha(patientId)).toBe('ON_HOLD|SEARCHING|resume');
      await expect(page).toHaveScreenshot('f3-feliz-retomado.png', { maxDiffPixelRatio: 0.05 });

      await cardNaColuna(page, patientId, 'SEARCHING');
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt 1: Retomar de Suspendido sem motivo de saída fica desabilitado; com o motivo passa', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'SUSPENDED', firstName: 'F3Alt1', lastName: `Acciones${STAMP} QA` });
    try {
      await loginComoStaffMock(page, STAFF, 'E2E F3');
      await abrirFicha(page, patientId);
      await page.getByTestId('patient-status-action-retomar').click();
      const confirmar = page.getByTestId('patient-status-action-confirm');
      await expect(confirmar).toBeDisabled();
      expect(statusDe(patientId)).toBe('SUSPENDED'); // nenhum POST saiu
      await expect(page).toHaveScreenshot('f3-alt1-sem-motivo-desabilitado.png', { maxDiffPixelRatio: 0.05 });

      await escolherNoCombo(page, page.getByTestId('patient-status-action-exit-reason'), 'Retomó el servicio (fin de vacaciones/internación)'); // RESUMED_SERVICE
      await expect(confirmar).toBeEnabled();
      await confirmar.click();
      await expect(page.getByTestId('patient-status-badge')).toContainText('Búsqueda', { timeout: 20_000 });
      await expect.poll(() => statusDe(patientId)).toBe('SEARCHING');
      expect(runSQL(`SELECT old_value || '|' || new_value || '|' || change_source || '|' || COALESCE(reason, '<NULL>') FROM patient_status_history WHERE patient_id = '${patientId}' ORDER BY created_at DESC, id DESC LIMIT 1`).trim())
        .toBe('SUSPENDED|SEARCHING|resume|RESUMED_SERVICE');
    } finally {
      cleanupTestPatient(patientId);
    }
  });

  test('alt 2: com prestador alocado no itinerário as ações ficam desabilitadas e o AVISO aparece; o estado não muda', async ({ page }) => {
    const seed = seedItinerary();
    try {
      runSQL(`UPDATE patients SET last_name = 'Acciones${STAMP} QA', status = 'ON_HOLD', on_hold_reason = 'SCHOOL' WHERE id = '${seed.patientId}'`);
      seedTitularAllocation(seed);
      await loginComoStaffMock(page, STAFF, 'E2E F3');
      await abrirFicha(page, seed.patientId);

      const aviso = page.getByTestId('patient-status-actions-locked-notice');
      await expect(aviso).toBeVisible();
      await expect(aviso).toContainText('el paciente tiene prestador asignado en el itinerario'); // lido da tela
      await expect(page.getByTestId('patient-status-action-retomar')).toBeDisabled();
      await expect(page.getByTestId('patient-status-action-dar_baja')).toBeDisabled();
      await expect(page).toHaveScreenshot('f3-alt2-bloqueada-por-alocacao.png', { maxDiffPixelRatio: 0.05 });
      expect(statusDe(seed.patientId)).toBe('ON_HOLD');
    } finally {
      cleanupItinerary(seed);
    }
  });

  test('alt 3: Reactivar a partir de Baja (D9) — um clique → estado re-derivado "Búsqueda", lido da tela depois de recarregar (ficha e Kanban)', async ({ page }) => {
    const { patientId } = insertTestPatient({ status: 'DISCHARGED', firstName: 'F3Alt3', lastName: `Acciones${STAMP} QA` }); // semeado por SQL, sem itinerário
    try {
      await loginComoStaffMock(page, STAFF, 'E2E F3');
      await abrirFicha(page, patientId);
      await expect(page.getByTestId('patient-status-badge')).toContainText('Baja');
      await expect(page.getByTestId('patient-status-action-retomar')).toHaveCount(0); // retomar não existe em Baja: só Reactivar
      await expect(page).toHaveScreenshot('f3-alt3-baja-com-reativar.png', { maxDiffPixelRatio: 0.05 });
      await page.getByTestId('patient-status-action-reativar').click();
      await expect.poll(() => statusDe(patientId)).toBe('SEARCHING');
      expect(ultimaLinha(patientId)).toBe('DISCHARGED|SEARCHING|resume');

      await page.reload();
      await expect(page.getByTestId('patient-status-badge')).toContainText('Búsqueda', { timeout: 30_000 }); // lido da tela
      await expect(page.getByTestId('patient-status-badge')).not.toContainText('Baja');
      await expect(page).toHaveScreenshot('f3-alt3-reativado.png', { maxDiffPixelRatio: 0.05 });
      await cardNaColuna(page, patientId, 'SEARCHING');
    } finally {
      cleanupTestPatient(patientId);
    }
  });
});
