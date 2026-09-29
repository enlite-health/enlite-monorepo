/**
 * service-team-provider-modal-screen.integration.e2e.ts @integration — modal do prestador na
 * TELA (quadro C, rodada 2, decisão D). Front real (Vite) + API real + Postgres real, sem mock.
 *
 * Feliz: abre a aba Encuadre, seleciona o serviço, clica no CARD do prestador (não no botão) →
 * modal abre com nome/telefone, registra um contato (click + keyboard.type, nunca fill — memória
 * `e2e-humano-nao-e-fill`) → Historial mostra a linha.
 * Alternativo: "Rechazar" pelo modal move o card para a coluna Rechazado (a MESMA ação do botão
 * do card — o modal só delega, nunca decide sozinho).
 */
import { test, expect } from '@playwright/test';
import { seedLaunchablePatient, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { activateRecruitmentViaApi } from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { openEncuadreTab, selectServiceRow, cleanupQuadroC, cleanupServiceTeamContactLog } from '../helpers/quadro-c-e2e-helper';

const STAFF = mockAdminUserFor('contact-modal-screen');

test.describe('service-team-provider-modal-screen @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  useLancamentoStaff(STAFF, 'E2E Contact Modal');

  test('feliz — abre pelo card, registra contato com click+type, Historial mostra a linha', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      await loginAs(page, STAFF);
      await openEncuadreTab(page, seed.patientId);
      await selectServiceRow(page, seed.serviceId);
      await expect(page.getByTestId(`service-team-card-${workerId}`)).toBeVisible({ timeout: 15_000 });

      const printDir = process.env.PRINT_DIR;
      if (printDir) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${printDir}/encuadre-tab-aba-inteira.png`, fullPage: true, animations: 'disabled', caret: 'hide' });
      }

      await page.getByTestId(`service-team-card-${workerId}`).click();
      await expect(page.getByTestId('service-team-provider-modal')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('service-team-provider-modal-name')).not.toBeEmpty();

      // Contacto efectuado: Sí (select nativo — click + keyboard, sem fill).
      const contactedSelect = page.getByTestId('service-team-provider-modal-contacted');
      await contactedSelect.click();
      await contactedSelect.selectOption('YES');

      // Notas: HUMANO — click no campo + keyboard.type (nunca fill()).
      const noteField = page.getByTestId('service-team-provider-modal-note');
      await noteField.click();
      await page.keyboard.type('Confirmou disponibilidad para el caso');

      const saved = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/team\/.*\/contact$/.test(r.url()) && r.ok(),
      );
      await page.getByTestId('service-team-provider-modal-save').click();
      await saved;

      const historyRow = page.locator('[data-testid^="service-team-provider-modal-history-row-"]').first();
      await expect(historyRow).toBeVisible({ timeout: 15_000 });
      await expect(historyRow).toContainText('Confirmou disponibilidad para el caso');
      await expect(historyRow).toContainText('Sí');

      if (printDir) {
        await page.evaluate(() => document.fonts.ready);
        await page.getByTestId('service-team-provider-modal').screenshot({ path: `${printDir}/service-team-provider-modal.png`, animations: 'disabled', caret: 'hide' });
      }

      await page.getByTestId('service-team-provider-modal-close').click();
      await expect(page.getByTestId('service-team-provider-modal')).not.toBeVisible();
    } finally {
      cleanupServiceTeamContactLog(seed.serviceId);
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  test('alternativo — "Rechazar" pelo modal move o card pra Rechazado (delega pro MESMO fluxo do botão)', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      await loginAs(page, STAFF);
      await openEncuadreTab(page, seed.patientId);
      await selectServiceRow(page, seed.serviceId);
      await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerId}`)).toBeVisible({ timeout: 15_000 });

      await page.getByTestId(`service-team-card-${workerId}`).click();
      await expect(page.getByTestId('service-team-provider-modal')).toBeVisible({ timeout: 15_000 });

      await page.getByTestId('service-team-provider-modal-reject').click();
      // O modal fecha e o modal de MOTIVO (o mesmo do botão do card) abre.
      await expect(page.getByTestId('service-team-provider-modal')).not.toBeVisible();
      await expect(page.getByTestId('service-team-reject-modal')).toBeVisible({ timeout: 10_000 });

      const rejected = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/team\/reject$/.test(r.url()) && r.ok(),
      );
      await page.getByTestId('service-team-reject-option-other').click();
      await page.getByTestId('service-team-reject-confirm').click();
      await rejected;

      await expect(page.getByTestId('kanban-column-REJECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerId}`)).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerId}`)).toHaveCount(0);
    } finally {
      cleanupServiceTeamContactLog(seed.serviceId);
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });
});
