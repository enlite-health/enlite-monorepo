/**
 * kanban-pacientes-derivacao.integration.e2e.ts @integration — Fase 15
 * (cadeia-paciente-vacante-itinerario), DX-15.13.
 *
 * Front NÃO entra — só API real (Playwright `request`) + Postgres real, nenhuma chamada de tela: a fase é
 * backend puro (a alocação no itinerário deriva o status do paciente, na mesma transação). Semente
 * por SQL só do que não é da fase (paciente com status inicial, worker, candidatura) e pela API
 * real do resto (`derivacao-e2e-helper.ts`); toda escrita DESTA fase (alocar, encerrar, montar,
 * rejeitar/reverter em C, ausência) pela API. O status do paciente é lido pela API
 * (`GET /api/admin/patients/:id`) E pelo banco em toda leitura.
 *
 * Nome do ARQUIVO: casa o termo `kanban-pacientes` do `grep:` do job padrão (`pr-gate.yml:152`,
 * workflow intocado); os títulos continuam `derivacao-…`.
 *
 * 8 títulos (DX-15.13): `derivacao-atribuicao-estado` (critério 7), `derivacao-saida-parcial` (8),
 * `derivacao-dois-servicos` (9), `derivacao-selecionar-nao-move` (10), `derivacao-c-nao-move`
 * (11, 12), `derivacao-substituicao-nao-move` (13), `derivacao-silencio` (14, lado verde),
 * `derivacao-sem-itinerario` (5).
 *
 * Serviço de 8 h = 2 faixas de 4 h (segunda e quarta 08-12): alocar 1 = 4/8, alocar 2 = 8/8.
 */
import { test, expect } from '@playwright/test';
import {
  backendUrl, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR,
} from '../helpers/lancamento-e2e-helper';
import {
  assembleApi, endAllocationApi, postSlotApi, endSlotApi,
} from '../helpers/itinerario-escrita-e2e-helper';
import { readItineraryApi } from '../helpers/itinerario-e2e-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { putMove } from '../helpers/funnel-move-e2e-helper';
import { upsertEncuadre } from '../helpers/wja-test-helper';
import { readServiceTeamApi, postServiceTeamAction } from '../helpers/quadro-c-e2e-helper';
import {
  registerAbsenceApi, setAbsenceSubstituteApi, nextWeekdaySql,
} from '../helpers/substituicao-e2e-helper';
import {
  seedDerivablePatient, selectedWorker, allocateWorker, readStatusBoth, coveredHours,
  countSystemTrail, derivacaoToken, type DerivableServiceSpec, type DerivableSeed, type StatusReading,
} from '../helpers/derivacao-e2e-helper';

const OITO_HORAS: DerivableServiceSpec = {
  weeklyHours: 8,
  schedule: [
    { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
    { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
  ],
};

/** API e banco dizem o MESMO status — e é o esperado. */
function expectStatus(r: StatusReading, expected: string): void {
  expect(r.api).toBe(expected);
  expect(r.db).toBe(expected);
}

test.describe('derivacao @integration', () => {
  test.use(LANCAMENTO_VIEWPORT_ES_AR);
  useLancamentoStaff(mockAdminUserFor('derivacao'), 'E2E Derivacao');

  test('derivacao-atribuicao-estado', async ({ request }) => {
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [OITO_HORAS] });
    try {
      const token = derivacaoToken();
      const [svc] = seed.services;
      const w1 = selectedWorker(seed, svc.vacancyId);
      const w2 = selectedWorker(seed, svc.vacancyId);

      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const s0 = await readStatusBoth(request, seed.patientId);
      expectStatus(s0, 'SEARCHING');

      const a1 = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], w1);
      expect(a1.status).toBe(201);
      const s1 = await readStatusBoth(request, seed.patientId);
      const h1 = await coveredHours(request, seed.patientId);
      expectStatus(s1, 'REPLACEMENT');

      const a2 = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[1], w2);
      expect(a2.status).toBe(201);
      const s2 = await readStatusBoth(request, seed.patientId);
      const h2 = await coveredHours(request, seed.patientId);
      expectStatus(s2, 'ACTIVE');

      if (!a1.allocationId || !a2.allocationId) throw new Error('derivacao-atribuicao-estado: alocação sem id');
      expect((await endAllocationApi(request, token, seed.patientId, svc.serviceId, a1.allocationId)).status).toBe(200);
      const sMeio = await readStatusBoth(request, seed.patientId);
      expect((await endAllocationApi(request, token, seed.patientId, svc.serviceId, a2.allocationId)).status).toBe(200);
      const s3 = await readStatusBoth(request, seed.patientId);
      const h3 = await coveredHours(request, seed.patientId);
      const trilha = countSystemTrail(seed.patientId);

      console.log('[15.7]', seed.patientId,
        'SEARCHING→REPLACEMENT', s1.api, s1.db, `cobertas=${h1}/8`,
        'REPLACEMENT→ACTIVE', s2.api, s2.db, `cobertas=${h2}/8`,
        'ACTIVE→SEARCHING (encerrar todas)', `via=${sMeio.api}`, s3.api, s3.db, `cobertas=${h3}/8`,
        `trilha_system=${trilha}`,
      );
      expect(h1).toBe(4);
      expect(h2).toBe(8);
      expectStatus(sMeio, 'REPLACEMENT');
      expectStatus(s3, 'SEARCHING');
      expect(h3).toBe(0);
      expect(trilha).toBe(4);
    } finally {
      seed.cleanup();
    }
  });

  test('derivacao-saida-parcial', async ({ request }) => {
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [OITO_HORAS] });
    try {
      const token = derivacaoToken();
      const [svc] = seed.services;
      const w1 = selectedWorker(seed, svc.vacancyId);
      const w2 = selectedWorker(seed, svc.vacancyId);

      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const a1 = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], w1);
      const a2 = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[1], w2);
      expect(a1.status).toBe(201);
      expect(a2.status).toBe(201);
      if (!a1.allocationId || !a2.allocationId) throw new Error('derivacao-saida-parcial: alocação sem id');
      const sCheio = await readStatusBoth(request, seed.patientId);
      expectStatus(sCheio, 'ACTIVE');

      expect((await endAllocationApi(request, token, seed.patientId, svc.serviceId, a1.allocationId)).status).toBe(200);
      const sUm = await readStatusBoth(request, seed.patientId);
      const hUm = await coveredHours(request, seed.patientId);
      expect((await endAllocationApi(request, token, seed.patientId, svc.serviceId, a2.allocationId)).status).toBe(200);
      const sDois = await readStatusBoth(request, seed.patientId);
      const hDois = await coveredHours(request, seed.patientId);

      console.log('[15.8]', seed.patientId, 'cheio', sCheio.api, sCheio.db,
        'encerra-um', sUm.api, sUm.db, `cobertas=${hUm}/8`,
        'encerra-outro', sDois.api, sDois.db, `cobertas=${hDois}/8`,
      );
      expectStatus(sUm, 'REPLACEMENT');
      expect(hUm).toBe(4);
      expectStatus(sDois, 'SEARCHING');
      expect(hDois).toBe(0);
    } finally {
      seed.cleanup();
    }
  });

  test('derivacao-dois-servicos', async ({ request }) => {
    const seed = await seedDerivablePatient(request, {
      status: 'SEARCHING',
      services: [
        OITO_HORAS,
        {
          weeklyHours: 8,
          secondAddress: true,
          schedule: [
            { dayOfWeek: 2, startTime: '08:00', endTime: '12:00' },
            { dayOfWeek: 4, startTime: '08:00', endTime: '12:00' },
          ],
        },
      ],
    });
    try {
      const token = derivacaoToken();
      const [svc1, svc2] = seed.services;
      const w1 = selectedWorker(seed, svc1.vacancyId);
      const w2 = selectedWorker(seed, svc1.vacancyId);

      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const a1 = await allocateWorker(request, seed.patientId, svc1.serviceId, svc1.slotIds[0], w1);
      const a2 = await allocateWorker(request, seed.patientId, svc1.serviceId, svc1.slotIds[1], w2);
      expect(a1.status).toBe(201);
      expect(a2.status).toBe(201);
      const s = await readStatusBoth(request, seed.patientId);
      const h = await coveredHours(request, seed.patientId);
      const trilha = countSystemTrail(seed.patientId);

      console.log('[15.9]', seed.patientId, `servicos=${seed.services.length}`, svc1.serviceId, svc2.serviceId,
        s.api, s.db, `cobertas=${h}/16`, `trilha_system=${trilha}`,
      );
      expectStatus(s, 'REPLACEMENT');
      expect(h).toBe(8);
    } finally {
      seed.cleanup();
    }
  });

  test('derivacao-selecionar-nao-move', async ({ request }) => {
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [OITO_HORAS] });
    try {
      const token = derivacaoToken();
      const [svc] = seed.services;
      const w = selectedWorker(seed, svc.vacancyId, 'SELECTED');
      const cardId = upsertEncuadre({ workerId: w, jobPostingId: svc.vacancyId });

      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const s0 = await readStatusBoth(request, seed.patientId);
      const trilha0 = countSystemTrail(seed.patientId);

      // O arrasto do quadro B é feito PELA API (`PUT /encuadres/:id/move`), sem tela.
      const toTeam = await putMove(request, backendUrl(), token, cardId, { targetStage: 'QUICK_RESPONSE_TEAM' });
      expect(toTeam.status).toBe(200);
      const team = await readServiceTeamApi(request, seed.patientId, svc.serviceId);
      const selecionados = (team.body.data?.selected ?? []).map((m) => m.workerId);
      const s1 = await readStatusBoth(request, seed.patientId);

      const toRejected = await putMove(request, backendUrl(), token, cardId, {
        targetStage: 'REJECTED', reasonCategory: 'DISTANCE',
      });
      expect(toRejected.status).toBe(200);
      const s2 = await readStatusBoth(request, seed.patientId);
      const trilha = countSystemTrail(seed.patientId);

      console.log('[15.10]', seed.patientId, 'arrasto=API putMove',
        `SELECTED→QUICK_RESPONSE_TEAM=${toTeam.status}`, `em_C=${selecionados.includes(w)}`,
        `→REJECTED(DISTANCE)=${toRejected.status}`,
        'leituras', s0.api, s0.db, s1.api, s1.db, s2.api, s2.db, `trilha_system=${trilha0}→${trilha}`,
      );
      expect(selecionados).toContain(w);
      expectStatus(s0, 'SEARCHING');
      expectStatus(s1, 'SEARCHING');
      expectStatus(s2, 'SEARCHING');
      expect(trilha0).toBe(0);
      expect(trilha).toBe(0);
    } finally {
      seed.cleanup();
    }
  });

  test('derivacao-c-nao-move', async ({ request }) => {
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [OITO_HORAS] });
    try {
      const token = derivacaoToken();
      const [svc] = seed.services;
      const w1 = selectedWorker(seed, svc.vacancyId);
      const w2 = selectedWorker(seed, svc.vacancyId);

      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const a1 = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], w1);
      expect(a1.status).toBe(201);
      const s0 = await readStatusBoth(request, seed.patientId);
      const h0 = await coveredHours(request, seed.patientId);
      const trilha0 = countSystemTrail(seed.patientId);

      const reject = await postServiceTeamAction(request, seed.patientId, svc.serviceId, 'reject', {
        workerId: w2, reasonCategory: 'INDISPONIBILIDADE_DE_HORARIO',
      });
      expect(reject.status).toBe(200);
      const s1 = await readStatusBoth(request, seed.patientId);
      const h1 = await coveredHours(request, seed.patientId);
      const revert = await postServiceTeamAction(request, seed.patientId, svc.serviceId, 'revert', {
        workerId: w2, reasonCategory: 'REAVALIACAO',
      });
      expect(revert.status).toBe(200);
      const s2 = await readStatusBoth(request, seed.patientId);
      const h2 = await coveredHours(request, seed.patientId);
      const trilha1 = countSystemTrail(seed.patientId);

      console.log('[15.11]', seed.patientId, `reject=${reject.status}`, `revert=${revert.status}`,
        'leituras', s0.api, s0.db, s1.api, s1.db, s2.api, s2.db,
        `cobertas=${h0}/${h1}/${h2}`, `trilha_system=${trilha0}→${trilha1}`,
      );
      expectStatus(s0, 'REPLACEMENT');
      expectStatus(s1, 'REPLACEMENT');
      expectStatus(s2, 'REPLACEMENT');
      expect([h0, h1, h2]).toEqual([4, 4, 4]);
      expect(trilha1).toBe(trilha0);

      const rejectAllocated = await postServiceTeamAction(request, seed.patientId, svc.serviceId, 'reject', {
        workerId: w1, reasonCategory: 'DESISTENCIA_DO_PRESTADOR',
      });
      const s3 = await readStatusBoth(request, seed.patientId);
      const h3 = await coveredHours(request, seed.patientId);
      const trilha2 = countSystemTrail(seed.patientId);

      console.log('[15.12]', seed.patientId, `reject_alocado=${rejectAllocated.status}`, rejectAllocated.body.code,
        'antes', s2.api, s2.db, `cobertas=${h2}`, 'depois', s3.api, s3.db, `cobertas=${h3}`,
        `trilha_system=${trilha1}→${trilha2}`,
      );
      expect(rejectAllocated.status).toBe(422);
      expect(rejectAllocated.body.code).toBe('SERVICE_TEAM_WORKER_ALLOCATED');
      expectStatus(s3, 'REPLACEMENT');
      expect(h3).toBe(h2);
      expect(trilha2).toBe(trilha1);
    } finally {
      seed.cleanup();
    }
  });

  test('derivacao-substituicao-nao-move', async ({ request }) => {
    const seed = await seedDerivablePatient(request, {
      status: 'SEARCHING',
      services: [{ weeklyHours: 4, schedule: [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }] }],
    });
    try {
      const token = derivacaoToken();
      const [svc] = seed.services;
      const w1 = selectedWorker(seed, svc.vacancyId);
      const w2 = selectedWorker(seed, svc.vacancyId);

      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const a1 = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], w1);
      expect(a1.status).toBe(201);
      if (!a1.allocationId) throw new Error('derivacao-substituicao-nao-move: alocação sem id');
      const s1 = await readStatusBoth(request, seed.patientId);
      const h1 = await coveredHours(request, seed.patientId);
      const trilha1 = countSystemTrail(seed.patientId);

      const d = nextWeekdaySql(1);
      const absence = await registerAbsenceApi(request, token, seed.patientId, svc.serviceId, a1.allocationId, { date: d });
      expect(absence.status).toBe(201);
      const absenceId = absence.body.data?.absenceId;
      if (!absenceId) throw new Error('derivacao-substituicao-nao-move: ausência sem absenceId');
      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const s2 = await readStatusBoth(request, seed.patientId);
      const h2 = await coveredHours(request, seed.patientId);

      const sub = await setAbsenceSubstituteApi(request, token, seed.patientId, svc.serviceId, absenceId, {
        substituteWorkerId: w2,
      });
      expect(sub.status).toBe(200);
      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const s3 = await readStatusBoth(request, seed.patientId);
      const h3 = await coveredHours(request, seed.patientId);
      const trilha3 = countSystemTrail(seed.patientId);

      console.log('[15.13]', seed.patientId, `ausencia=${absence.status}`, `substituto=${sub.status}`,
        'leitura1', s1.api, s1.db, `cobertas=${h1}`,
        'leitura2(sem substituto)', s2.api, s2.db, `cobertas=${h2}`,
        'leitura3(com substituto)', s3.api, s3.db, `cobertas=${h3}`,
        `trilha_system=${trilha1}→${trilha3}`,
      );
      expectStatus(s1, 'ACTIVE');
      expectStatus(s2, 'ACTIVE');
      expectStatus(s3, 'ACTIVE');
      expect([h1, h2, h3]).toEqual([4, 4, 4]);
      expect(trilha3).toBe(trilha1);
    } finally {
      seed.cleanup();
    }
  });

  test('derivacao-silencio', async ({ request }) => {
    const seed = await seedDerivablePatient(request, { status: 'SEARCHING', services: [OITO_HORAS] });
    try {
      const token = derivacaoToken();
      const [svc] = seed.services;
      const w1 = selectedWorker(seed, svc.vacancyId);
      const w2 = selectedWorker(seed, svc.vacancyId);

      expect((await assembleApi(request, token, seed.patientId)).status).toBe(201);
      const a1 = await allocateWorker(request, seed.patientId, svc.serviceId, svc.slotIds[0], w1);
      expect(a1.status).toBe(201);
      const s0 = await readStatusBoth(request, seed.patientId);
      const h0 = await coveredHours(request, seed.patientId);
      const trilha0 = countSystemTrail(seed.patientId);

      // Ações que NÃO mudam alocação nenhuma.
      const itin = await readItineraryApi(request, seed.patientId);
      const team = await readServiceTeamApi(request, seed.patientId, svc.serviceId);
      const slot = await postSlotApi(request, token, seed.patientId, svc.serviceId, {
        weekday: 6, startTime: '08:00', endTime: '09:00',
      });
      const newSlotId = (slot.body.data as { id?: string } | undefined)?.id;
      if (!newSlotId) throw new Error('derivacao-silencio: faixa nova sem id');
      const endSlot = await endSlotApi(request, token, seed.patientId, svc.serviceId, newSlotId);
      const reject = await postServiceTeamAction(request, seed.patientId, svc.serviceId, 'reject', {
        workerId: w2, reasonCategory: 'INDISPONIBILIDADE_DE_HORARIO',
      });
      const revert = await postServiceTeamAction(request, seed.patientId, svc.serviceId, 'revert', {
        workerId: w2, reasonCategory: 'REAVALIACAO',
      });
      const reassemble = await assembleApi(request, token, seed.patientId);

      const s1 = await readStatusBoth(request, seed.patientId);
      const h1 = await coveredHours(request, seed.patientId);
      const trilha1 = countSystemTrail(seed.patientId);

      console.log('[15.14]', seed.patientId,
        `itinerario=${itin.status}`, `time=${team.status}`, `faixa_nova=${slot.status}`, `faixa_encerrada=${endSlot.status}`,
        `reject=${reject.status}`, `revert=${revert.status}`, `remontar=${reassemble.status}`,
        'antes', s0.api, s0.db, `cobertas=${h0}`, 'depois', s1.api, s1.db, `cobertas=${h1}`,
        `trilha_system=${trilha0}→${trilha1}`,
      );
      expect([itin.status, team.status, slot.status, endSlot.status]).toEqual([200, 200, 201, 200]);
      expect([reject.status, revert.status, reassemble.status]).toEqual([200, 200, 201]);
      expect(s1.api).toBe(s0.api);
      expect(s1.db).toBe(s0.db);
      expect(h1).toBe(h0);
      expect(trilha1).toBe(trilha0);
    } finally {
      seed.cleanup();
    }
  });

  test('derivacao-sem-itinerario', async ({ request }) => {
    const p1 = await seedDerivablePatient(request, { status: 'ACTIVE', services: [OITO_HORAS] });
    let p2: DerivableSeed | null = null;
    try {
      const token = derivacaoToken();
      const [svc1] = p1.services;
      const w1 = selectedWorker(p1, svc1.vacancyId);

      // P1 NÃO é montado: a alocação no serviço dele não deriva (D429).
      const a1 = await allocateWorker(request, p1.patientId, svc1.serviceId, svc1.slotIds[0], w1);
      expect(a1.status).toBe(201);
      const sP1a = await readStatusBoth(request, p1.patientId);
      const hP1 = await coveredHours(request, p1.patientId);

      // P2 montado recebe uma alocação (controle positivo: P2 move).
      p2 = await seedDerivablePatient(request, { status: 'SEARCHING', services: [OITO_HORAS], lat: -34.61, lng: -58.41 });
      const [svc2] = p2.services;
      const w3 = selectedWorker(p2, svc2.vacancyId);
      expect((await assembleApi(request, token, p2.patientId)).status).toBe(201);
      const a3 = await allocateWorker(request, p2.patientId, svc2.serviceId, svc2.slotIds[0], w3);
      expect(a3.status).toBe(201);
      const sP2 = await readStatusBoth(request, p2.patientId);
      const sP1b = await readStatusBoth(request, p1.patientId);
      const montadoP1 = Number(
        runSQL(`SELECT count(*) FROM patient_itinerary_assembly WHERE patient_id = '${p1.patientId}'`),
      );
      const trilhaP1 = countSystemTrail(p1.patientId);
      const trilhaP2 = countSystemTrail(p2.patientId);

      console.log('[15.5]', p1.patientId, `montado_P1=${montadoP1}`, `aloca_P1=${a1.status}`, `cobertas_P1=${hP1}/8`,
        'P1 depois da própria alocação', sP1a.api, sP1a.db,
        'P2', p2.patientId, `aloca_P2=${a3.status}`, sP2.api, sP2.db,
        'P1 depois da alocação em P2', sP1b.api, sP1b.db,
        `trilha_system P1=${trilhaP1} P2=${trilhaP2}`,
      );
      expect(montadoP1).toBe(0);
      expect(hP1).toBe(4);
      expectStatus(sP1a, 'ACTIVE');
      expectStatus(sP2, 'REPLACEMENT');
      expectStatus(sP1b, 'ACTIVE');
      expect(trilhaP1).toBe(0);
      expect(trilhaP2).toBe(1);
    } finally {
      p2?.cleanup();
      p1.cleanup();
    }
  });
});
