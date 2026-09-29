/**
 * kanban-pacientes-alocacao-antiga.integration.e2e.ts @integration — Fase 14 (cadeia-paciente-vacante-itinerario),
 * DX-14.4 / DX-14.6 / DX-14.15.
 *
 * A alocação ANTIGA (a tabela da migration 319, anterior ao itinerário) deixou de ser escrita: as duas
 * rotas antigas devolvem 404, a alocação pelo itinerário abre (201), e a linha antiga — semeada por SQL
 * como dono, o único jeito depois da fase — não conta em `cobertas` nem entra em Em Atendimento (C).
 * Nome do ARQUIVO sem tocar `pr-gate.yml`: o caminho casa `kanban-pacientes` do job padrão. Um `test`
 * por critério, sem modo serial; cada um imprime `console.log('[14.<n>]', …)` só com ids/status/contagens.
 *
 * Semente reusada (nunca copiada): `seedLaunchablePatient` (serviço AT segunda 08-12, 1 slot) →
 * `activateRecruitmentViaApi` → W1 e W2 `insertTestWorker({ occupation: 'AT' })` → `insertWJA(W1 …
 * 'QUICK_RESPONSE_TEAM')` (Selecionado C). `finally` por teste, na ordem da DX-14.15: linha antiga →
 * itinerário → WJA/vaga → workers → paciente.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  seedLaunchablePatient, mockAdminUserFor, useLancamentoStaff, LANCAMENTO_VIEWPORT_ES_AR,
  type SeedLaunchablePatientResult,
} from '../helpers/lancamento-e2e-helper';
import { activateRecruitmentViaApi, readItineraryApi, ITINERARIO_STAFF } from '../helpers/itinerario-e2e-helper';
import { insertTestWorker, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { tokenFor } from '../helpers/abac-stack-helper';
import { runSQL } from '../helpers/patient-detail-a-helper';
import { readServiceTeamApi } from '../helpers/quadro-c-e2e-helper';
import {
  allocationOptionsApi, allocateApi, countActiveAllocations, cleanupItineraryWrite,
} from '../helpers/itinerario-escrita-e2e-helper';
import {
  seedLegacyAllocationSql, countLegacyAllocations, cleanupLegacyAllocations,
  postLegacyProviderApi, patchLegacyProviderApi,
} from '../helpers/alocacao-antiga-e2e-helper';

interface OptionDto { workerId: string }
interface OptionsData { options: OptionDto[] }

const STAFF = mockAdminUserFor('alocacao-antiga');

interface AlocacaoAntigaSeed {
  seed: SeedLaunchablePatientResult;
  vacancyId: string;
  w1: string;
  w2: string;
}

/** Semente comum: paciente lançável + vaga do serviço + W1 (Selecionado C) e W2 (sem candidatura). */
async function seedAlocacaoAntiga(request: APIRequestContext): Promise<AlocacaoAntigaSeed> {
  const seed = await seedLaunchablePatient(request, { status: 'ADMISSION', lat: -34.6, lng: -58.4 });
  const vacancyId = await activateRecruitmentViaApi(request, seed.patientId, seed.serviceId);
  const w1 = insertTestWorker({ occupation: 'AT' });
  const w2 = insertTestWorker({ occupation: 'AT' });
  insertWJA({ workerId: w1, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
  return { seed, vacancyId, w1, w2 };
}

/** Limpeza na ordem da DX-14.15 (a linha antiga ANTES do worker: `worker_id` sem `ON DELETE`). */
function cleanupAlocacaoAntiga(s: AlocacaoAntigaSeed): void {
  cleanupLegacyAllocations(s.seed.serviceId);
  cleanupItineraryWrite(s.seed.patientId);
  cleanupWJAAndEncuadre(s.w1, s.vacancyId);
  cleanupWJAAndEncuadre(s.w2, s.vacancyId);
  cleanupTestWorker(s.w1);
  cleanupTestWorker(s.w2);
  s.seed.cleanup();
}

/** Duração em horas de um slot a partir do `HH:MM` que a rota devolve (nenhuma data envolvida). */
function slotHours(startTime: string, endTime: string): number {
  const toMin = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return (toMin(endTime) - toMin(startTime)) / 60;
}

test.describe('alocacao-antiga @integration', () => {
  test.use({ ...LANCAMENTO_VIEWPORT_ES_AR, deviceScaleFactor: 1 });
  useLancamentoStaff(STAFF, 'E2E Alocacao Antiga');

  test('alocacao-antiga-fechada', async ({ request }) => {
    const s = await seedAlocacaoAntiga(request);
    const { patientId, serviceId } = s.seed;
    const token = tokenFor(ITINERARIO_STAFF);
    try {
      // Critério 2: a porta antiga recusa (404) e a contagem da tabela não muda.
      const legacyId = seedLegacyAllocationSql(serviceId, s.w2, 10);
      const antes = countLegacyAllocations(serviceId);
      expect(antes).toBe(1);

      const post = await postLegacyProviderApi(request, token, patientId, serviceId, s.w1);
      expect(post.status).toBe(404);
      const patch = await patchLegacyProviderApi(request, token, patientId, serviceId, legacyId);
      expect(patch.status).toBe(404);

      const depois = countLegacyAllocations(serviceId);
      expect(depois).toBe(1);
      expect(runSQL(`SELECT active FROM contracted_service_providers WHERE id = '${legacyId}'`)).toBe('t');
      console.log('[14.2]', { post: post.status, patch: patch.status, antes, depois });

      // Critério 3: a porta nova abre — W1 (Selecionado C) é opção e a alocação pelo itinerário dá 201.
      const opts = await allocationOptionsApi(request, token, patientId, serviceId);
      expect(opts.status).toBe(200);
      const optionIds = ((opts.body.data as OptionsData | undefined)?.options ?? []).map((o) => o.workerId);
      expect(optionIds).toContain(s.w1);

      const itin = await readItineraryApi(request, patientId);
      expect(itin.status).toBe(200);
      const slotId = itin.body.data?.services.find((x) => x.contractedServiceId === serviceId)?.slots[0]?.id;
      if (!slotId) throw new Error('alocacao-antiga-fechada: slot do serviço ausente na semente');

      const alloc = await allocateApi(request, token, patientId, serviceId, slotId, { workerId: s.w1 });
      expect(alloc.status).toBe(201);
      const ativas = countActiveAllocations(s.w1);
      expect(ativas).toBe(1);
      console.log('[14.3]', { status: alloc.status, ativas });
    } finally {
      cleanupAlocacaoAntiga(s);
    }
  });

  test('alocacao-antiga-nao-conta', async ({ request }) => {
    const s = await seedAlocacaoAntiga(request);
    const { patientId, serviceId } = s.seed;
    const token = tokenFor(ITINERARIO_STAFF);
    try {
      seedLegacyAllocationSql(serviceId, s.w2, 20);
      expect(countLegacyAllocations(serviceId)).toBe(1);

      // Critério 4: a linha antiga (W2, 20 h) não entra em `cobertas` nem em Em Atendimento.
      const before = await readItineraryApi(request, patientId);
      expect(before.status).toBe(200);
      const svcBefore = before.body.data?.services.find((x) => x.contractedServiceId === serviceId);
      const slot = svcBefore?.slots[0];
      if (!svcBefore || !slot) throw new Error('alocacao-antiga-nao-conta: slot do serviço ausente na semente');
      const cobertasAntes = svcBefore.cobertas;
      expect(cobertasAntes).toBe(0);

      const teamBefore = await readServiceTeamApi(request, patientId, serviceId);
      expect(teamBefore.status).toBe(200);
      const inServiceBefore = teamBefore.body.data?.inService ?? [];
      expect(inServiceBefore.filter((m) => m.workerId === s.w2)).toHaveLength(0);
      expect(inServiceBefore).toHaveLength(0);

      // Controle positivo na MESMA execução: a alocação pelo itinerário conta e põe W1 em Em Atendimento.
      const alloc = await allocateApi(request, token, patientId, serviceId, slot.id, { workerId: s.w1 });
      expect(alloc.status).toBe(201);

      const after = await readItineraryApi(request, patientId);
      expect(after.status).toBe(200);
      const svcAfter = after.body.data?.services.find((x) => x.contractedServiceId === serviceId);
      if (!svcAfter) throw new Error('alocacao-antiga-nao-conta: serviço ausente no itinerário depois');
      const cobertasDepois = svcAfter.cobertas;
      expect(cobertasDepois).toBe(cobertasAntes + slotHours(slot.startTime, slot.endTime));

      const teamAfter = await readServiceTeamApi(request, patientId, serviceId);
      expect(teamAfter.status).toBe(200);
      const inServiceAfter = teamAfter.body.data?.inService ?? [];
      const w1InService = inServiceAfter.filter((m) => m.workerId === s.w1).length;
      const w2InService = inServiceAfter.filter((m) => m.workerId === s.w2).length;
      expect(w1InService).toBe(1);
      expect(w2InService).toBe(0);
      expect(countLegacyAllocations(serviceId)).toBe(1);
      console.log('[14.4]', { cobertasAntes, cobertasDepois, w2InService, w1InService });
    } finally {
      cleanupAlocacaoAntiga(s);
    }
  });
});
