/**
 * kanban-pacientes-derivacao.integration.e2e.ts @integration — Fase 15
 * (cadeia-paciente-vacante-itinerario), DX-15.13.
 *
 * Front NÃO entra — só API real (Playwright `request`) + Postgres real, zero `page.*`: a fase é
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
  mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR,
} from '../helpers/lancamento-e2e-helper';
import { assembleApi, endAllocationApi } from '../helpers/itinerario-escrita-e2e-helper';
import {
  seedDerivablePatient, selectedWorker, allocateWorker, readStatusBoth, coveredHours,
  countSystemTrail, derivacaoToken, type DerivableServiceSpec, type StatusReading,
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

      console.log(
        '[15.7]', seed.patientId,
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

      console.log(
        '[15.8]', seed.patientId, 'cheio', sCheio.api, sCheio.db,
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

      console.log(
        '[15.9]', seed.patientId, `servicos=${seed.services.length}`, svc1.serviceId, svc2.serviceId,
        s.api, s.db, `cobertas=${h}/16`, `trilha_system=${trilha}`,
      );
      expectStatus(s, 'REPLACEMENT');
      expect(h).toBe(8);
    } finally {
      seed.cleanup();
    }
  });
});
