/**
 * kanban-pacientes-itinerario-escrita.integration.e2e.ts @integration — Fase 11
 * (cadeia-paciente-vacante-itinerario), DX-11.11.
 *
 * Front NÃO entra — só API real (Playwright `request`) + Postgres real. Esta fase não tem tela (a
 * tela é a Fase 12): zero `page.*`. Semente por API real (`seedLaunchablePatient`,
 * `activateRecruitmentViaApi`, `createServiceViaApi`) e por SQL só onde nenhum escritor de API
 * cobre ainda (2º endereço, worker, candidatura, serviço sem endereço/com vaga viva). Toda escrita
 * DESTA fase (slot, alocação, montado) pela API nova (`itinerario-escrita-e2e-helper.ts`) — SQL só
 * semeia o que não é da fase, ou lê de volta para conferir.
 *
 * Nome do ARQUIVO: sem o "pode" do Gabriel para `pr-gate.yml` nesta sessão (Q-11.4), aplica o
 * mesmo fallback da Fase 10 — o caminho casa o termo `kanban-pacientes` que já está no `grep:` do
 * job padrão (`pr-gate.yml:142`); os títulos continuam `itinerario-…`.
 *
 * 9 títulos (DX-11.11): `itinerario-gate-recusa`, `itinerario-sobreposicao-recusa`,
 * `itinerario-folga-recusa`, `itinerario-folga-aceita`, `itinerario-sobreposicao-concorrente`,
 * `itinerario-aloca-e-remove-c`, `itinerario-montado-incompleto`, `itinerario-slot-cria-edita-encerra`,
 * `itinerario-slot-sem-endereco`.
 */
import { test, expect } from '@playwright/test';
import {
  seedLaunchablePatient, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR,
} from '../helpers/lancamento-e2e-helper';
import {
  activateRecruitmentViaApi, readItineraryApi, createServiceViaApi, ITINERARIO_STAFF,
} from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, getWjaByWorkerAndJob, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { readServiceTeamApi, postServiceTeamAction } from '../helpers/quadro-c-e2e-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import {
  allocationOptionsApi, allocateApi, endAllocationApi, cleanupItineraryWrite, patientStatus,
  insertSecondAddress, countActiveAllocations, postSlotApi, patchSlotApi, endSlotApi, assembleApi,
  insertServiceNoAddressSql, extractUuid,
} from '../helpers/itinerario-escrita-e2e-helper';

interface AllocationOptionRow { workerId: string }
interface AllocationOptionsData { options: AllocationOptionRow[] }
interface AllocateData { allocationId: string }

test.describe('itinerario-escrita @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  useLancamentoStaff(mockAdminUserFor('itinerario-escrita'), 'E2E Itinerario Escrita');

  test('itinerario-gate-recusa', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const v = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const token = tokenFor(ITINERARIO_STAFF);
    const itin = await readItineraryApi(request, seed.patientId);
    const svc = itin.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId);
    const slotId = svc?.slots[0]?.id;
    if (!slotId) throw new Error('itinerario-gate-recusa: slot do serviço não encontrado no itinerário');

    const w1 = insertTestWorker({ occupation: 'AT' }); // sem candidatura
    const w2 = insertTestWorker({ occupation: 'AT' }); // WJA SELECTED (quadro B — não entra no C)
    const w3 = insertTestWorker({ occupation: 'AT' }); // QUICK_RESPONSE_TEAM + Rejeitado (C)
    const w4 = insertTestWorker({ occupation: 'AT' }); // QUICK_RESPONSE_TEAM + já alocado no slot
    const w5 = insertTestWorker({ occupation: 'AT' }); // QUICK_RESPONSE_TEAM — deve poder alocar

    try {
      insertWJA({ workerId: w2, jobPostingId: v, funnelStage: 'SELECTED' });
      insertWJA({ workerId: w3, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const rejectW3 = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId: w3, reasonCategory: 'INDISPONIBILIDADE_DE_HORARIO',
      });
      expect(rejectW3.status).toBe(200);
      insertWJA({ workerId: w4, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const firstAllocW4 = await allocateApi(request, token, seed.patientId, seed.serviceId, slotId, { workerId: w4 });
      expect(firstAllocW4.status).toBe(201);
      insertWJA({ workerId: w5, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const r1 = await allocateApi(request, token, seed.patientId, seed.serviceId, slotId, { workerId: w1 });
      const r2 = await allocateApi(request, token, seed.patientId, seed.serviceId, slotId, { workerId: w2 });
      const r3 = await allocateApi(request, token, seed.patientId, seed.serviceId, slotId, { workerId: w3 });
      const r4 = await allocateApi(request, token, seed.patientId, seed.serviceId, slotId, { workerId: w4 });
      expect(r1.status).toBe(422);
      expect(r1.body.code).toBe('NOT_SELECTED_FOR_SERVICE');
      expect(r2.status).toBe(422);
      expect(r2.body.code).toBe('NOT_SELECTED_FOR_SERVICE');
      expect(r3.status).toBe(422);
      expect(r3.body.code).toBe('NOT_SELECTED_FOR_SERVICE');
      expect(r4.status).toBe(422);
      expect(r4.body.code).toBe('ALREADY_ALLOCATED_IN_SLOT');

      const options = await allocationOptionsApi(request, token, seed.patientId, seed.serviceId);
      expect(options.status).toBe(200);
      const optionIds = ((options.body.data as AllocationOptionsData | undefined)?.options ?? []).map(
        (o) => o.workerId,
      );
      console.log(
        '[11.5]', r1.status, r1.body.code, r2.status, r2.body.code, r3.status, r3.body.code,
        r4.status, r4.body.code, optionIds,
      );
      expect(optionIds).not.toContain(w1);
      expect(optionIds).not.toContain(w2);
      expect(optionIds).not.toContain(w3);
      expect(optionIds).not.toContain(w4);
      expect(optionIds).toContain(w5);

      const r5 = await allocateApi(request, token, seed.patientId, seed.serviceId, slotId, { workerId: w5 });
      expect(r5.status).toBe(201);
      const allocationId = (r5.body.data as AllocateData | undefined)?.allocationId;
      if (!allocationId) throw new Error('itinerario-gate-recusa: alocação de w5 sem allocationId');
      const gravado = runSQL(`select application_id from patient_itinerary_assignment where id = '${allocationId}'`);
      const esperado = getWjaByWorkerAndJob(w5, v)?.id;
      console.log('[11.6]', gravado, esperado);
      expect(gravado).toBe(esperado);
    } finally {
      cleanupItineraryWrite(seed.patientId);
      cleanupWJAAndEncuadre(w2, v);
      cleanupWJAAndEncuadre(w3, v);
      cleanupWJAAndEncuadre(w4, v);
      cleanupWJAAndEncuadre(w5, v);
      cleanupTestWorker(w1);
      cleanupTestWorker(w2);
      cleanupTestWorker(w3);
      cleanupTestWorker(w4);
      cleanupTestWorker(w5);
      seed.cleanup();
    }
  });

  test('itinerario-aloca-e-remove-c', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const v = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const token = tokenFor(ITINERARIO_STAFF);
    const itin = await readItineraryApi(request, seed.patientId);
    const svc = itin.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId);
    const slotId = svc?.slots[0]?.id;
    if (!slotId) throw new Error('itinerario-aloca-e-remove-c: slot do serviço não encontrado no itinerário');

    const w = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId: w, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const statusAntes = patientStatus(seed.patientId);

      const before = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      const beforeSelected = (before.body.data?.selected ?? []).map((m) => m.workerId);

      const alloc = await allocateApi(request, token, seed.patientId, seed.serviceId, slotId, { workerId: w });
      expect(alloc.status).toBe(201);
      const allocationId = (alloc.body.data as AllocateData | undefined)?.allocationId;
      if (!allocationId) throw new Error('itinerario-aloca-e-remove-c: alocação sem allocationId');

      const during = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      const duringInService = (during.body.data?.inService ?? []).map((m) => m.workerId);
      const duringSelected = (during.body.data?.selected ?? []).map((m) => m.workerId);

      const end = await endAllocationApi(request, token, seed.patientId, seed.serviceId, allocationId);
      expect(end.status).toBe(200);

      const after = await readServiceTeamApi(request, seed.patientId, seed.serviceId);
      const afterSelected = (after.body.data?.selected ?? []).map((m) => m.workerId);

      const statusDepois = patientStatus(seed.patientId);

      console.log('[11.13]', beforeSelected, duringInService, duringSelected, afterSelected);
      console.log('[11.14]', statusAntes, statusDepois);

      expect(beforeSelected).toContain(w);
      expect(duringInService).toContain(w);
      expect(duringSelected).not.toContain(w);
      expect(afterSelected).toContain(w);
      expect(statusDepois).toBe(statusAntes);
    } finally {
      cleanupItineraryWrite(seed.patientId);
      cleanupWJAAndEncuadre(w, v);
      cleanupTestWorker(w);
      seed.cleanup();
    }
  });

  test('itinerario-sobreposicao-recusa', async ({ request }) => {
    const seedX = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const addressB = insertSecondAddress(seedX.patientId);
    const s2 = await createServiceViaApi(request, seedX.patientId, {
      addressId: addressB, schedule: [{ dayOfWeek: 1, startTime: '10:00', endTime: '14:00' }],
    });
    const seedY = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.61, lng: -58.41 });
    const sY = await createServiceViaApi(request, seedY.patientId, {
      addressId: seedY.addressId, schedule: [{ dayOfWeek: 1, startTime: '10:00', endTime: '14:00' }],
    });

    const token = tokenFor(ITINERARIO_STAFF);
    const v1 = await activateRecruitmentViaApi(request, seedX.patientId, seedX.serviceId);
    const v2 = await activateRecruitmentViaApi(request, seedX.patientId, s2);
    const vY = await activateRecruitmentViaApi(request, seedY.patientId, sY);

    const itinX = await readItineraryApi(request, seedX.patientId);
    const slot1 = itinX.body.data?.services.find((s) => s.contractedServiceId === seedX.serviceId)?.slots[0]?.id;
    const slot2 = itinX.body.data?.services.find((s) => s.contractedServiceId === s2)?.slots[0]?.id;
    const itinY = await readItineraryApi(request, seedY.patientId);
    const slotY = itinY.body.data?.services.find((s) => s.contractedServiceId === sY)?.slots[0]?.id;
    if (!slot1 || !slot2 || !slotY) {
      throw new Error('itinerario-sobreposicao-recusa: slot ausente na semente');
    }

    const w = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId: w, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: v2, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: vY, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const r1 = await allocateApi(request, token, seedX.patientId, seedX.serviceId, slot1, { workerId: w });
      expect(r1.status).toBe(201);
      const r2 = await allocateApi(request, token, seedX.patientId, s2, slot2, { workerId: w });
      const r3 = await allocateApi(request, token, seedY.patientId, sY, slotY, { workerId: w });
      expect(r2.status).toBe(409);
      expect(r3.status).toBe(409);
      expect(String(r2.body.error ?? '')).toContain('08:00-12:00');
      expect(String(r2.body.error ?? '')).toContain('10:00-14:00');
      expect(String(r3.body.error ?? '')).toContain('08:00-12:00');
      expect(String(r3.body.error ?? '')).toContain('10:00-14:00');

      const activeCount = countActiveAllocations(w);

      // Critério 16: nenhum termo clínico nos corpos dos 409 — controle Q-EX-11.6 prova que o grep
      // acharia se existisse (string de teste, sem dado real).
      const joined = `${JSON.stringify(r2.body)} ${JSON.stringify(r3.body)}`;
      const clinicMatches = (joined.match(/diagnos|clinic/gi) ?? []).length;
      const controlText = 'diagnostico clinico de control (Q-EX-11.6)';
      const controlMatches = (controlText.match(/diagnos|clinic/gi) ?? []).length;

      // Nome do paciente Y (lido só para comparar, nunca colado no log — só a contagem sai).
      const yName = runSQL(`SELECT first_name || ' ' || last_name FROM patients WHERE id = '${seedY.patientId}'`);
      const nameLeaks = yName ? joined.split(yName).length - 1 : 0;

      console.log('[11.7]', r1.status, r2.status, r3.status, activeCount);
      console.log('[11.16]', clinicMatches, controlMatches, nameLeaks);

      expect(activeCount).toBe(1);
      expect(clinicMatches).toBe(0);
      expect(controlMatches).toBeGreaterThan(0);
      expect(nameLeaks).toBe(0);
    } finally {
      cleanupItineraryWrite(seedX.patientId);
      cleanupItineraryWrite(seedY.patientId);
      cleanupWJAAndEncuadre(w, v1);
      cleanupWJAAndEncuadre(w, v2);
      cleanupWJAAndEncuadre(w, vY);
      cleanupTestWorker(w);
      seedX.cleanup();
      seedY.cleanup();
    }
  });

  test('itinerario-folga-recusa', async ({ request }) => {
    const seedX = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const seedY = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.62, lng: -58.42 });
    const sY = await createServiceViaApi(request, seedY.patientId, {
      addressId: seedY.addressId,
      schedule: [
        { dayOfWeek: 1, startTime: '12:30', endTime: '16:00' },
        { dayOfWeek: 1, startTime: '12:00', endTime: '16:00' },
      ],
    });

    const token = tokenFor(ITINERARIO_STAFF);
    const v1 = await activateRecruitmentViaApi(request, seedX.patientId, seedX.serviceId);
    const vY = await activateRecruitmentViaApi(request, seedY.patientId, sY);

    const itinX = await readItineraryApi(request, seedX.patientId);
    const slot1 = itinX.body.data?.services.find((s) => s.contractedServiceId === seedX.serviceId)?.slots[0]?.id;
    const itinY = await readItineraryApi(request, seedY.patientId);
    const svcY = itinY.body.data?.services.find((s) => s.contractedServiceId === sY);
    const slotY1230 = svcY?.slots.find((sl) => sl.startTime === '12:30')?.id;
    const slotY1200 = svcY?.slots.find((sl) => sl.startTime === '12:00')?.id;
    if (!slot1 || !slotY1230 || !slotY1200) {
      throw new Error('itinerario-folga-recusa: slot ausente na semente');
    }

    const w = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId: w, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: vY, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const r1 = await allocateApi(request, token, seedX.patientId, seedX.serviceId, slot1, { workerId: w });
      expect(r1.status).toBe(201);

      const r2 = await allocateApi(request, token, seedY.patientId, sY, slotY1230, { workerId: w });
      expect(r2.status).toBe(409);
      expect(r2.body.minGapMinutes).not.toBeNull();
      expect(r2.body.minGapMinutes).not.toBeUndefined();

      const r3 = await allocateApi(request, token, seedY.patientId, sY, slotY1200, { workerId: w });
      expect(r3.status).toBe(409);

      const activeCount = countActiveAllocations(w);
      console.log('[11.8]', r1.status, r2.status, r2.body.minGapMinutes, r3.status, activeCount);
      expect(activeCount).toBe(1);
    } finally {
      cleanupItineraryWrite(seedX.patientId);
      cleanupItineraryWrite(seedY.patientId);
      cleanupWJAAndEncuadre(w, v1);
      cleanupWJAAndEncuadre(w, vY);
      cleanupTestWorker(w);
      seedX.cleanup();
      seedY.cleanup();
    }
  });

  test('itinerario-folga-aceita', async ({ request }) => {
    const seedX = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const seedY = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.63, lng: -58.43 });
    const s3 = await createServiceViaApi(request, seedX.patientId, {
      addressId: seedX.addressId, schedule: [{ dayOfWeek: 1, startTime: '17:00', endTime: '20:00' }],
    });
    const s2 = await createServiceViaApi(request, seedY.patientId, {
      addressId: seedY.addressId,
      schedule: [
        { dayOfWeek: 1, startTime: '13:00', endTime: '16:00' },
        { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' },
      ],
    });

    const token = tokenFor(ITINERARIO_STAFF);
    const v1 = await activateRecruitmentViaApi(request, seedX.patientId, seedX.serviceId);
    const v3 = await activateRecruitmentViaApi(request, seedX.patientId, s3);
    const v2 = await activateRecruitmentViaApi(request, seedY.patientId, s2);

    const itinX = await readItineraryApi(request, seedX.patientId);
    const slot1 = itinX.body.data?.services.find((s) => s.contractedServiceId === seedX.serviceId)?.slots[0]?.id;
    const slot3 = itinX.body.data?.services.find((s) => s.contractedServiceId === s3)?.slots[0]?.id;
    const itinY = await readItineraryApi(request, seedY.patientId);
    const svc2 = itinY.body.data?.services.find((s) => s.contractedServiceId === s2);
    const slot2Mon = svc2?.slots.find((sl) => sl.weekday === 1)?.id;
    const slot2Tue = svc2?.slots.find((sl) => sl.weekday === 2)?.id;
    if (!slot1 || !slot3 || !slot2Mon || !slot2Tue) {
      throw new Error('itinerario-folga-aceita: slot ausente na semente');
    }

    const w = insertTestWorker({ occupation: 'AT' });
    const w2 = insertTestWorker({ occupation: 'AT' }); // critério 9 literal: mesmo endereço X, encostado (12:00) — aceita
    try {
      insertWJA({ workerId: w, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: v2, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: v3, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w2, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w2, jobPostingId: v3, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const r1 = await allocateApi(request, token, seedX.patientId, seedX.serviceId, slot1, { workerId: w });
      const r2 = await allocateApi(request, token, seedY.patientId, s2, slot2Mon, { workerId: w });
      const r3 = await allocateApi(request, token, seedX.patientId, s3, slot3, { workerId: w });
      const r4 = await allocateApi(request, token, seedY.patientId, s2, slot2Tue, { workerId: w });

      const activeCount = countActiveAllocations(w);
      console.log('[11.9]', r1.status, r2.status, r3.status, r4.status, activeCount);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r3.status).toBe(201);
      expect(r4.status).toBe(201);
      expect(activeCount).toBe(4);

      // Critério 9, caso literal (o worker W2 encosta duas faixas no MESMO endereço X: 08-12 em S1
      // termina exatamente onde 12-16 em S3 começa — sem folga exigida, porque a folga só vale
      // ENTRE endereços diferentes). Não reusa slot1/slot3 do worker W (acima) — outro prestador no
      // mesmo slot pode (uq_pia_open_pair é por par slot+worker); e S3 ganha uma 2ª faixa própria.
      const slot3Encostado = await postSlotApi(request, token, seedX.patientId, s3, {
        weekday: 1, startTime: '12:00', endTime: '16:00',
      });
      expect(slot3Encostado.status).toBe(201);
      const slot3EncostadoId = (slot3Encostado.body.data as { id?: string } | undefined)?.id;
      if (!slot3EncostadoId) throw new Error('itinerario-folga-aceita: slot encostado de S3 sem id');

      const r5 = await allocateApi(request, token, seedX.patientId, seedX.serviceId, slot1, { workerId: w2 });
      const r6 = await allocateApi(request, token, seedX.patientId, s3, slot3EncostadoId, { workerId: w2 });
      const activeCountW2 = countActiveAllocations(w2);
      console.log('[11.9-encostado]', r5.status, r6.status, activeCountW2);
      expect(r5.status).toBe(201);
      expect(r6.status).toBe(201);
      expect(activeCountW2).toBe(2);
    } finally {
      cleanupItineraryWrite(seedX.patientId);
      cleanupItineraryWrite(seedY.patientId);
      cleanupWJAAndEncuadre(w, v1);
      cleanupWJAAndEncuadre(w, v2);
      cleanupWJAAndEncuadre(w, v3);
      cleanupWJAAndEncuadre(w2, v1);
      cleanupWJAAndEncuadre(w2, v3);
      cleanupTestWorker(w);
      cleanupTestWorker(w2);
      seedX.cleanup();
      seedY.cleanup();
    }
  });

  test('itinerario-sobreposicao-concorrente', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const addressB = insertSecondAddress(seed.patientId);
    const s2 = await createServiceViaApi(request, seed.patientId, {
      addressId: addressB, schedule: [{ dayOfWeek: 1, startTime: '10:00', endTime: '14:00' }],
    });

    const token = tokenFor(ITINERARIO_STAFF);
    const v1 = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const v2 = await activateRecruitmentViaApi(request, seed.patientId, s2);

    const itin = await readItineraryApi(request, seed.patientId);
    const slot1 = itin.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId)?.slots[0]?.id;
    const slot2 = itin.body.data?.services.find((s) => s.contractedServiceId === s2)?.slots[0]?.id;
    if (!slot1 || !slot2) {
      throw new Error('itinerario-sobreposicao-concorrente: slot ausente na semente');
    }

    const w = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId: w, jobPostingId: v1, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: v2, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const [res1, res2] = await Promise.all([
        allocateApi(request, token, seed.patientId, seed.serviceId, slot1, { workerId: w }),
        allocateApi(request, token, seed.patientId, s2, slot2, { workerId: w }),
      ]);

      const activeCount = countActiveAllocations(w);
      console.log('[11.12]', res1.status, res2.status, activeCount);
      // Promise.all não garante ordem: quem pega o pg_advisory_xact_lock primeiro varia entre
      // rodadas. A asserção é sobre o CONJUNTO ordenado (sort), nunca por posição — e o 409 é lido
      // da resposta que de fato o devolveu, não de um índice fixo.
      expect([res1.status, res2.status].sort((a, b) => a - b)).toEqual([201, 409]);
      const conflicted = res1.status === 409 ? res1 : res2;
      expect(conflicted.body.code).toBe('ITINERARY_OVERLAP');
      expect(activeCount).toBe(1);
    } finally {
      cleanupItineraryWrite(seed.patientId);
      cleanupWJAAndEncuadre(w, v1);
      cleanupWJAAndEncuadre(w, v2);
      cleanupTestWorker(w);
      seed.cleanup();
    }
  });

  test('itinerario-montado-incompleto', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const addressB = insertSecondAddress(seed.patientId);
    // `activate-recruitment` exige SERVICE_SCHEDULE (regra de fase anterior) — S2 nasce COM 1 faixa
    // só para poder ativar a vaga, e o slot único é encerrado logo abaixo: vaga viva SEM slot ativo
    // é o cenário do critério 15 (serviço sem slot não é "serviço sem schedule nunca criado").
    const s2 = await createServiceViaApi(request, seed.patientId, {
      addressId: addressB, schedule: [{ dayOfWeek: 5, startTime: '09:00', endTime: '11:00' }],
    });
    const token = tokenFor(ITINERARIO_STAFF);
    await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    await activateRecruitmentViaApi(request, seed.patientId, s2);

    const itinS2 = await readItineraryApi(request, seed.patientId);
    const s2SlotId = itinS2.body.data?.services.find((s) => s.contractedServiceId === s2)?.slots[0]?.id;
    if (!s2SlotId) throw new Error('itinerario-montado-incompleto: slot inicial de S2 não encontrado');
    const endInitial = await endSlotApi(request, token, seed.patientId, s2, s2SlotId);
    expect(endInitial.status).toBe(200);

    try {
      const before = await assembleApi(request, token, seed.patientId);
      expect(before.status).toBe(422);
      expect(before.body.code).toBe('SERVICE_WITHOUT_SLOT');
      const missing = (before.body.services as Array<{ serviceId: string }> | undefined) ?? [];
      const missingIds = missing.map((m) => m.serviceId);
      expect(missingIds).toContain(s2);
      expect(missingIds).not.toContain(seed.serviceId);

      const slot = await postSlotApi(request, token, seed.patientId, s2, {
        weekday: 5, startTime: '09:00', endTime: '11:00',
      });
      expect(slot.status).toBe(201);

      const after = await assembleApi(request, token, seed.patientId);
      expect(after.status).toBe(201);
      const montadoCount = Number(
        runSQL(`SELECT count(*) FROM patient_itinerary_assembly WHERE patient_id = '${seed.patientId}'`),
      );

      console.log('[11.15]', before.status, missingIds, after.status, montadoCount);
      expect(montadoCount).toBe(1);
    } finally {
      cleanupItineraryWrite(seed.patientId);
      seed.cleanup();
    }
  });

  test('itinerario-slot-cria-edita-encerra', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const token = tokenFor(ITINERARIO_STAFF);
    const v = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const w = insertTestWorker({ occupation: 'AT' });
    try {
      insertWJA({ workerId: w, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const create = await postSlotApi(request, token, seed.patientId, seed.serviceId, {
        weekday: 3, startTime: '14:00', endTime: '18:00',
      });
      expect(create.status).toBe(201);
      const createdId = (create.body.data as { id?: string } | undefined)?.id;
      if (!createdId) throw new Error('itinerario-slot-cria-edita-encerra: slot criado sem id');

      const itinAfterCreate = await readItineraryApi(request, seed.patientId);
      const svcAfterCreate = itinAfterCreate.body.data?.services.find(
        (s) => s.contractedServiceId === seed.serviceId,
      );
      const foundCreated = svcAfterCreate?.slots.find((sl) => sl.id === createdId);
      expect(foundCreated?.active).toBe(true);

      const duplicate = await postSlotApi(request, token, seed.patientId, seed.serviceId, {
        weekday: 3, startTime: '14:00', endTime: '18:00',
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('SLOT_ALREADY_EXISTS');

      // Gate fecho N4: o mesmo 409 SLOT_ALREADY_EXISTS agora também no PATCH — um 2º slot ativo
      // (B, dia diferente) tenta migrar pela chave que A já ocupa. Nenhum dos dois muda de estado.
      const slotB = await postSlotApi(request, token, seed.patientId, seed.serviceId, {
        weekday: 5, startTime: '09:00', endTime: '11:00',
      });
      expect(slotB.status).toBe(201);
      const slotBId = (slotB.body.data as { id?: string } | undefined)?.id;
      if (!slotBId) throw new Error('itinerario-slot-cria-edita-encerra: slot B sem id');

      const patchCollision = await patchSlotApi(request, token, seed.patientId, seed.serviceId, slotBId, {
        weekday: 3, startTime: '14:00', endTime: '18:00',
      });
      console.log('[11.slot-colisao]', patchCollision.status, patchCollision.body.code);
      expect(patchCollision.status).toBe(409);
      expect(patchCollision.body.code).toBe('SLOT_ALREADY_EXISTS');

      const itinAfterCollision = await readItineraryApi(request, seed.patientId);
      const svcAfterCollision = itinAfterCollision.body.data?.services.find(
        (s) => s.contractedServiceId === seed.serviceId,
      );
      const slotAAfterCollision = svcAfterCollision?.slots.find((sl) => sl.id === createdId);
      const slotBAfterCollision = svcAfterCollision?.slots.find((sl) => sl.id === slotBId);
      expect(slotAAfterCollision?.active).toBe(true);
      expect(slotAAfterCollision).toMatchObject({ weekday: 3, startTime: '14:00', endTime: '18:00' });
      expect(slotBAfterCollision?.active).toBe(true);
      expect(slotBAfterCollision).toMatchObject({ weekday: 5, startTime: '09:00', endTime: '11:00' });
      const scheduleAfterCollision = runSQL(
        `SELECT schedule::text FROM patient_contracted_services WHERE id = '${seed.serviceId}'`,
      );
      expect(scheduleAfterCollision).toContain('14:00');
      expect(scheduleAfterCollision).toContain('09:00');

      const patch = await patchSlotApi(request, token, seed.patientId, seed.serviceId, createdId, {
        weekday: 3, startTime: '16:00', endTime: '20:00',
      });
      expect(patch.status).toBe(200);
      const patchedId = (patch.body.data as { id?: string } | undefined)?.id;
      if (!patchedId) throw new Error('itinerario-slot-cria-edita-encerra: slot editado sem id');

      const oldActive = runSQL(
        `SELECT active::text FROM patient_itinerary_slot WHERE contracted_service_id = '${seed.serviceId}' ` +
          `AND weekday = 3 AND start_time = '14:00'`,
      );
      const newActive = runSQL(`SELECT active::text FROM patient_itinerary_slot WHERE id = '${patchedId}'`);
      expect(oldActive).toBe('false');
      expect(newActive).toBe('true');

      const alloc = await allocateApi(request, token, seed.patientId, seed.serviceId, patchedId, { workerId: w });
      expect(alloc.status).toBe(201);
      const allocationId = (alloc.body.data as { allocationId?: string } | undefined)?.allocationId;
      if (!allocationId) throw new Error('itinerario-slot-cria-edita-encerra: alocação sem id');

      const patchBlocked = await patchSlotApi(request, token, seed.patientId, seed.serviceId, patchedId, {
        weekday: 3, startTime: '17:00', endTime: '21:00',
      });
      expect(patchBlocked.status).toBe(422);
      expect(patchBlocked.body.code).toBe('SLOT_HAS_ACTIVE_ALLOCATION');

      const endBlocked = await endSlotApi(request, token, seed.patientId, seed.serviceId, patchedId);
      expect(endBlocked.status).toBe(422);
      expect(endBlocked.body.code).toBe('SLOT_HAS_ACTIVE_ALLOCATION');

      const endAlloc = await endAllocationApi(request, token, seed.patientId, seed.serviceId, allocationId);
      expect(endAlloc.status).toBe(200);

      const endSlot = await endSlotApi(request, token, seed.patientId, seed.serviceId, patchedId);
      expect(endSlot.status).toBe(200);

      const endedActive = runSQL(`SELECT active::text FROM patient_itinerary_slot WHERE id = '${patchedId}'`);
      const scheduleText = runSQL(
        `SELECT schedule::text FROM patient_contracted_services WHERE id = '${seed.serviceId}'`,
      );

      console.log(
        '[11.slot]', create.status, duplicate.status, patch.status, oldActive, newActive, alloc.status,
        patchBlocked.status, endBlocked.status, endAlloc.status, endSlot.status, endedActive,
      );
      expect(endedActive).toBe('false');
      expect(scheduleText).not.toContain('16:00');
    } finally {
      cleanupItineraryWrite(seed.patientId);
      cleanupWJAAndEncuadre(w, v);
      cleanupTestWorker(w);
      seed.cleanup();
    }
  });

  test('itinerario-slot-sem-endereco', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const token = tokenFor(ITINERARIO_STAFF);
    const serviceNoAddr = insertServiceNoAddressSql(seed.patientId);
    const w = insertTestWorker({ occupation: 'AT' });
    try {
      const create = await postSlotApi(request, token, seed.patientId, serviceNoAddr, {
        weekday: 4, startTime: '09:00', endTime: '11:00',
      });
      expect(create.status).toBe(422);
      expect(create.body.code).toBe('SERVICE_WITHOUT_ADDRESS');

      const slotId = extractUuid(
        runSQL(
          `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, end_time, created_by, updated_by) ` +
            `VALUES ('${serviceNoAddr}', 4, '09:00', '11:00', 'e2e-itinerario-p27', 'e2e-itinerario-p27') RETURNING id`,
        ),
      );

      const patch = await patchSlotApi(request, token, seed.patientId, serviceNoAddr, slotId, {
        weekday: 4, startTime: '10:00', endTime: '12:00',
      });
      const end = await endSlotApi(request, token, seed.patientId, serviceNoAddr, slotId);
      const alloc = await allocateApi(request, token, seed.patientId, serviceNoAddr, slotId, { workerId: w });

      console.log(
        '[11.addr]', create.status, create.body.code, patch.status, patch.body.code, end.status,
        end.body.code, alloc.status, alloc.body.code,
      );

      expect(patch.status).toBe(422);
      expect(patch.body.code).toBe('SERVICE_WITHOUT_ADDRESS');
      expect(end.status).toBe(422);
      expect(end.body.code).toBe('SERVICE_WITHOUT_ADDRESS');
      expect(alloc.status).toBe(422);
      expect(alloc.body.code).toBe('SERVICE_WITHOUT_ADDRESS');
    } finally {
      cleanupItineraryWrite(seed.patientId);
      cleanupTestWorker(w);
      seed.cleanup();
    }
  });
});
