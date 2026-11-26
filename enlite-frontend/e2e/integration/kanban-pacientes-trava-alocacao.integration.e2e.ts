/**
 * kanban-pacientes-trava-alocacao.integration.e2e.ts @integration — D489/D530 (cadeia, 058 Parte B).
 *
 * PONTA A PONTA SEM MOCK de comportamento: navegador real → worker-functions real (Docker) → Postgres real. Login pelo mock do stack de CI
 * (`loginComoStaffMock`: click + `keyboard.type`; é só a porta de entrada, como nos irmãos) — nenhuma resposta da API é interceptada.
 * A massa é a REAL da cadeia: paciente derivável + itinerário montado + alocação pela API (`derivacao-e2e-helper`).
 * Nome do ARQUIVO: casa o termo `kanban-pacientes` do `grep:` do job padrão (`pr-gate.yml:~203`, workflow intocado).
 *
 * Regra (D489/D530), na tela do estado-automatico-do-paciente (sem select de estado, Kanban sem arrasto — só as AÇÕES da ficha mudam estado humano):
 *   1. feliz — ficha de paciente com alocação: toda ação desabilitada, o aviso visível, nenhum select; o estado e a trilha não mudam (lido da tela e do banco);
 *   2. alt1 — itinerário montado SEM prestador: nenhuma trava, "Pausar" fica habilitada e a ação grava (ON_HOLD);
 *   3. alt2 — Kanban: o card de paciente com alocação não é arrastável; o gesto de arrastar não manda escrita, o card fica na coluna e o banco não muda.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { assembleApi } from '../helpers/itinerario-escrita-e2e-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { loginComoStaffMock } from '../helpers/login-mock-staff';
import type { MockUser } from '../helpers/abac-stack-helper';
import { dndKitDrag } from '../helpers/dndKitDrag';
import { escolherNoCombo } from '../helpers/combobox';
import {
  seedDerivablePatient, selectedWorker, allocateWorker, derivacaoToken, type DerivableSeed, type DerivableServiceSpec,
} from '../helpers/derivacao-e2e-helper';

const STAFF: MockUser = { uid: 'e2e-int-admin-d489', email: 'admin.d489@e2e.test', role: 'admin', country: 'AR' };
const AVISO = 'No se puede cambiar el estado: el paciente tiene prestador asignado en el itinerario. Quitá al prestador del itinerario primero.';
const OITO_HORAS: DerivableServiceSpec = {
  schedule: [
    { dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 },
    { dayOfWeek: 3, startTime: '08:00', durationMinutes: 240 },
  ],
};
const statusDb = (id: string): string => runSQL(`SELECT status FROM patients WHERE id = '${id}'`).trim();
const trilhaDb = (id: string): string => runSQL(`SELECT count(*) FROM patient_status_history WHERE patient_id = '${id}'`).trim();

test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, viewport: { width: 1600, height: 1000 } });

test.describe('D489/D530 — estado travado por alocação viva no itinerário @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  /** Paciente derivável com o itinerário montado; `comPrestador` aloca 1 de 2 faixas (a derivação leva o estado a REPLACEMENT). */
  async function massa(request: APIRequestContext, comPrestador: boolean): Promise<DerivableSeed> {
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [OITO_HORAS] });
    try {
      const [svc] = seed.services;
      expect((await assembleApi(request, derivacaoToken(), seed.patientId)).status).toBe(201);
      if (comPrestador) {
        const w = selectedWorker(seed, svc.vacancyId);
        expect((await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], w)).status).toBe(201);
      }
      return seed;
    } catch (err) {
      seed.cleanup();
      throw err;
    }
  }

  test('feliz: ficha com prestador alocado — toda ação desabilitada, aviso visível, sem select, o estado não muda', async ({ page, request }) => {
    const seed = await massa(request, true);
    try {
      expect(statusDb(seed.patientId)).toBe('REPLACEMENT'); // a derivação (automática) NÃO foi afetada pela trava
      const trilhaAntes = trilhaDb(seed.patientId);
      await loginComoStaffMock(page, STAFF, 'E2E D489');
      await page.goto(`/admin/patients/${seed.patientId}`);

      await expect(page.getByTestId('patient-status-actions')).toBeVisible({ timeout: 30_000 }); // a lista vem do SERVIDOR
      await expect(page.getByTestId('patient-status-actions-locked-notice')).toHaveText(AVISO);
      await expect(page.getByTestId('patient-status-select')).toHaveCount(0);

      const botoes = page.getByTestId('patient-status-actions').getByRole('button');
      expect(await botoes.count()).toBeGreaterThan(0);
      for (let i = 0; i < await botoes.count(); i++) await expect(botoes.nth(i)).toBeDisabled();

      await expect(page.getByTestId('patient-status-badge')).toContainText('Reemplazo'); // lido da tela
      expect(statusDb(seed.patientId)).toBe('REPLACEMENT');
      expect(trilhaDb(seed.patientId)).toBe(trilhaAntes);
    } finally {
      seed.cleanup();
    }
  });

  test('alt1: itinerário montado SEM prestador — sem aviso, "Pausar" habilitada, a ação grava', async ({ page, request }) => {
    const seed = await massa(request, false);
    try {
      await loginComoStaffMock(page, STAFF, 'E2E D489');
      await page.goto(`/admin/patients/${seed.patientId}`);

      await expect(page.getByTestId('patient-status-actions')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('patient-status-actions-locked-notice')).toHaveCount(0);
      const pausar = page.getByTestId('patient-status-action-pausar');
      await expect(pausar).toBeEnabled();

      await pausar.click();
      await escolherNoCombo(page, page.getByTestId('patient-status-action-reason'), 'Obra social'); // INSURER
      const confirmar = page.getByTestId('patient-status-action-confirm');
      await expect(confirmar).toBeEnabled();
      await confirmar.click();

      await expect(page.getByTestId('patient-status-action-error')).toHaveCount(0);
      await expect(page.getByTestId('patient-status-badge')).toContainText('En espera', { timeout: 20_000 }); // lido da tela
      await expect.poll(() => statusDb(seed.patientId)).toBe('ON_HOLD');
    } finally {
      seed.cleanup();
    }
  });

  test('alt2: Kanban — o card de paciente com prestador alocado não é arrastável; arrastar não escreve e nada muda', async ({ page, request }) => {
    const seed = await massa(request, true);
    try {
      const trilhaAntes = trilhaDb(seed.patientId);
      const escritas: string[] = [];
      page.on('request', (r) => {
        if (['PUT', 'POST', 'PATCH', 'DELETE'].includes(r.method()) && /\/api\/admin\/patients\//.test(r.url())) escritas.push(`${r.method()} ${r.url()}`);
      });
      await loginComoStaffMock(page, STAFF, 'E2E D489 Kanban');
      await page.goto('/admin/patients/kanban');
      await expect(page.locator('[data-testid="patient-kanban-board"]')).toBeVisible({ timeout: 30_000 });

      const card = page.locator(`[data-testid="patient-kanban-card-${seed.patientId}"]`);
      await expect(card).toBeVisible({ timeout: 30_000 });
      await card.scrollIntoViewIfNeeded();
      await expect(page.getByTestId(`kanban-draggable-${seed.patientId}`)).toHaveCount(0);
      await expect(page.getByTestId(`kanban-card-${seed.patientId}`)).not.toHaveAttribute('aria-roledescription', /.+/);
      await dndKitDrag(page, card, page.locator('[data-testid="kanban-column-SEARCHING"]'));

      expect(escritas, 'nenhuma escrita sai da página').toEqual([]);
      await expect(page.locator('[data-testid="kanban-column-REPLACEMENT"]').locator(`[data-testid="patient-kanban-card-${seed.patientId}"]`)).toBeVisible();
      expect(statusDb(seed.patientId)).toBe('REPLACEMENT');
      expect(trilhaDb(seed.patientId)).toBe(trilhaAntes);
    } finally {
      seed.cleanup();
    }
  });
});
