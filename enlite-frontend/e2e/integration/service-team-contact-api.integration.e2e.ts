/**
 * service-team-contact-api.integration.e2e.ts @integration — modal do prestador, API crua
 * (quadro C, rodada 2, decisão D). Sob engine ABAC ligado (molde `encuadre-tab-sem-celula`):
 *
 *  - feliz: POST registra um contato, GET devolve o histórico com a linha.
 *  - alternativo 1: ator sem `patient_service_team:update` → 403 no POST (a mesma célula do
 *    reject/revert).
 *  - alternativo 2: `workerId` que nunca fez parte do time do serviço → 404 (não distingue de
 *    "serviço inexistente" — mesma régua do GET .../team).
 *  - alternativo 3 (rodada 3): `phone` só vem preenchido com `worker_contact:read`. `STAFF_COM`
 *    tem `patient_service_team:update` mas NÃO essa célula — GET dele devolve `phone: null` mesmo
 *    com telefone sintético semeado. `STAFF_WA` tem SÓ `worker_contact:read` — GET dele devolve o
 *    telefone (a célula decide ANTES do KMS, C3).
 *
 * Semente 100% por SQL (`insertTestPatient`/`seedServiceWithLiveVacancySql`/`insertWJA`), NUNCA
 * pela API de lançamento: `seedLaunchablePatient`/`activateRecruitmentViaApi` autenticam com
 * `role: 'admin'` SEM grupo, que sob engine ligado é 403 `account_not_active` (achado da rodada 1
 * — mesma régua documentada em `group-simulation-itinerario-aba-sem-celula`).
 *
 * Contas por `seedStaffInGroup`/`grantCell`, `role: 'recruiter'` — nunca `role: 'admin'` sem
 * grupo. Limpeza em `finally` por `patient_id`/`service_id`.
 */
import { test, expect } from '@playwright/test';
import { insertTestPatient, insertTestWorker, cleanupTestPatient, cleanupTestWorker } from '../helpers/db-test-helper';
import { seedServiceWithLiveVacancySql, cleanupItineraryWrite } from '../helpers/itinerario-escrita-e2e-helper';
import { insertWJA, cleanupWJAAndEncuadre } from '../helpers/wja-test-helper';
import { seedStaffInGroup, cleanupStaffAndGroup, grantCell, pollAuthz, tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import {
  getServiceTeamContactApi, postServiceTeamContactApi, cleanupServiceTeamContactLog,
} from '../helpers/quadro-c-e2e-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const COM_UID = `qa.contact-api.com.${RUN_ID}`;
const SEM_UID = `qa.contact-api.sem.${RUN_ID}`;
const WA_UID = `qa.contact-api.wa.${RUN_ID}`;
const STAFF_COM: MockUser = { uid: COM_UID, email: `${COM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };
const STAFF_SEM: MockUser = { uid: SEM_UID, email: `${SEM_UID}@enlite.test`, role: 'recruiter', country: 'AR' };
const STAFF_WA: MockUser = { uid: WA_UID, email: `${WA_UID}@enlite.test`, role: 'recruiter', country: 'AR' };
const SYNTHETIC_PHONE = '+5491155501234';

interface AuthzBody { enforcement?: string; permissions?: string[] }
const hasCell = (b: AuthzBody | null, cell: string) => Array.isArray(b?.permissions) && b.permissions.includes(cell);

test.describe('service-team-contact-api sob engine ligado @integration', () => {
  test.setTimeout(180_000);

  test('service-team-contact-api', async ({ request }) => {
    let groupComId = '';
    let groupSemId = '';
    let groupWaId = '';
    let patientId = '';
    let serviceId = '';
    let workerId = '';
    let vacancyId = '';
    let strangerWorkerId = '';
    try {
      ({ groupId: groupComId } = seedStaffInGroup({ uid: COM_UID, email: STAFF_COM.email, groupName: `ContactApi COM ${RUN_ID}`, country: 'AR' }));
      ({ groupId: groupSemId } = seedStaffInGroup({ uid: SEM_UID, email: STAFF_SEM.email, groupName: `ContactApi SEM ${RUN_ID}`, country: 'AR' }));
      ({ groupId: groupWaId } = seedStaffInGroup({ uid: WA_UID, email: STAFF_WA.email, groupName: `ContactApi WA ${RUN_ID}`, country: 'AR' }));
      for (const [resource, action] of [['patient', 'read'], ['patient_identity', 'read'], ['patient_services', 'read']] as const) {
        grantCell(groupComId, resource, action);
        grantCell(groupSemId, resource, action);
        grantCell(groupWaId, resource, action);
      }
      grantCell(groupComId, 'patient_service_team', 'update');
      // STAFF_WA (rodada 3): SÓ worker_contact:read além do read básico — prova que a célula, e
      // não patient_service_team:update, é quem decide se o telefone aparece no GET.
      grantCell(groupWaId, 'worker_contact', 'read');

      const com = await pollAuthz(request, STAFF_COM, (b: AuthzBody) => b?.enforcement === 'on' && hasCell(b, 'patient_service_team:update'));
      const sem = await pollAuthz(request, STAFF_SEM, (b: AuthzBody) => b?.enforcement === 'on' && Array.isArray(b?.permissions));
      const wa = await pollAuthz(request, STAFF_WA, (b: AuthzBody) => b?.enforcement === 'on' && hasCell(b, 'worker_contact:read'));
      expect(com.body?.enforcement).toBe('on');
      expect(hasCell(com.body, 'patient_service_team:update')).toBe(true);
      expect(hasCell(sem.body, 'patient_service_team:update')).toBe(false);
      expect(hasCell(com.body, 'worker_contact:read')).toBe(false);
      expect(hasCell(wa.body, 'worker_contact:read')).toBe(true);

      // Semente 100% SQL: paciente + serviço com vaga viva + 1 prestador em Equipe de Resposta
      // Rápida (Selecionado em C) — nunca a API de lançamento (role admin sem grupo = 403 aqui).
      const seeded = insertTestPatient({ withAddress: true, firstName: 'ContactApi', lastName: `Seed-${RUN_ID}` });
      patientId = seeded.patientId;
      const svc = seedServiceWithLiveVacancySql(patientId, seeded.addressId!);
      serviceId = svc.serviceId;
      vacancyId = svc.vacancyId;
      workerId = insertTestWorker({ occupation: 'AT', whatsappPhone: SYNTHETIC_PHONE });
      insertWJA({ workerId, jobPostingId: vacancyId, funnelStage: 'QUICK_RESPONSE_TEAM' });

      const comToken = tokenFor(STAFF_COM);
      const semToken = tokenFor(STAFF_SEM);
      const waToken = tokenFor(STAFF_WA);

      // Alternativo 1: SEM patient_service_team:update → 403 no POST.
      const forbidden = await postServiceTeamContactApi(request, patientId, serviceId, workerId, semToken, {
        contacted: true, eventDate: '2026-09-29', note: 'não deveria gravar',
      });
      expect(forbidden.status).toBe(403);

      // Alternativo 2: workerId que nunca fez parte do time → 404 (não 500, não vaza existência).
      strangerWorkerId = insertTestWorker({ occupation: 'AT' });
      const notFound = await postServiceTeamContactApi(request, patientId, serviceId, strangerWorkerId, comToken, {
        contacted: true, eventDate: '2026-09-29', note: 'não deveria gravar',
      });
      expect(notFound.status).toBe(404);
      const notFoundGet = await getServiceTeamContactApi(request, patientId, serviceId, strangerWorkerId, comToken);
      expect(notFoundGet.status).toBe(404);

      // Feliz: GET antes (histórico vazio) → POST registra → GET depois (histórico com a linha).
      const before = await getServiceTeamContactApi(request, patientId, serviceId, workerId, comToken);
      expect(before.status).toBe(200);
      expect(before.body.data?.history ?? []).toHaveLength(0);
      // Alternativo 3a: COM tem patient_service_team:update mas NÃO worker_contact:read — telefone
      // sai NULL mesmo com o sintético semeado (a célula, não a ação, decide).
      expect(before.body.data?.phone ?? null).toBeNull();

      // Alternativo 3b: WA tem SÓ worker_contact:read — telefone projetado aparece.
      const waGet = await getServiceTeamContactApi(request, patientId, serviceId, workerId, waToken);
      expect(waGet.status).toBe(200);
      expect(waGet.body.data?.phone).toBe(SYNTHETIC_PHONE);

      const posted = await postServiceTeamContactApi(request, patientId, serviceId, workerId, comToken, {
        contacted: true, eventDate: '2026-09-29', note: 'Ligou e confirmou interesse',
      });
      expect(posted.status).toBe(200);
      expect(posted.body.data?.history).toHaveLength(1);
      expect(posted.body.data?.history[0].contacted).toBe(true);
      expect(posted.body.data?.history[0].note).toBe('Ligou e confirmou interesse');

      const after = await getServiceTeamContactApi(request, patientId, serviceId, workerId, comToken);
      expect(after.status).toBe(200);
      expect(after.body.data?.history).toHaveLength(1);
      expect(after.body.data?.history[0].id).toBe(posted.body.data?.history[0].id);

      // Segunda gravação: append-only — vira 2 linhas, nunca sobrescreve a primeira.
      const posted2 = await postServiceTeamContactApi(request, patientId, serviceId, workerId, comToken, {
        contacted: false, eventDate: '2026-09-30', note: null,
      });
      expect(posted2.status).toBe(200);
      expect(posted2.body.data?.history).toHaveLength(2);

      console.log('[contact-api]', com.elapsedMs >= 0, sem.elapsedMs >= 0, posted.status, posted2.body.data?.history.length);
    } finally {
      if (serviceId) cleanupServiceTeamContactLog(serviceId);
      if (patientId) cleanupItineraryWrite(patientId);
      if (workerId && vacancyId) cleanupWJAAndEncuadre(workerId, vacancyId);
      if (workerId) cleanupTestWorker(workerId);
      if (strangerWorkerId) cleanupTestWorker(strangerWorkerId);
      if (patientId) cleanupTestPatient(patientId);
      cleanupStaffAndGroup(COM_UID, groupComId);
      cleanupStaffAndGroup(SEM_UID, groupSemId);
      cleanupStaffAndGroup(WA_UID, groupWaId);
    }
  });
});
