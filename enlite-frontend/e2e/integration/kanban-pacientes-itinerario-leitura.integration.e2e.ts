/**
 * kanban-pacientes-itinerario-leitura.integration.e2e.ts @integration
 *
 * P10 (Fase 7, cadeia-paciente-vacante-itinerario) — 5 testes independentes, sem
 * `describe.serial`, todos com `itinerario-leitura` no título (o caminho `kanban-pacientes`
 * já casa o `--grep` do job padrão, `pr-gate.yml:142` — nenhuma mudança de workflow):
 *
 *   `itinerario-leitura` (feliz, critério 6): 1 serviço, `contratadas.weekly=20`/`.authorized=null`,
 *      `cobertas=0`, 1 slot vindo da DERIVAÇÃO (nunca de SQL); depois de gravar 1 alocação `ACTIVE`
 *      (foguete real → worker+WJA por SQL → alocação por SQL, Q-EX-7.6), `cobertas=4` e o slot
 *      devolve o assignment.
 *   `itinerario-leitura-sem-candidatura-recusada` (critério 10): INSERT com `application_id NULL`
 *      é recusado pelo banco; nada entra (`cobertas=0`); controle: com a WJA certa, entra e `cobertas=4`.
 *   `itinerario-leitura-vigencia-vencida`: alocação `ENDED` fora de vigência não soma; um 2º worker
 *      `ACTIVE` com `valid_to` no passado também não soma (vigência é por DATA, não só por status —
 *      gate parcial #5) e aparece com `status: 'ACTIVE'`/`validTo` preenchido; controle: 3º worker
 *      com alocação `ACTIVE` vigente (sem fim) soma 4 (a leitura não devolve 0 sempre).
 *   `itinerario-leitura-servico-sem-horario`: 2º serviço sem `schedule` → `slots: []`, `cobertas=0`;
 *      o serviço da semente segue intacto.
 *   `itinerario-leitura-paciente-inexistente`: `randomUUID()` → 404; `'abc'` → 400.
 *
 * Só `request` (API) — esta fase não tem tela e não fala com canal externo (nenhum `page`,
 * nenhum mock de rota, nenhum print). Helpers: `itinerario-e2e-helper.ts` (novo, P10),
 * `lancamento-e2e-helper.ts` (`seedLaunchablePatient`/`backendUrl`), `db-test-helper.ts`,
 * `wja-test-helper.ts`, `abac-stack-helper.ts`, `vacancy-notes-e2e-helper.ts`.
 */

import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import {
  ITINERARIO_STAFF,
  readItineraryApi,
  activateRecruitmentViaApi,
  createServiceViaApi,
  seedAssignment,
  cleanupItinerary,
} from '../helpers/itinerario-e2e-helper';
import { seedLaunchablePatient } from '../helpers/lancamento-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';

test.describe('kanban-pacientes itinerario leitura @integration', () => {
  test.setTimeout(120_000);

  test.beforeAll(() => {
    seedMockStaff(ITINERARIO_STAFF, 'E2E Itinerario Leitura F7');
  });
  test.afterAll(() => {
    cleanupMockStaff(ITINERARIO_STAFF);
  });

  test('itinerario-leitura', async ({ request }) => {
    // Coordenada própria deste teste (sem match nesta fase — a fase não tem escritor de match).
    const LAT = -45.8641;
    const LNG = -67.4979;

    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });
    let vacancyId = '';
    let workerId = '';
    let applicationId = '';
    try {
      const before = await readItineraryApi(request, patient.patientId);
      expect(before.status, 'GET /itinerary antes da alocação').toBe(200);
      expect(before.body.success).toBe(true);
      const servicesBefore = before.body.data!.services;
      expect(servicesBefore.length, '1 serviço').toBe(1);
      const serviceBefore = servicesBefore[0];
      expect(serviceBefore.contratadas, 'contratadas: weekly=20, authorized=null').toEqual({
        weekly: 20,
        authorized: null,
      });
      expect(serviceBefore.cobertas, 'cobertas antes de qualquer alocação').toBe(0);
      expect(serviceBefore.slots.length, '1 slot — veio da DERIVAÇÃO, não de SQL').toBe(1);
      const slot = serviceBefore.slots[0];
      expect(slot.weekday, 'weekday 1 (segunda)').toBe(1);
      expect(slot.startTime).toBe('08:00');
      expect(slot.endTime).toBe('12:00');
      expect(slot.active).toBe(true);
      expect(slot.assignments).toEqual([]);
      // Nenhum campo de PII (nome/telefone) no corpo — só os 4 campos do contrato.
      expect(Object.keys(serviceBefore).sort()).toEqual(
        ['cobertas', 'contractedServiceId', 'contratadas', 'slots'].sort(),
      );

      vacancyId = await activateRecruitmentViaApi(request, patient.patientId, patient.serviceId);
      workerId = insertTestWorker({ occupation: 'AT' });
      applicationId = insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'INVITED' });
      seedAssignment({ slotId: slot.id, workerId, applicationId, validFromDaysAgo: 7, status: 'ACTIVE' });

      const after = await readItineraryApi(request, patient.patientId);
      expect(after.status).toBe(200);
      const serviceAfter = after.body.data!.services[0];
      expect(serviceAfter.cobertas, 'cobertas depois da alocação ACTIVE (4h/faixa 08-12)').toBe(4);
      expect(serviceAfter.slots[0].assignments.length, '1 assignment no slot').toBe(1);
      const assignment = serviceAfter.slots[0].assignments[0];
      expect(assignment.workerId).toBe(workerId);
      expect(assignment.applicationId).toBe(applicationId);
      expect(assignment.validTo, 'validTo null (vigente sem fim)').toBeNull();
      expect(assignment.status).toBe('ACTIVE');

      console.log('[7.6] itinerario-leitura', {
        patientId: patient.patientId,
        slotId: slot.id,
        workerId,
        applicationId,
        coberasAntes: serviceBefore.cobertas,
        coberasDepois: serviceAfter.cobertas,
        assignments: serviceAfter.slots[0].assignments,
      });
    } finally {
      cleanupItinerary(patient.patientId);
      if (workerId && vacancyId) cleanupWJAAndEncuadre(workerId, vacancyId);
      if (workerId) cleanupTestWorker(workerId);
      patient.cleanup();
    }
  });

  test('itinerario-leitura-sem-candidatura-recusada', async ({ request }) => {
    const LAT = -46.4318;
    const LNG = -67.5262;

    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });
    let vacancyId = '';
    let workerId = '';
    let applicationId = '';
    try {
      const before = await readItineraryApi(request, patient.patientId);
      const slot = before.body.data!.services[0].slots[0];

      vacancyId = await activateRecruitmentViaApi(request, patient.patientId, patient.serviceId);
      workerId = insertTestWorker({ occupation: 'AT' });

      // Critério 10, lado 1: INSERT com application_id NULL — o banco tem de recusar.
      let thrownMessage = '';
      expect(() => {
        try {
          runSQL(
            `INSERT INTO patient_itinerary_assignment ` +
              `(slot_id, worker_id, application_id, valid_from, status, created_by, updated_by) VALUES (` +
              `'${slot.id}', '${workerId}', NULL, ` +
              `(now() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date - 1, 'ACTIVE', ` +
              `'e2e-itinerario-p10', 'e2e-itinerario-p10')`,
          );
        } catch (err) {
          thrownMessage = err instanceof Error ? err.message : String(err);
          throw err;
        }
      }).toThrow(/application_id/);
      console.log('[7.10] itinerario-leitura-sem-candidatura-recusada (mensagem do Postgres)', { thrownMessage });

      const afterRecusa = await readItineraryApi(request, patient.patientId);
      const serviceAfterRecusa = afterRecusa.body.data!.services[0];
      expect(serviceAfterRecusa.cobertas, 'cobertas 0 — nada entrou').toBe(0);
      expect(serviceAfterRecusa.slots[0].assignments, 'assignments vazio — nada entrou').toEqual([]);

      // Controle: com a WJA certa, a alocação entra e cobertas soma 4.
      applicationId = insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'INVITED' });
      seedAssignment({ slotId: slot.id, workerId, applicationId, validFromDaysAgo: 1, status: 'ACTIVE' });
      const afterControle = await readItineraryApi(request, patient.patientId);
      const serviceAfterControle = afterControle.body.data!.services[0];
      expect(serviceAfterControle.cobertas, 'controle: com WJA válida, cobertas 4').toBe(4);

      console.log('[7.10] itinerario-leitura-sem-candidatura-recusada (controle)', {
        patientId: patient.patientId,
        coberasControle: serviceAfterControle.cobertas,
      });
    } finally {
      cleanupItinerary(patient.patientId);
      if (workerId && vacancyId) cleanupWJAAndEncuadre(workerId, vacancyId);
      if (workerId) cleanupTestWorker(workerId);
      patient.cleanup();
    }
  });

  test('itinerario-leitura-vigencia-vencida', async ({ request }) => {
    const LAT = -47.2072;
    const LNG = -67.6997;

    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });
    let vacancyId = '';
    const workerIds: string[] = [];
    try {
      const before = await readItineraryApi(request, patient.patientId);
      const slot = before.body.data!.services[0].slots[0];
      vacancyId = await activateRecruitmentViaApi(request, patient.patientId, patient.serviceId);

      const w1 = insertTestWorker({ occupation: 'AT' });
      workerIds.push(w1);
      const a1 = insertWJA({ workerId: w1, jobPostingId: vacancyId, funnelStage: 'INVITED' });
      seedAssignment({ slotId: slot.id, workerId: w1, applicationId: a1, validFromDaysAgo: 30, validToDaysAgo: 1, status: 'ENDED' });

      const afterEnded = await readItineraryApi(request, patient.patientId);
      const serviceAfterEnded = afterEnded.body.data!.services[0];
      expect(serviceAfterEnded.cobertas, 'alocação ENDED (vencida) não soma').toBe(0);
      const assignment1 = serviceAfterEnded.slots[0].assignments.find((a) => a.workerId === w1);
      expect(assignment1?.status, 'assignment aparece com status ENDED (não some da leitura)').toBe('ENDED');

      // Gate parcial #5: vigência é por DATA, não só por status — um worker ACTIVE com `valid_to`
      // no passado (30 dias atrás a 1 dia atrás) não pode somar `cobertas`. `uq_pia_open_pair` só
      // trava o par (slot,worker) quando `valid_to IS NULL`; com `valid_to` preenchido não colide.
      const w2 = insertTestWorker({ occupation: 'AT' });
      workerIds.push(w2);
      const a2 = insertWJA({ workerId: w2, jobPostingId: vacancyId, funnelStage: 'INVITED' });
      seedAssignment({ slotId: slot.id, workerId: w2, applicationId: a2, validFromDaysAgo: 30, validToDaysAgo: 1, status: 'ACTIVE' });

      const afterActiveExpired = await readItineraryApi(request, patient.patientId);
      const serviceAfterActiveExpired = afterActiveExpired.body.data!.services[0];
      expect(serviceAfterActiveExpired.cobertas, 'ACTIVE com valid_to vencido não soma (vigência por DATA)').toBe(0);
      const assignment2 = serviceAfterActiveExpired.slots[0].assignments.find((a) => a.workerId === w2);
      expect(assignment2?.status, 'assignment aparece com status ACTIVE (não é o status que decide)').toBe('ACTIVE');
      expect(assignment2?.validTo, 'validTo preenchido (vencido, não null)').not.toBeNull();

      // Controle: 3º worker com alocação ACTIVE vigente (sem fim) soma 4 (a leitura não devolve 0 sempre).
      const w3 = insertTestWorker({ occupation: 'AT' });
      workerIds.push(w3);
      const a3 = insertWJA({ workerId: w3, jobPostingId: vacancyId, funnelStage: 'INVITED' });
      seedAssignment({ slotId: slot.id, workerId: w3, applicationId: a3, validFromDaysAgo: 1, status: 'ACTIVE' });

      const afterActive = await readItineraryApi(request, patient.patientId);
      const serviceAfterActive = afterActive.body.data!.services[0];
      expect(serviceAfterActive.cobertas, 'controle: alocação ACTIVE vigente soma 4').toBe(4);

      console.log('[7.6] itinerario-leitura-vigencia-vencida', {
        patientId: patient.patientId,
        endedCobertas: serviceAfterEnded.cobertas,
        endedStatus: assignment1?.status,
        activeExpiredCobertas: serviceAfterActiveExpired.cobertas,
        activeExpiredStatus: assignment2?.status,
        activeExpiredValidTo: assignment2?.validTo,
        activeCobertas: serviceAfterActive.cobertas,
      });
    } finally {
      cleanupItinerary(patient.patientId);
      for (const w of workerIds) {
        if (vacancyId) cleanupWJAAndEncuadre(w, vacancyId);
        cleanupTestWorker(w);
      }
      patient.cleanup();
    }
  });

  test('itinerario-leitura-servico-sem-horario', async ({ request }) => {
    const LAT = -48.0128;
    const LNG = -67.8324;

    const patient = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: LAT, lng: LNG });
    try {
      const newServiceId = await createServiceViaApi(request, patient.patientId, {
        serviceCode: 'AT',
        weeklyHours: 12,
        addressId: patient.addressId,
      });

      const res = await readItineraryApi(request, patient.patientId);
      expect(res.status).toBe(200);
      const services = res.body.data!.services;
      expect(services.length, '2 serviços no mesmo paciente').toBe(2);

      const withoutSchedule = services.find((s) => s.contractedServiceId === newServiceId);
      const withSchedule = services.find((s) => s.contractedServiceId === patient.serviceId);
      expect(withoutSchedule, 'serviço novo (sem schedule) presente na resposta').toBeTruthy();
      expect(withoutSchedule?.slots, 'serviço sem horário: slots vazio').toEqual([]);
      expect(withoutSchedule?.cobertas, 'serviço sem horário: cobertas 0').toBe(0);
      expect(withSchedule?.slots.length, 'serviço da semente segue com 1 slot').toBe(1);

      console.log('[7.6] itinerario-leitura-servico-sem-horario', {
        patientId: patient.patientId,
        newServiceId,
        seedServiceId: patient.serviceId,
        services: services.map((s) => ({ id: s.contractedServiceId, slots: s.slots.length })),
      });
    } finally {
      cleanupItinerary(patient.patientId);
      patient.cleanup();
    }
  });

  test('itinerario-leitura-paciente-inexistente', async ({ request }) => {
    const notFound = await readItineraryApi(request, randomUUID());
    expect(notFound.status, '404 para paciente inexistente').toBe(404);
    expect(notFound.body.code, 'code NOT_FOUND').toBe('NOT_FOUND');

    const badRequest = await readItineraryApi(request, 'abc');
    expect(badRequest.status, '400 para id inválido (não é UUID)').toBe(400);
    expect(badRequest.body.error, 'error Invalid params').toBe('Invalid params');

    console.log('[7.6] itinerario-leitura-paciente-inexistente', {
      notFoundStatus: notFound.status,
      notFoundCode: notFound.body.code,
      badRequestStatus: badRequest.status,
      badRequestError: badRequest.body.error,
    });
  });
});
