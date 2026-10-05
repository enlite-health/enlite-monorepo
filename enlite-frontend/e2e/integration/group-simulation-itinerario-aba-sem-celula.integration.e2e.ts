/**
 * group-simulation-itinerario-aba-sem-celula.integration.e2e.ts @integration — Fase 12
 * (cadeia-paciente-vacante-itinerario), P33 — critério 6, DX-12.4, Q-EX-12.6.
 *
 * Sem `patient_itinerary:update`, a aba "Itinerario" aparece (a leitura é `patient_services:read`)
 * e o "Asignar prestador" do slot sem cobertura NÃO aparece; com a célula, aparece (controle
 * positivo, mesma tela, mesma execução). O `ActionButton` só esconde com `enforcement === 'on'`
 * (`useCellAccess.ts`, `useActionGate`) — por isso este spec roda com o engine ABAC de verdade
 * LIGADO, e o CAMINHO casa `group-simulation` do job engine ON (`_frontend-integration.yml:598`,
 * workflow intocado; molde `group-simulation-itinerario-celula`, Fase 11). No job padrão (engine
 * OFF) ele não entra: o botão nunca esconderia.
 *
 * Contas por `seedStaffInGroup`/`grantCell` (`abac-stack-helper.ts`), `role: 'recruiter'`,
 * `country: 'AR'` — nunca `role: 'admin'` sem grupo (403 `account_not_active` sob engine
 * ligado). Células concedidas ANTES do 1º request (cache do ABAC); `pollAuthz` confirma o contrato
 * (`enforcement: 'on'` e a presença/ausência da célula) antes de abrir a tela. Nenhum mock de
 * `/v1/me/authz` — o interceptor só troca o Authorization, a resposta é a real.
 *
 * Semente por SQL (o token `role: 'admin'` dos helpers de API dá 403 sob engine ligado):
 * `insertTestPatient` + `seedServiceWithLiveVacancySql` + `insertTestWorker` + `insertWJA(…
 * 'QUICK_RESPONSE_TEAM')`; o slot por `postSlotApi` com o token COM. Um `test`, sem modo serial;
 * limpeza em `finally` por `patient_id`. Imprime `[12.6]` só com contagens.
 */
import { test, expect } from '@playwright/test';
import { insertTestPatient, insertTestWorker, cleanupTestPatient, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import {
  tokenFor, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, pollAuthz, type MockUser,
} from '../helpers/abac-stack-helper';
import { postSlotApi, seedServiceWithLiveVacancySql, cleanupItineraryWrite } from '../helpers/itinerario-escrita-e2e-helper';
import { LANCAMENTO_VIEWPORT_ES_AR } from '../helpers/lancamento-e2e-helper';
import { openItineraryTab, ITINERARY_TAB_LABEL } from '../helpers/itinerario-aba-e2e-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const COM_UID = `qa.sim.itinerario-aba.com.${RUN_ID}`;
const SEM_UID = `qa.sim.itinerario-aba.sem.${RUN_ID}`;
const STAFF_COM: MockUser = { uid: COM_UID, email: `${COM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };
const STAFF_SEM: MockUser = { uid: SEM_UID, email: `${SEM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };

/** As células mínimas para abrir a ficha e ler o itinerário (medidas no P33). */
const READ_CELLS: Array<[string, string]> = [
  ['patient', 'read'],
  ['patient_identity', 'read'],
  ['patient_services', 'read'],
];
const ACTION_CELL = 'patient_itinerary:update';

interface SlotData { id?: string }
interface AuthzBody { enforcement?: string; permissions?: string[] }

function hasActionCell(b: AuthzBody | null): boolean {
  return Array.isArray(b?.permissions) && b.permissions.includes(ACTION_CELL);
}

test.describe('itinerario-aba-sem-celula sob engine ligado @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  test.setTimeout(180_000);

  test('itinerario-aba-sem-celula', async ({ page, request, browser }) => {
    let groupComId = '';
    let groupSemId = '';
    let patientId = '';
    let workerId = '';
    let vacancyId = '';
    try {
      ({ groupId: groupComId } = seedStaffInGroup({
        uid: COM_UID, email: STAFF_COM.email, groupName: `ItinAba COM ${RUN_ID}`, country: 'AR',
      }));
      ({ groupId: groupSemId } = seedStaffInGroup({
        uid: SEM_UID, email: STAFF_SEM.email, groupName: `ItinAba SEM ${RUN_ID}`, country: 'AR',
      }));
      for (const [resource, action] of READ_CELLS) {
        grantCell(groupComId, resource, action);
        grantCell(groupSemId, resource, action);
      }
      grantCell(groupComId, 'patient_itinerary', 'update');

      const com = await pollAuthz(request, STAFF_COM, (b: AuthzBody) => b?.enforcement === 'on' && hasActionCell(b));
      const sem = await pollAuthz(request, STAFF_SEM, (b: AuthzBody) => b?.enforcement === 'on' && Array.isArray(b?.permissions));
      expect(com.body?.enforcement, 'COM: engine ligado no contrato').toBe('on');
      expect(hasActionCell(com.body), 'COM: tem patient_itinerary:update').toBe(true);
      expect(sem.body?.enforcement, 'SEM: engine ligado no contrato').toBe('on');
      expect(hasActionCell(sem.body), 'SEM: sem patient_itinerary:update').toBe(false);

      const seeded = insertTestPatient({
        withAddress: true, insuranceInformed: 'OSDE', firstName: 'ItinAbaSemCelula', lastName: `Seed-${RUN_ID}`,
      });
      patientId = seeded.patientId;
      const svc = seedServiceWithLiveVacancySql(patientId, seeded.addressId!);
      vacancyId = svc.vacancyId;
      workerId = insertTestWorker({ occupation: 'AT' });
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const slot = await postSlotApi(request, tokenFor(STAFF_COM), patientId, svc.serviceId, {
        weekday: 1, startTime: '08:00', endTime: '12:00',
      });
      expect(slot.status, 'semente: POST slot com COM').toBe(201);
      const slotId = (slot.body.data as SlotData | undefined)?.id;
      if (!slotId) throw new Error('itinerario-aba-sem-celula: slot criado sem id');

      // SEM: a aba aparece, a tela carregou (o chip do slot), e o "Asignar prestador" não.
      await loginAs(page, STAFF_SEM);
      await openItineraryTab(page, patientId);
      await expect(
        page.getByTestId('patient-profile-tabs').getByRole('button', { name: ITINERARY_TAB_LABEL }),
      ).toBeVisible();
      await expect(page.getByTestId(`itinerario-slot-horario-${slotId}`)).toBeVisible();
      const semActions = page.getByTestId(/^itinerario-slot-editar-/);
      await expect(semActions).toHaveCount(0);
      const semCount = await semActions.count();
      // Fase 3: o "Itinerario listo" (`patient_itinerary:update`) também SOME para quem não tem a célula —
      // a tela carregou (o chip do slot acima), então o 0 não é "ainda não montou".
      await expect(page.getByTestId('itinerario-montar')).toHaveCount(0);

      // COM (controle positivo): mesma tela, contexto novo — a ação aparece no slot sem cobertura.
      const ctx = await browser.newContext({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
      try {
        const pageCom = await ctx.newPage();
        await loginAs(pageCom, STAFF_COM);
        await openItineraryTab(pageCom, patientId);
        await expect(pageCom.getByTestId(`itinerario-slot-horario-${slotId}`)).toBeVisible();
        const comActions = pageCom.getByTestId(/^itinerario-slot-editar-/);
        await expect(comActions).toHaveCount(1);
        const comCount = await comActions.count();
        // Fase 3, controle positivo: COM vê o "Itinerario listo" (paciente ainda não montado) — o 0 do SEM vem da célula.
        await expect(pageCom.getByTestId('itinerario-montar')).toHaveCount(1);
        console.log('[12.6]', semCount, comCount, com.elapsedMs >= 0, sem.elapsedMs >= 0);
      } finally {
        await ctx.close();
      }
    } finally {
      if (patientId) cleanupItineraryWrite(patientId);
      if (workerId && vacancyId) cleanupWJAAndEncuadre(workerId, vacancyId);
      if (workerId) cleanupTestWorker(workerId);
      if (patientId) cleanupTestPatient(patientId);
      cleanupStaffAndGroup(COM_UID, groupComId);
      cleanupStaffAndGroup(SEM_UID, groupSemId);
    }
  });
});
