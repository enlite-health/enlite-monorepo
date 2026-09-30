/**
 * service-team-provider-modal-sem-celula.integration.e2e.ts @integration — topo do painel do
 * prestador (Encuadre) sob engine ABAC LIGADO (D447.3). O topo é do PACIENTE e o telefone dele
 * segue a MESMA célula que protege "WHATSAPP DEL PACIENTE" no card de identidade
 * (`patient_identity:read`):
 *
 *  - COM a célula (controle positivo, mesma execução): o painel mostra nome e WhatsApp do paciente.
 *  - SEM a célula: o painel abre, o prestador está no campo "Prestador de servicio", mas a linha do
 *    WhatsApp e o nome do paciente SOMEM — e o telefone do PRESTADOR não aparece em lugar nenhum.
 *
 * Arquivo próprio porque precisa do engine ligado (403 `account_not_active` de conta sem grupo
 * no job padrão, engine OFF); molde `encuadre-tab-sem-celula.integration.e2e.ts`. Contas por
 * `seedStaffInGroup`/`grantCell`, `role: 'recruiter'`. Semente 100% por SQL.
 */
import { test, expect } from '@playwright/test';
import { LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import {
  loginAs, seedStaffInGroup, cleanupStaffAndGroup, grantCell, pollAuthz, type MockUser,
} from '../helpers/abac-stack-helper';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import { seedServiceWithLiveVacancySql, cleanupItineraryWrite } from '../helpers/itinerario-escrita-e2e-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { openEncuadreTab, selectServiceRow, cleanupServiceTeamContactLog } from '../helpers/quadro-c-e2e-helper';

const PATIENT_PHONE = '+5491155501234';
const WORKER_PHONE = '+5491155509876'; // do PRESTADOR: não pode aparecer em lugar nenhum do painel

test.describe('service-team-provider-modal-sem-celula sob engine ligado @integration', () => {
  test('sem patient_identity:read a linha do WhatsApp do paciente SOME (controle positivo com a célula, mesma execução)', async ({ page, request, browser }) => {
    test.setTimeout(240_000);
    const runId = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
    const comUid = `qa.provider-modal.com.${runId}`;
    const semUid = `qa.provider-modal.sem.${runId}`;
    const staffCom: MockUser = { uid: comUid, email: `${comUid}@enlite.test`, role: 'recruiter', country: 'AR' };
    const staffSem: MockUser = { uid: semUid, email: `${semUid}@enlite.test`, role: 'recruiter', country: 'AR' };
    let groupComId = '';
    let groupSemId = '';
    let patientId = '';
    let serviceId = '';
    let vacancyId = '';
    let workerId = '';
    const hasCell = (b: { permissions?: string[] } | null, c: string) => Array.isArray(b?.permissions) && b.permissions.includes(c);
    try {
      ({ groupId: groupComId } = seedStaffInGroup({ uid: comUid, email: staffCom.email, groupName: `ProvModal COM ${runId}`, country: 'AR' }));
      ({ groupId: groupSemId } = seedStaffInGroup({ uid: semUid, email: staffSem.email, groupName: `ProvModal SEM ${runId}`, country: 'AR' }));
      // As duas contas veem quadro C e contato do prestador; só COM tem a célula do paciente.
      for (const g of [groupComId, groupSemId]) {
        for (const [r, a] of [['patient', 'read'], ['patient_services', 'read'], ['patient_service_team', 'read'], ['worker_contact', 'read']] as const) grantCell(g, r, a);
      }
      grantCell(groupComId, 'patient_identity', 'read');

      const com = await pollAuthz(request, staffCom, (b: { enforcement?: string; permissions?: string[] }) => b?.enforcement === 'on' && hasCell(b, 'patient_identity:read'));
      const sem = await pollAuthz(request, staffSem, (b: { enforcement?: string; permissions?: string[] }) => b?.enforcement === 'on' && hasCell(b, 'patient_services:read'));
      expect(hasCell(com.body, 'patient_identity:read')).toBe(true);
      expect(hasCell(sem.body, 'patient_identity:read')).toBe(false);

      const seeded = insertTestPatient({ withAddress: true, firstName: 'ProvModal', lastName: `Seed-${runId}` });
      patientId = seeded.patientId;
      runSQL(`UPDATE patients SET phone_whatsapp = '${PATIENT_PHONE}' WHERE id = '${patientId}'`);
      const svc = seedServiceWithLiveVacancySql(patientId, seeded.addressId!);
      serviceId = svc.serviceId;
      vacancyId = svc.vacancyId;
      workerId = insertTestWorker({ occupation: 'AT', whatsappPhone: WORKER_PHONE });
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      // COM (controle positivo): nome e WhatsApp do paciente aparecem.
      const ctx = await browser.newContext({ ...LANCAMENTO_VIEWPORT_ES_AR });
      try {
        const pageCom = await ctx.newPage();
        await loginAs(pageCom, staffCom);
        await openEncuadreTab(pageCom, patientId);
        await selectServiceRow(pageCom, serviceId);
        await pageCom.getByTestId(`service-team-card-${workerId}`).click();
        await expect(pageCom.getByTestId('service-team-provider-modal')).toBeVisible({ timeout: 15_000 });
        await expect(pageCom.getByTestId('service-team-provider-modal-name')).toContainText('ProvModal');
        await expect(pageCom.getByTestId('service-team-provider-modal-phone')).toContainText(PATIENT_PHONE);
      } finally {
        await ctx.close();
      }

      // SEM patient_identity:read: painel abre, prestador no campo, mas nem nome nem WhatsApp do paciente.
      await loginAs(page, staffSem);
      await openEncuadreTab(page, patientId);
      await selectServiceRow(page, serviceId);
      await page.getByTestId(`service-team-card-${workerId}`).click();
      await expect(page.getByTestId('service-team-provider-modal')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('service-team-provider-modal-provider-field')).toBeVisible();
      await expect(page.getByTestId('service-team-provider-modal-save')).toBeVisible();
      await expect(page.getByTestId('service-team-provider-modal-phone')).toHaveCount(0);
      await expect(page.getByTestId('service-team-provider-modal-name')).toHaveCount(0);
      await expect(page.getByTestId('service-team-provider-modal')).not.toContainText(PATIENT_PHONE);
      await expect(page.getByTestId('service-team-provider-modal')).not.toContainText(WORKER_PHONE);
    } finally {
      if (serviceId) cleanupServiceTeamContactLog(serviceId);
      if (patientId) cleanupItineraryWrite(patientId);
      if (workerId && vacancyId) cleanupWJAAndEncuadre(workerId, vacancyId);
      if (workerId) cleanupTestWorker(workerId);
      if (patientId) cleanupTestPatient(patientId);
      cleanupStaffAndGroup(comUid, groupComId);
      cleanupStaffAndGroup(semUid, groupSemId);
    }
  });
});
