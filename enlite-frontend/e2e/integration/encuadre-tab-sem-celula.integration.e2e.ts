/**
 * encuadre-tab-sem-celula.integration.e2e.ts @integration — aba "Enquadre conforme Figma".
 *
 * Decisão 4 do brief (D286): "aba = OU das células dos containers dela; zero células → aba não
 * existe no DOM." O container `services` (screenRegistry.ts) é a ÚNICA fonte da aba "Encuadre" —
 * MESMA célula `patient_services` que já gatava "Servicio Contratado"/"Itinerario" (nenhuma célula
 * nova nasceu). Este spec prova os dois lados sob engine ABAC LIGADO (molde
 * `group-simulation-itinerario-aba-sem-celula.integration.e2e.ts`, Fase 12, P33):
 *
 *  - SEM `patient_services:read`: a aba "Encuadre" não aparece no tablist.
 *  - COM `patient_services:read` (controle positivo, mesma execução): a aba aparece e o conteúdo
 *    (`encuadre-tab`) monta.
 *
 * Contas por `seedStaffInGroup`/`grantCell`, `role: 'recruiter'`, `country: 'AR'` — nunca
 * `role: 'admin'` sem grupo (403 `account_not_active` sob engine ligado). `pollAuthz` confirma o
 * contrato antes de abrir a tela. Limpeza em `finally` por `patient_id`.
 */
import { test, expect } from '@playwright/test';
import { insertTestPatient, cleanupTestPatient } from '../helpers/db-test-helper';
import {
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, type MockUser,
} from '../helpers/abac-stack-helper';
import { LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const COM_UID = `qa.sim.encuadre-aba.com.${RUN_ID}`;
const SEM_UID = `qa.sim.encuadre-aba.sem.${RUN_ID}`;
const STAFF_COM: MockUser = { uid: COM_UID, email: `${COM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };
const STAFF_SEM: MockUser = { uid: SEM_UID, email: `${SEM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };

/** As células mínimas para abrir a ficha (identidade) — nenhuma delas gata a aba Encuadre. */
const BASE_READ_CELLS: Array<[string, string]> = [
  ['patient', 'read'],
  ['patient_identity', 'read'],
];
const TAB_CELL = 'patient_services:read';

interface AuthzBody { enforcement?: string; permissions?: string[] }

function hasTabCell(b: AuthzBody | null): boolean {
  return Array.isArray(b?.permissions) && b.permissions.includes(TAB_CELL);
}

test.describe('encuadre-tab-sem-celula sob engine ligado @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(180_000);

  test('encuadre-tab-sem-celula', async ({ page, request, browser }) => {
    let groupComId = '';
    let groupSemId = '';
    let patientId = '';
    try {
      ({ groupId: groupComId } = seedStaffInGroup({
        uid: COM_UID, email: STAFF_COM.email, groupName: `EncuadreAba COM ${RUN_ID}`, country: 'AR',
      }));
      ({ groupId: groupSemId } = seedStaffInGroup({
        uid: SEM_UID, email: STAFF_SEM.email, groupName: `EncuadreAba SEM ${RUN_ID}`, country: 'AR',
      }));
      for (const [resource, action] of BASE_READ_CELLS) {
        grantCell(groupComId, resource, action);
        grantCell(groupSemId, resource, action);
      }
      grantCell(groupComId, 'patient_services', 'read');

      const com = await pollAuthz(request, STAFF_COM, (b: AuthzBody) => b?.enforcement === 'on' && hasTabCell(b));
      const sem = await pollAuthz(request, STAFF_SEM, (b: AuthzBody) => b?.enforcement === 'on' && Array.isArray(b?.permissions));
      expect(com.body?.enforcement, 'COM: engine ligado no contrato').toBe('on');
      expect(hasTabCell(com.body), 'COM: tem patient_services:read').toBe(true);
      expect(sem.body?.enforcement, 'SEM: engine ligado no contrato').toBe('on');
      expect(hasTabCell(sem.body), 'SEM: sem patient_services:read').toBe(false);

      const seeded = insertTestPatient({
        withAddress: true, insuranceInformed: 'OSDE', firstName: 'EncuadreAbaSemCelula', lastName: `Seed-${RUN_ID}`,
      });
      patientId = seeded.patientId;

      // SEM: a ficha abre (patient:read/patient_identity:read), mas "Encuadre" não está no tablist.
      await loginAs(page, STAFF_SEM);
      const detailLoadedSem = page.waitForResponse(
        (r) => r.request().method() === 'GET' && new RegExp(`/api/admin/patients/${patientId}(\\?|$)`).test(r.url()),
        { timeout: 20_000 },
      );
      await page.goto(`/admin/patients/${patientId}`);
      await detailLoadedSem;
      await expect(page.getByTestId('patient-profile-tabs')).toBeVisible({ timeout: 15_000 });
      const semTabButton = page.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Encuadre' });
      await expect(semTabButton).toHaveCount(0);
      const semTabCount = await semTabButton.count();

      // COM (controle positivo): mesma tela, contexto novo — a aba aparece e o conteúdo monta.
      const ctx = await browser.newContext({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
      try {
        const pageCom = await ctx.newPage();
        await loginAs(pageCom, STAFF_COM);
        const detailLoadedCom = pageCom.waitForResponse(
          (r) => r.request().method() === 'GET' && new RegExp(`/api/admin/patients/${patientId}(\\?|$)`).test(r.url()),
          { timeout: 20_000 },
        );
        await pageCom.goto(`/admin/patients/${patientId}`);
        await detailLoadedCom;
        const comTabButton = pageCom.getByTestId('patient-profile-tabs').getByRole('button', { name: 'Encuadre' });
        await expect(comTabButton).toBeVisible({ timeout: 15_000 });
        await comTabButton.click();
        await expect(pageCom.getByTestId('encuadre-tab')).toBeVisible({ timeout: 15_000 });
        const comTabCount = await comTabButton.count();
        console.log('[encuadre-aba]', semTabCount, comTabCount, com.elapsedMs >= 0, sem.elapsedMs >= 0);
      } finally {
        await ctx.close();
      }
    } finally {
      if (patientId) cleanupTestPatient(patientId);
      cleanupStaffAndGroup(COM_UID, groupComId);
      cleanupStaffAndGroup(SEM_UID, groupSemId);
    }
  });
});
