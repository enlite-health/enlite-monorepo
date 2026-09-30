/**
 * service-team-provider-modal-screen.integration.e2e.ts @integration — modal do prestador na
 * TELA (quadro C, rodada 3, Figma 11340:76413/76619). Front real (Vite) + API real + Postgres
 * real, sem mock.
 *
 * Feliz: abre a aba Encuadre, seleciona o serviço, clica no CARD do prestador (não no botão) →
 * painel lateral abre com o NOME e o WhatsApp do PACIENTE no topo (D447.3; telefone sintético
 * semeado no paciente, mesma projeção do card de identidade), o prestador só no campo "Prestador de
 * servicio", registra um contato
 * (click + keyboard.type, nunca fill — memória `e2e-humano-nao-e-fill`) → Historial mostra a
 * linha. Fecha por Esc (sem X — o Figma não tem).
 *
 * Alternativo: "Estado" é um SELECT. Escolher "Rechazar" abre o motivo (mesmo `RejectionReasonSelect`
 * de sempre), mas escolher motivo SOZINHO não aplica nada — nenhuma chamada a .../team/reject e o
 * card continua em Selecionado. Só "Guardar" aplica: dispara o reject E fecha o painel (o card
 * muda de coluna, o `columnId` do painel fica obsoleto).
 */
import { test, expect } from '@playwright/test';
import { seedLaunchablePatient, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { activateRecruitmentViaApi } from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { loginAs } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { openEncuadreTab, selectServiceRow, cleanupQuadroC, cleanupServiceTeamContactLog } from '../helpers/quadro-c-e2e-helper';

const STAFF = mockAdminUserFor('contact-modal-screen');
const PATIENT_PHONE = '+5491155501234';
const WORKER_PHONE = '+5491155509876'; // do PRESTADOR: NÃO pode aparecer em lugar nenhum do painel

test.describe('service-team-provider-modal-screen @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  useLancamentoStaff(STAFF, 'E2E Contact Modal');

  test('feliz — abre pelo card, mostra WhatsApp, registra contato com click+type, Historial mostra a linha, fecha por Esc', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT', whatsappPhone: WORKER_PHONE });
    runSQL(`UPDATE patients SET phone_whatsapp = '${PATIENT_PHONE}' WHERE id = '${seed.patientId}'`);
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      await loginAs(page, STAFF);
      await openEncuadreTab(page, seed.patientId);
      const pageTitle = (await page.locator('h1').first().innerText()).trim();
      expect(pageTitle).toContain('IntegTest');
      await selectServiceRow(page, seed.serviceId);
      await expect(page.getByTestId(`service-team-card-${workerId}`)).toBeVisible({ timeout: 15_000 });

      const printDir = process.env.PRINT_DIR;
      if (printDir) {
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `${printDir}/encuadre-tab-aba-inteira.png`, fullPage: true, animations: 'disabled', caret: 'hide' });
      }

      await page.getByTestId(`service-team-card-${workerId}`).click();
      await expect(page.getByTestId('service-team-provider-modal')).toBeVisible({ timeout: 15_000 });

      // D447.3 — topo = NOME do PACIENTE (o mesmo do título da ficha), nunca o do prestador.
      await expect(page.getByTestId('service-team-provider-modal-name')).toHaveText(pageTitle);
      // WhatsApp DO PACIENTE (telefone sintético semeado no paciente; STAFF admin mock tem
      // patient_identity:read), com o ícone À ESQUERDA do número.
      const phoneLink = page.getByTestId('service-team-provider-modal-phone');
      await expect(phoneLink).toBeVisible();
      await expect(phoneLink).toContainText(PATIENT_PHONE);
      await expect(phoneLink.locator('img').first()).toBeVisible();
      const iconBox = await phoneLink.locator('img').first().boundingBox();
      const textBox = await phoneLink.locator('span').first().boundingBox();
      expect(iconBox!.x + iconBox!.width).toBeLessThanOrEqual(textBox!.x + 1);
      // O telefone do PRESTADOR não viaja nem aparece no painel.
      await expect(page.getByTestId('service-team-provider-modal')).not.toContainText(WORKER_PHONE);

      // "Prestador de servicio": campo com borda, só-leitura, com o nome do PRESTADOR.
      const providerField = page.getByTestId('service-team-provider-modal-provider-field');
      await expect(providerField).toBeVisible();
      await expect(providerField).toBeDisabled();
      expect((await providerField.inputValue()).trim()).not.toBe('');
      expect(await providerField.inputValue()).not.toBe(pageTitle);

      if (printDir) {
        await page.evaluate(() => document.fonts.ready);
        await page.getByTestId('service-team-provider-modal').screenshot({ path: `${printDir}/service-team-provider-modal-aberto.png`, animations: 'disabled', caret: 'hide' });
      }

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

      // Sem ação pendente no Estado: Guardar grava o contato e NÃO fecha o painel.
      await expect(page.getByTestId('service-team-provider-modal')).toBeVisible();

      // Fecha por Esc — não há X no Figma.
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('service-team-provider-modal')).not.toBeVisible();
    } finally {
      cleanupServiceTeamContactLog(seed.serviceId);
      cleanupQuadroC(seed.patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      seed.cleanup();
    }
  });

  test('alternativo — Estado=Rechazar+motivo NÃO aplica nada; só "Guardar" dispara o reject e move o card', async ({ page, request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const workerId = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      await loginAs(page, STAFF);
      await openEncuadreTab(page, seed.patientId);
      await selectServiceRow(page, seed.serviceId);
      await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerId}`)).toBeVisible({ timeout: 15_000 });

      let rejectFiredBeforeGuardar = false;
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/team\/reject$/.test(r.url())) rejectFiredBeforeGuardar = true;
      });

      await page.getByTestId(`service-team-card-${workerId}`).click();
      await expect(page.getByTestId('service-team-provider-modal')).toBeVisible({ timeout: 15_000 });

      // Estado: select, não botão. Escolher "Rechazar" abre o motivo (MESMO diálogo de sempre).
      const estado = page.getByTestId('service-team-provider-modal-status');
      await estado.click();
      await estado.selectOption('REJECT');
      await expect(page.getByTestId('service-team-provider-modal-reject-modal')).toBeVisible({ timeout: 10_000 });

      await page.getByTestId('service-team-provider-modal-reject-option-other').click();
      await page.getByTestId('service-team-provider-modal-reject-confirm').click();

      // Motivo capturado: o modal de motivo fecha, o painel do prestador CONTINUA aberto, o
      // select de Estado mostra "Rechazar" escolhido — mas nada foi aplicado ainda.
      await expect(page.getByTestId('service-team-provider-modal-reject-modal')).not.toBeVisible();
      await expect(page.getByTestId('service-team-provider-modal')).toBeVisible();
      expect(rejectFiredBeforeGuardar).toBe(false);
      await expect(page.getByTestId('kanban-column-SELECTED_FOR_SERVICE').getByTestId(`service-team-card-${workerId}`)).toBeVisible();

      const printDir = process.env.PRINT_DIR;
      if (printDir) {
        await page.evaluate(() => document.fonts.ready);
        await page.getByTestId('service-team-provider-modal').screenshot({ path: `${printDir}/service-team-provider-modal-rechazar-selecionado.png`, animations: 'disabled', caret: 'hide' });
      }

      // Só "Guardar" aplica: dispara o reject E fecha o painel (o card muda de coluna).
      const rejected = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/team\/reject$/.test(r.url()) && r.ok(),
      );
      await page.getByTestId('service-team-provider-modal-save').click();
      await rejected;
      expect(rejectFiredBeforeGuardar).toBe(true);

      await expect(page.getByTestId('service-team-provider-modal')).not.toBeVisible();
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
