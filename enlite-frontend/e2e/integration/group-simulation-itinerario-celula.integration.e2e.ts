/**
 * group-simulation-itinerario-celula.integration.e2e.ts @integration
 *
 * Fase 11 (change cadeia-paciente-vacante-itinerario), P28 — DX-11.12, DX-11.13: prova a célula
 * `patient_itinerary:update` com o engine ABAC de verdade LIGADO (SWITCH-ON-F11), não com token
 * `role: 'admin'` (memória `stack-e2e-abac-ligado`: role admin sem grupo dá 403
 * `account_not_active` sob engine ligado — e passa até na variante sem engine, então não prova
 * nada). Nome do ARQUIVO (Q-11.4, sem o "pode" do Gabriel para tocar
 * `_frontend-integration.yml`): o CAMINHO casa o termo `group-simulation` que já está no `--grep`
 * do job `integration-e2e-group-simulation` (`_frontend-integration.yml:598`) — nenhum workflow
 * tocado.
 *
 * Stack: a MESMA api `cadeia-f11-api` reconfigurada (SWITCH-ON-F11/SWITCH-OFF-F11,
 * `docker-compose.group-simulation.yml`), nunca uma 2ª api. Front NÃO entra — só API real
 * (Playwright `request`) + Postgres real; esta fase não tem tela (a tela é a Fase 12), zero
 * `page.*`.
 *
 * Contas por `seedStaffInGroup`/`grantCell` (`abac-stack-helper.ts`), `role: 'recruiter'`,
 * `country: 'AR'`, e-mail `qa.sim.itinerario.<com|sem>.<RUN_ID>@enlite.test` — a célula é
 * concedida ANTES do 1º request (`PERMISSION_CACHE_TTL_MS=30000` deixaria o cache velho valer
 * até 30s se concedida depois). COM: `patient_services:read` + `patient_itinerary:update`. SEM:
 * só `patient_services:read` (fora do Master, sem a célula nova).
 *
 * Semente por SQL (sob engine ligado, token `role: 'admin'` sem grupo dá 403
 * `account_not_active` — `activateRecruitmentViaApi`/`readItineraryApi`/`seedLaunchablePatient`
 * usam esse token e não servem aqui): `insertTestPatient` + `seedServiceWithLiveVacancySql`
 * (DX-11.18) + `insertTestWorker` + `insertWJA(… 'QUICK_RESPONSE_TEAM')`.
 *
 * `itinerario-celula-com` (critério 2): COM cria slot (201), aloca o worker candidato (201) e
 * marca o itinerário como montado (201) — as 3 escritas da fase, pela API nova, com a célula.
 * `itinerario-celula-sem` (critério 3): um slot + uma alocação REAIS são semeados pela própria
 * API da fase (conta COM, antes de testar SEM — dá aos 403 de PATCH/encerrar/alocar/encerrar
 * alocação um alvo que existe de verdade, não um id fabricado). Depois, SEM nas 6 rotas de
 * escrita → 403 em cada uma, `body.code` colado; controle: SEM no GET
 * `.../allocation-options` (célula `patient_services:read`, que SEM tem) → 200; contagem de
 * slots ativos / alocações ativas / montado antes = depois das 6 tentativas do SEM.
 */
import { test, expect } from '@playwright/test';
import { insertTestPatient, insertTestWorker, cleanupTestPatient, cleanupTestWorker } from '../helpers/db-test-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { tokenFor, seedStaffInGroup, cleanupStaffAndGroup, grantCell, scalar, type MockUser } from '../helpers/abac-stack-helper';
import {
  postSlotApi, patchSlotApi, endSlotApi, allocateApi, endAllocationApi, assembleApi,
  allocationOptionsApi, seedServiceWithLiveVacancySql, cleanupItineraryWrite,
} from '../helpers/itinerario-escrita-e2e-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const COM_UID = `qa.sim.itinerario.com.${RUN_ID}`;
const COM_EMAIL = `qa.sim.itinerario.com.${RUN_ID}@enlite.test`;
const SEM_UID = `qa.sim.itinerario.sem.${RUN_ID}`;
const SEM_EMAIL = `qa.sim.itinerario.sem.${RUN_ID}@enlite.test`;

const STAFF_COM: MockUser = { uid: COM_UID, email: COM_EMAIL, role: 'recruiter', country: 'AR' };
const STAFF_SEM: MockUser = { uid: SEM_UID, email: SEM_EMAIL, role: 'recruiter', country: 'AR' };

interface SlotData { id?: string }
interface AllocateData { allocationId?: string }

test.describe('itinerario-celula sob engine ligado @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  let groupComId = '';
  let groupSemId = '';

  test.beforeAll(() => {
    // Célula CONCEDIDA antes do 1º request — o cache (PERMISSION_CACHE_TTL_MS=30000) deixaria o
    // valor antigo valer por até 30s se concedida depois.
    ({ groupId: groupComId } = seedStaffInGroup({
      uid: COM_UID, email: COM_EMAIL, groupName: `Itin COM ${RUN_ID}`, country: 'AR',
    }));
    grantCell(groupComId, 'patient_services', 'read');
    grantCell(groupComId, 'patient_itinerary', 'update');

    ({ groupId: groupSemId } = seedStaffInGroup({
      uid: SEM_UID, email: SEM_EMAIL, groupName: `Itin SEM ${RUN_ID}`, country: 'AR',
    }));
    grantCell(groupSemId, 'patient_services', 'read');
  });

  test.afterAll(() => {
    try {
      cleanupStaffAndGroup(COM_UID, groupComId);
    } catch (err) {
      console.error('[cleanup] staff COM falhou (seguindo)', err);
    }
    try {
      cleanupStaffAndGroup(SEM_UID, groupSemId);
    } catch (err) {
      console.error('[cleanup] staff SEM falhou (seguindo)', err);
    }
  });

  test('itinerario-celula-com', async ({ request }) => {
    const comToken = tokenFor(STAFF_COM);
    const { patientId, addressId } = insertTestPatient({
      withAddress: true, insuranceInformed: 'OSDE', firstName: 'ItinCelulaCom', lastName: `Seed-${RUN_ID}`,
    });
    const { serviceId, vacancyId } = seedServiceWithLiveVacancySql(patientId, addressId!);
    const workerId = insertTestWorker({ occupation: 'AT' });

    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const slot = await postSlotApi(request, comToken, patientId, serviceId, {
        weekday: 2, startTime: '09:00', endTime: '11:00',
      });
      expect(slot.status, 'POST slot com patient_itinerary:update').toBe(201);
      const slotId = (slot.body.data as SlotData | undefined)?.id;
      if (!slotId) throw new Error('itinerario-celula-com: slot criado sem id');

      const alloc = await allocateApi(request, comToken, patientId, serviceId, slotId, { workerId });
      expect(alloc.status, 'POST allocation com patient_itinerary:update').toBe(201);

      const assembled = await assembleApi(request, comToken, patientId);
      expect(assembled.status, 'POST assemble com patient_itinerary:update').toBe(201);

      console.log('[11.2] slot=', slot.status, 'alloc=', alloc.status, 'assemble=', assembled.status);
    } finally {
      cleanupItineraryWrite(patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupTestWorker(workerId);
      cleanupTestPatient(patientId);
    }
  });

  test('itinerario-celula-sem', async ({ request }) => {
    const comToken = tokenFor(STAFF_COM);
    const semToken = tokenFor(STAFF_SEM);
    const { patientId, addressId } = insertTestPatient({
      withAddress: true, insuranceInformed: 'OSDE', firstName: 'ItinCelulaSem', lastName: `Seed-${RUN_ID}`,
    });
    const { serviceId, vacancyId } = seedServiceWithLiveVacancySql(patientId, addressId!);
    const workerId = insertTestWorker({ occupation: 'AT' });
    const workerId2 = insertTestWorker({ occupation: 'AT' });

    try {
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });
      insertWJA({ workerId: workerId2, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      // Alvo REAL para os 403 de PATCH/encerrar/alocar/encerrar-alocação — semeado pela API da
      // própria fase, com a conta COM (não é a rota sob teste; é insumo).
      const seedSlot = await postSlotApi(request, comToken, patientId, serviceId, {
        weekday: 3, startTime: '09:00', endTime: '11:00',
      });
      expect(seedSlot.status, 'semente: POST slot com COM').toBe(201);
      const slotId = (seedSlot.body.data as SlotData | undefined)?.id;
      if (!slotId) throw new Error('itinerario-celula-sem: slot semente sem id');

      const seedAlloc = await allocateApi(request, comToken, patientId, serviceId, slotId, { workerId });
      expect(seedAlloc.status, 'semente: POST allocation com COM').toBe(201);
      const allocationId = (seedAlloc.body.data as AllocateData | undefined)?.allocationId;
      if (!allocationId) throw new Error('itinerario-celula-sem: alocação semente sem id');

      const slotsBefore = scalar(
        `select count(*) from patient_itinerary_slot where contracted_service_id = '${serviceId}' and active = true`,
      );
      const allocsBefore = scalar(
        `select count(*) from patient_itinerary_assignment where slot_id = '${slotId}' and status = 'ACTIVE'`,
      );
      const montadoBefore = scalar(`select count(*) from patient_itinerary_assembly where patient_id = '${patientId}'`);

      const rPost = await postSlotApi(request, semToken, patientId, serviceId, {
        weekday: 4, startTime: '09:00', endTime: '11:00',
      });
      const rPatch = await patchSlotApi(request, semToken, patientId, serviceId, slotId, {
        weekday: 3, startTime: '10:00', endTime: '12:00',
      });
      const rEnd = await endSlotApi(request, semToken, patientId, serviceId, slotId);
      const rAlloc = await allocateApi(request, semToken, patientId, serviceId, slotId, { workerId: workerId2 });
      const rEndAlloc = await endAllocationApi(request, semToken, patientId, serviceId, allocationId);
      const rAssemble = await assembleApi(request, semToken, patientId);

      // Controle: SEM tem `patient_services:read` (a mesma célula do GET) → 200, a conta existe e
      // passa na leitura — a ausência de `patient_itinerary:update` só nega a ESCRITA.
      const rControl = await allocationOptionsApi(request, semToken, patientId, serviceId);

      console.log(
        '[11.3] slot=', rPost.status, rPost.body.code,
        'patch=', rPatch.status, rPatch.body.code,
        'end=', rEnd.status, rEnd.body.code,
        'alloc=', rAlloc.status, rAlloc.body.code,
        'endAlloc=', rEndAlloc.status, rEndAlloc.body.code,
        'assemble=', rAssemble.status, rAssemble.body.code,
        'control(read)=', rControl.status,
      );

      expect(rPost.status, 'POST slot sem patient_itinerary:update').toBe(403);
      expect(rPatch.status, 'PATCH slot sem patient_itinerary:update').toBe(403);
      expect(rEnd.status, 'POST slot/end sem patient_itinerary:update').toBe(403);
      expect(rAlloc.status, 'POST allocation sem patient_itinerary:update').toBe(403);
      expect(rEndAlloc.status, 'POST allocation/end sem patient_itinerary:update').toBe(403);
      expect(rAssemble.status, 'POST assemble sem patient_itinerary:update').toBe(403);
      expect(rControl.status, 'GET allocation-options com patient_services:read').toBe(200);

      const slotsAfter = scalar(
        `select count(*) from patient_itinerary_slot where contracted_service_id = '${serviceId}' and active = true`,
      );
      const allocsAfter = scalar(
        `select count(*) from patient_itinerary_assignment where slot_id = '${slotId}' and status = 'ACTIVE'`,
      );
      const montadoAfter = scalar(`select count(*) from patient_itinerary_assembly where patient_id = '${patientId}'`);
      console.log(
        '[11.3-contagem] slots', slotsBefore, '->', slotsAfter,
        '| alocacoes', allocsBefore, '->', allocsAfter,
        '| montado', montadoBefore, '->', montadoAfter,
      );
      expect(slotsAfter, 'slots ativos inalterados após os 403 do SEM').toBe(slotsBefore);
      expect(allocsAfter, 'alocações ativas inalteradas após os 403 do SEM').toBe(allocsBefore);
      expect(montadoAfter, 'montado inalterado após os 403 do SEM').toBe(montadoBefore);
    } finally {
      cleanupItineraryWrite(patientId);
      cleanupWJAAndEncuadre(workerId, vacancyId);
      cleanupWJAAndEncuadre(workerId2, vacancyId);
      cleanupTestWorker(workerId);
      cleanupTestWorker(workerId2);
      cleanupTestPatient(patientId);
    }
  });
});
