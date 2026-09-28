/**
 * kanban-pacientes-substituicao.integration.e2e.ts @integration — Fase 13 (cadeia-paciente-vacante-itinerario),
 * DX-13.15.
 *
 * 1 spec, 7 títulos (API + tela), datas SEMPRE do banco (DATA-F13, nunca o relógio do runner).
 *
 * Nome do ARQUIVO: sem tocar `pr-gate.yml` — o caminho casa `kanban-pacientes` já presente no
 * `grep:` do job padrão (`pr-gate.yml:142`), o mesmo fallback das Fases 10/11. Os títulos dos
 * testes continuam `substituicao-…`.
 *
 * Semente reusada (nunca copiada): `seedLaunchablePatient` (serviço AT segunda 08-12, 1 slot) →
 * `activateRecruitmentViaApi` → `insertTestWorker({ occupation: 'AT' })` → `insertWJA(…
 * 'QUICK_RESPONSE_TEAM')` → titular alocado pela API da Fase 11 (`allocateApi`). Toda escrita
 * DESTA fase pela API nova (`registerAbsenceApi`/`setAbsenceSubstituteApi`/`cancelAbsenceApi`),
 * salvo a ausência em data PASSADA (`insertPastAbsenceSql`, Q-EX-13.3 — a API a recusa por
 * desenho). `finally` por teste: `cleanupSubstituicao` → `cleanupWJAAndEncuadre` →
 * `cleanupTestWorker` → `seed.cleanup()` (ordem da regra 13 do brief).
 */
import { test, expect } from '@playwright/test';
import {
  seedLaunchablePatient, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR,
} from '../helpers/lancamento-e2e-helper';
import {
  activateRecruitmentViaApi, readItineraryApi, createServiceViaApi, ITINERARIO_STAFF,
} from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { postServiceTeamAction } from '../helpers/quadro-c-e2e-helper';
import {
  allocateApi, seedServiceWithLiveVacancySql, cleanupItineraryWrite,
} from '../helpers/itinerario-escrita-e2e-helper';
import {
  registerAbsenceApi, setAbsenceSubstituteApi, nextWeekdaySql, countOpenAbsences,
  cleanupSubstituicao,
} from '../helpers/substituicao-e2e-helper';

interface AllocateData { allocationId: string }

const STAFF = mockAdminUserFor('substituicao');

test.describe('substituicao @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  useLancamentoStaff(STAFF, 'E2E Substituicao');

  test('substituicao-gate', async ({ request }) => {
    const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const token = tokenFor(ITINERARIO_STAFF);
    const v = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
    const itin = await readItineraryApi(request, seed.patientId);
    const svc = itin.body.data?.services.find((s) => s.contractedServiceId === seed.serviceId);
    const slotId = svc?.slots[0]?.id;
    if (!slotId) throw new Error('substituicao-gate: slot do serviço não encontrado no itinerário');

    const t = insertTestWorker({ occupation: 'AT' }); // titular
    const w1 = insertTestWorker({ occupation: 'AT' }); // Selecionado, OUTRO serviço — sem candidatura aqui
    const w2 = insertTestWorker({ occupation: 'AT' }); // Rejeitado (C)
    const w3 = insertTestWorker({ occupation: 'AT' }); // ERR da vaga de OUTRO paciente
    const w4 = insertTestWorker({ occupation: 'AT' }); // ERR de X — deve poder substituir

    const seedOther = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.61, lng: -58.41 });
    let vOther: string | null = null;
    let otherVacancyId: string | null = null;
    try {
      insertWJA({ workerId: t, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const allocT = await allocateApi(request, token, seed.patientId, seed.serviceId, slotId, { workerId: t });
      expect(allocT.status).toBe(201);
      const allocationId = (allocT.body.data as AllocateData | undefined)?.allocationId;
      if (!allocationId) throw new Error('substituicao-gate: alocação do titular sem allocationId');

      const d = nextWeekdaySql(1);
      const absence = await registerAbsenceApi(request, token, seed.patientId, seed.serviceId, allocationId, { date: d });
      expect(absence.status).toBe(201);
      const absenceId = absence.body.data?.absenceId;
      if (!absenceId) throw new Error('substituicao-gate: ausência sem absenceId');

      // w1: Selecionado de OUTRO serviço (vOther) — não é Selecionado DESTE serviço.
      vOther = await activateRecruitmentViaApi(request, seedOther.patientId, seedOther.serviceId);
      insertWJA({ workerId: w1, jobPostingId: vOther, funnelStage: 'QUICK_RESPONSE_TEAM' });

      // w2: Rejeitado (C) deste serviço.
      insertWJA({ workerId: w2, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });
      const rejectW2 = await postServiceTeamAction(request, seed.patientId, seed.serviceId, 'reject', {
        workerId: w2, reasonCategory: 'INDISPONIBILIDADE_DE_HORARIO',
      });
      expect(rejectW2.status).toBe(200);

      // w3: ERR da vaga de OUTRO paciente (seedServiceWithLiveVacancySql).
      const otherSeed = seedServiceWithLiveVacancySql(seedOther.patientId, seedOther.addressId);
      otherVacancyId = otherSeed.vacancyId;
      insertWJA({ workerId: w3, jobPostingId: otherVacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      // w4: ERR de X — Selecionado válido.
      insertWJA({ workerId: w4, jobPostingId: v, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const r1 = await setAbsenceSubstituteApi(request, token, seed.patientId, seed.serviceId, absenceId, { substituteWorkerId: w1 });
      const r2 = await setAbsenceSubstituteApi(request, token, seed.patientId, seed.serviceId, absenceId, { substituteWorkerId: w2 });
      const r3 = await setAbsenceSubstituteApi(request, token, seed.patientId, seed.serviceId, absenceId, { substituteWorkerId: w3 });
      expect(r1.status).toBe(422);
      expect(r1.body.code).toBe('NOT_SELECTED_FOR_SERVICE');
      expect(r2.status).toBe(422);
      expect(r2.body.code).toBe('NOT_SELECTED_FOR_SERVICE');
      expect(r3.status).toBe(422);
      expect(r3.body.code).toBe('NOT_SELECTED_FOR_SERVICE');

      const r4 = await setAbsenceSubstituteApi(request, token, seed.patientId, seed.serviceId, absenceId, { substituteWorkerId: w4 });
      expect(r4.status).toBe(200);

      console.log(
        '[13.3]', r1.status, r1.body.code, r2.status, r2.body.code, r3.status, r3.body.code,
        r4.status,
      );
    } finally {
      cleanupSubstituicao(seed.patientId);
      cleanupWJAAndEncuadre(t, v);
      cleanupWJAAndEncuadre(w2, v);
      cleanupWJAAndEncuadre(w4, v);
      if (vOther) cleanupWJAAndEncuadre(w1, vOther);
      if (otherVacancyId) cleanupWJAAndEncuadre(w3, otherVacancyId);
      cleanupItineraryWrite(seedOther.patientId);
      cleanupTestWorker(t);
      cleanupTestWorker(w1);
      cleanupTestWorker(w2);
      cleanupTestWorker(w3);
      cleanupTestWorker(w4);
      seed.cleanup();
      seedOther.cleanup();
    }
  });

  test('substituicao-sobreposicao-recusa', async ({ request }) => {
    const seedX = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const seedY = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.62, lng: -58.42 });
    const sY = await createServiceViaApi(request, seedY.patientId, {
      addressId: seedY.addressId,
      schedule: [
        { dayOfWeek: 1, startTime: '10:00', endTime: '14:00' },
        { dayOfWeek: 1, startTime: '12:30', endTime: '16:00' },
      ],
    });
    // Z: 1 serviço, 2 faixas (T3 na 1ª, T4 na 2ª) — "2º slot" do texto do passo é a 2ª faixa da
    // MESMA vaga QUICK_RESPONSE_TEAM (vZ), não um 2º serviço.
    const seedZ = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.63, lng: -58.43 });
    const sZ = await createServiceViaApi(request, seedZ.patientId, {
      addressId: seedZ.addressId,
      schedule: [
        { dayOfWeek: 1, startTime: '13:00', endTime: '16:00' },
        { dayOfWeek: 1, startTime: '14:00', endTime: '17:00' },
      ],
    });

    const token = tokenFor(ITINERARIO_STAFF);
    const vX = await activateRecruitmentViaApi(request, seedX.patientId, seedX.serviceId);
    const vY = await activateRecruitmentViaApi(request, seedY.patientId, sY);
    const vZ = await activateRecruitmentViaApi(request, seedZ.patientId, sZ);

    const itinX = await readItineraryApi(request, seedX.patientId);
    const slotX = itinX.body.data?.services.find((s) => s.contractedServiceId === seedX.serviceId)?.slots[0]?.id;
    const itinY = await readItineraryApi(request, seedY.patientId);
    const svcY = itinY.body.data?.services.find((s) => s.contractedServiceId === sY);
    const slotY1000 = svcY?.slots.find((sl) => sl.startTime === '10:00')?.id;
    const slotY1230 = svcY?.slots.find((sl) => sl.startTime === '12:30')?.id;
    const itinZ = await readItineraryApi(request, seedZ.patientId);
    const svcZ = itinZ.body.data?.services.find((s) => s.contractedServiceId === sZ);
    const slotZ1300 = svcZ?.slots.find((sl) => sl.startTime === '13:00')?.id;
    const slotZ1400 = svcZ?.slots.find((sl) => sl.startTime === '14:00')?.id;
    if (!slotX || !slotY1000 || !slotY1230 || !slotZ1300 || !slotZ1400) {
      throw new Error('substituicao-sobreposicao-recusa: slot ausente na semente');
    }

    const w = insertTestWorker({ occupation: 'AT' }); // substituto candidato às 3 vagas
    const t2a = insertTestWorker({ occupation: 'AT' }); // titular de Y 10-14 (2 titulares — as 2 faixas de Y se sobrepõem entre si)
    const t2b = insertTestWorker({ occupation: 'AT' }); // titular de Y 12:30-16
    const t3 = insertTestWorker({ occupation: 'AT' }); // titular de Z 13-16
    const t4 = insertTestWorker({ occupation: 'AT' }); // titular de Z 14-17
    const d = nextWeekdaySql(1);
    try {
      insertWJA({ workerId: w, jobPostingId: vX, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: vY, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: vZ, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: t2a, jobPostingId: vY, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: t2b, jobPostingId: vY, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: t3, jobPostingId: vZ, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: t4, jobPostingId: vZ, funnelStage: 'QUICK_RESPONSE_TEAM' });

      // W fica alocado SEMANALMENTE em X (08-12) — a mesma sobreposição/folga da Fase 11, agora via ausência.
      const allocW = await allocateApi(request, token, seedX.patientId, seedX.serviceId, slotX, { workerId: w });
      expect(allocW.status).toBe(201);

      const allocT2a = await allocateApi(request, token, seedY.patientId, sY, slotY1000, { workerId: t2a });
      const allocT2b = await allocateApi(request, token, seedY.patientId, sY, slotY1230, { workerId: t2b });
      expect(allocT2a.status).toBe(201);
      expect(allocT2b.status).toBe(201);
      const allocIdT2a = (allocT2a.body.data as AllocateData | undefined)?.allocationId;
      const allocIdT2b = (allocT2b.body.data as AllocateData | undefined)?.allocationId;
      if (!allocIdT2a || !allocIdT2b) throw new Error('substituicao-sobreposicao-recusa: alocação de T2 sem id');

      const absT2a = await registerAbsenceApi(request, token, seedY.patientId, sY, allocIdT2a, { date: d });
      const absT2b = await registerAbsenceApi(request, token, seedY.patientId, sY, allocIdT2b, { date: d });
      expect(absT2a.status).toBe(201);
      expect(absT2b.status).toBe(201);
      const absIdT2a = absT2a.body.data?.absenceId;
      const absIdT2b = absT2b.body.data?.absenceId;
      if (!absIdT2a || !absIdT2b) throw new Error('substituicao-sobreposicao-recusa: ausência de T2 sem id');

      const rOverlap = await setAbsenceSubstituteApi(request, token, seedY.patientId, sY, absIdT2a, { substituteWorkerId: w });
      expect(rOverlap.status).toBe(409);
      expect(rOverlap.body.code).toBe('ITINERARY_OVERLAP');

      const rGap = await setAbsenceSubstituteApi(request, token, seedY.patientId, sY, absIdT2b, { substituteWorkerId: w });
      expect(rGap.status).toBe(409);
      expect(rGap.body.minGapMinutes).not.toBeNull();
      expect(rGap.body.minGapMinutes).not.toBeUndefined();

      // W substitui T3 em Z 13-16 — aceita, folga suficiente de X (08-12, gap 60min).
      const allocT3 = await allocateApi(request, token, seedZ.patientId, sZ, slotZ1300, { workerId: t3 });
      expect(allocT3.status).toBe(201);
      const allocIdT3 = (allocT3.body.data as AllocateData | undefined)?.allocationId;
      if (!allocIdT3) throw new Error('substituicao-sobreposicao-recusa: alocação de T3 sem id');
      const absT3 = await registerAbsenceApi(request, token, seedZ.patientId, sZ, allocIdT3, { date: d });
      expect(absT3.status).toBe(201);
      const absIdT3 = absT3.body.data?.absenceId;
      if (!absIdT3) throw new Error('substituicao-sobreposicao-recusa: ausência de T3 sem id');
      const rAccept = await setAbsenceSubstituteApi(request, token, seedZ.patientId, sZ, absIdT3, { substituteWorkerId: w });
      expect(rAccept.status).toBe(200);

      // T4 na 2ª faixa de Z (14-17) cruza a substituição recém-aceita de W em 13-16 — 409.
      const allocT4 = await allocateApi(request, token, seedZ.patientId, sZ, slotZ1400, { workerId: t4 });
      expect(allocT4.status).toBe(201);
      const allocIdT4 = (allocT4.body.data as AllocateData | undefined)?.allocationId;
      if (!allocIdT4) throw new Error('substituicao-sobreposicao-recusa: alocação de T4 sem id');
      const absT4 = await registerAbsenceApi(request, token, seedZ.patientId, sZ, allocIdT4, { date: d });
      expect(absT4.status).toBe(201);
      const absIdT4 = absT4.body.data?.absenceId;
      if (!absIdT4) throw new Error('substituicao-sobreposicao-recusa: ausência de T4 sem id');
      const rCrossesOwn = await setAbsenceSubstituteApi(request, token, seedZ.patientId, sZ, absIdT4, { substituteWorkerId: w });
      expect(rCrossesOwn.status).toBe(409);

      const openCount = countOpenAbsences(allocIdT3);
      console.log('[13.6]', rOverlap.status, rGap.status, rGap.body.minGapMinutes, rAccept.status, rCrossesOwn.status, openCount);
      expect(openCount).toBe(1);
    } finally {
      cleanupSubstituicao(seedX.patientId);
      cleanupSubstituicao(seedY.patientId);
      cleanupSubstituicao(seedZ.patientId);
      cleanupWJAAndEncuadre(w, vX);
      cleanupWJAAndEncuadre(w, vY);
      cleanupWJAAndEncuadre(w, vZ);
      cleanupWJAAndEncuadre(t2a, vY);
      cleanupWJAAndEncuadre(t2b, vY);
      cleanupWJAAndEncuadre(t3, vZ);
      cleanupWJAAndEncuadre(t4, vZ);
      cleanupTestWorker(w);
      cleanupTestWorker(t2a);
      cleanupTestWorker(t2b);
      cleanupTestWorker(t3);
      cleanupTestWorker(t4);
      seedX.cleanup();
      seedY.cleanup();
      seedZ.cleanup();
    }
  });

  test('substituicao-sobreposicao-aceita', async ({ request }) => {
    const seedX = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
    const seedY = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.64, lng: -58.44 });
    const sY = await createServiceViaApi(request, seedY.patientId, {
      addressId: seedY.addressId, schedule: [{ dayOfWeek: 1, startTime: '13:00', endTime: '16:00' }],
    });
    const s2X = await createServiceViaApi(request, seedX.patientId, {
      addressId: seedX.addressId, schedule: [{ dayOfWeek: 1, startTime: '12:00', endTime: '16:00' }],
    });
    const s3Y = await createServiceViaApi(request, seedY.patientId, {
      addressId: seedY.addressId, schedule: [{ dayOfWeek: 2, startTime: '08:00', endTime: '12:00' }],
    });

    const token = tokenFor(ITINERARIO_STAFF);
    const vX = await activateRecruitmentViaApi(request, seedX.patientId, seedX.serviceId);
    const vY = await activateRecruitmentViaApi(request, seedY.patientId, sY);
    const v2X = await activateRecruitmentViaApi(request, seedX.patientId, s2X);
    const v3Y = await activateRecruitmentViaApi(request, seedY.patientId, s3Y);

    const itinX = await readItineraryApi(request, seedX.patientId);
    const slotX = itinX.body.data?.services.find((s) => s.contractedServiceId === seedX.serviceId)?.slots[0]?.id;
    const slot2X = itinX.body.data?.services.find((s) => s.contractedServiceId === s2X)?.slots[0]?.id;
    const itinY = await readItineraryApi(request, seedY.patientId);
    const slotY = itinY.body.data?.services.find((s) => s.contractedServiceId === sY)?.slots[0]?.id;
    const slot3Y = itinY.body.data?.services.find((s) => s.contractedServiceId === s3Y)?.slots[0]?.id;
    if (!slotX || !slot2X || !slotY || !slot3Y) {
      throw new Error('substituicao-sobreposicao-aceita: slot ausente na semente');
    }

    const w = insertTestWorker({ occupation: 'AT' }); // substituto (semanal em X 08-12)
    const t2 = insertTestWorker({ occupation: 'AT' }); // titular Y 13-16
    const tOutroX = insertTestWorker({ occupation: 'AT' }); // titular do 2º serviço de X (12-16, mesmo endereço)
    const t3 = insertTestWorker({ occupation: 'AT' }); // titular Y terça 08-12
    const d = nextWeekdaySql(1);
    const dTue = nextWeekdaySql(2);
    // 2ª segunda estritamente futura (D + 7d), ainda do banco — evita que a substituição do 2º
    // serviço de X (12-16, MESMO endereço) e a de Y (13-16, endereço ≠) caiam no MESMO dia: são
    // faixas de HORÁRIO que se cruzam entre si (12-16 × 13-16), então só podem coexistir para o
    // MESMO W em datas diferentes — cada uma prova uma regra de folga distinta (mesmo endereço
    // sem gap vs. endereço diferente com o gap mínimo exato), não que W trabalhe em dois lugares
    // ao mesmo tempo.
    const d2 = runSQL(`SELECT to_char((date '${d}' + 7), 'YYYY-MM-DD')`);
    try {
      insertWJA({ workerId: w, jobPostingId: vX, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: vY, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: v2X, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: w, jobPostingId: v3Y, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: t2, jobPostingId: vY, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: tOutroX, jobPostingId: v2X, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: t3, jobPostingId: v3Y, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const allocW = await allocateApi(request, token, seedX.patientId, seedX.serviceId, slotX, { workerId: w });
      expect(allocW.status).toBe(201);

      const allocT2 = await allocateApi(request, token, seedY.patientId, sY, slotY, { workerId: t2 });
      expect(allocT2.status).toBe(201);
      const allocIdT2 = (allocT2.body.data as AllocateData | undefined)?.allocationId;
      if (!allocIdT2) throw new Error('substituicao-sobreposicao-aceita: alocação de T2 sem id');
      const absT2 = await registerAbsenceApi(request, token, seedY.patientId, sY, allocIdT2, { date: d });
      expect(absT2.status).toBe(201);
      const absIdT2 = absT2.body.data?.absenceId;
      if (!absIdT2) throw new Error('substituicao-sobreposicao-aceita: ausência de T2 sem id');
      const r1 = await setAbsenceSubstituteApi(request, token, seedY.patientId, sY, absIdT2, { substituteWorkerId: w });
      expect(r1.status).toBe(200);

      const allocOutroX = await allocateApi(request, token, seedX.patientId, s2X, slot2X, { workerId: tOutroX });
      expect(allocOutroX.status).toBe(201);
      const allocIdOutroX = (allocOutroX.body.data as AllocateData | undefined)?.allocationId;
      if (!allocIdOutroX) throw new Error('substituicao-sobreposicao-aceita: alocação do 2º serviço de X sem id');
      const absOutroX = await registerAbsenceApi(request, token, seedX.patientId, s2X, allocIdOutroX, { date: d2 });
      expect(absOutroX.status).toBe(201);
      const absIdOutroX = absOutroX.body.data?.absenceId;
      if (!absIdOutroX) throw new Error('substituicao-sobreposicao-aceita: ausência do 2º serviço de X sem id');
      const r2 = await setAbsenceSubstituteApi(request, token, seedX.patientId, s2X, absIdOutroX, { substituteWorkerId: w });
      expect(r2.status).toBe(200);

      const allocT3 = await allocateApi(request, token, seedY.patientId, s3Y, slot3Y, { workerId: t3 });
      expect(allocT3.status).toBe(201);
      const allocIdT3 = (allocT3.body.data as AllocateData | undefined)?.allocationId;
      if (!allocIdT3) throw new Error('substituicao-sobreposicao-aceita: alocação de T3 sem id');
      const absT3 = await registerAbsenceApi(request, token, seedY.patientId, s3Y, allocIdT3, { date: dTue });
      expect(absT3.status).toBe(201);
      const absIdT3 = absT3.body.data?.absenceId;
      if (!absIdT3) throw new Error('substituicao-sobreposicao-aceita: ausência de T3 sem id');
      const r3 = await setAbsenceSubstituteApi(request, token, seedY.patientId, s3Y, absIdT3, { substituteWorkerId: w });
      expect(r3.status).toBe(200);

      console.log('[13.7]', r1.status, r2.status, r3.status);
    } finally {
      cleanupSubstituicao(seedX.patientId);
      cleanupSubstituicao(seedY.patientId);
      cleanupWJAAndEncuadre(w, vX);
      cleanupWJAAndEncuadre(w, vY);
      cleanupWJAAndEncuadre(w, v2X);
      cleanupWJAAndEncuadre(w, v3Y);
      cleanupWJAAndEncuadre(t2, vY);
      cleanupWJAAndEncuadre(tOutroX, v2X);
      cleanupWJAAndEncuadre(t3, v3Y);
      cleanupTestWorker(w);
      cleanupTestWorker(t2);
      cleanupTestWorker(tOutroX);
      cleanupTestWorker(t3);
      seedX.cleanup();
      seedY.cleanup();
    }
  });
});
