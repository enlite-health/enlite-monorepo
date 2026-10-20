/**
 * AdminPatientContractedServicesController — CRUD do serviço contratado (spec 013, bloco C).
 * Repos mockados: a prova end-to-end (SQL real, redação, guarda de posse) é o e2e
 * `tests/e2e/patient-contracted-services.e2e.test.ts`. Aqui cobrimos os ramos de
 * validação/erro que o e2e não teria como forçar sem sabotar a API.
 */
jest.mock('@modules/identity', () => ({
  AuthMiddleware: { getAuthContext: jest.fn() },
}));
// spec 029 — `loggingAls` entrou no mock porque `vacancyActorFromRequest` (chamado pelo novo
// 3º argumento de `activateRecruitment`) importa `loggingAls` de `@shared/logging`; sem ele
// aqui, `loggingAls` fica `undefined` e `.getStore()` lança — TODO teste de `activateRecruitment`
// cai em 500 (visto no RED: "Cannot read properties of undefined").
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), loggingAls: { getStore: jest.fn().mockReturnValue(undefined) } }));

import { AdminPatientContractedServicesController } from '../AdminPatientContractedServicesController';
import { DeviceTypeUnknownError } from '../../../infrastructure/PatientDeviceTypeRepository';
import { AddressNotOfPatientError, ServiceFieldRequiredByLiveVacancyError } from '../../../infrastructure/PatientContractedServiceRepository';
import { SlotHasActiveAllocationError } from '../../../application/ItinerarySlotWriteUseCase';
import { ServiceSlotOverlapError } from '../../../infrastructure/ServiceSlotWriter';
import { reportError } from '@shared/logging';
import { AuthMiddleware } from '@modules/identity';
import type { Response } from 'express';

const PATIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE_ID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
const PROVIDER_ID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';
const WORKER_ID = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';

function mockReq(overrides: Record<string, unknown> = {}) {
  return { params: {}, body: {}, user: { roles: ['admin'] }, ...overrides } as never;
}
function mockRes(): Response & { status: jest.Mock; json: jest.Mock } {
  const res: { status: jest.Mock; json: jest.Mock } = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

const LIVE_VACANCY = { id: 'v-1', caseNumber: 1234, caseOrdinal: 1, status: 'SEARCHING' };
const NAMES = { providerCode: 'OSDE', providerName: 'OSDE', contractId: 'c-1', contractName: 'OSDE 210', payerKind: 'OBRA_SOCIAL' };
/** Spec 058: o serviço montado traz pagador/preço/imposto/divergência (a projeção por ator os lê). */
const SERVICE = {
  id: SERVICE_ID,
  patientId: PATIENT_ID,
  liveVacancy: LIVE_VACANCY,
  payer: { state: 'LINKED', isPrivate: false, validFrom: '2026-01-01', validTo: null, names: NAMES },
  payerHistory: [],
  price: { state: 'OK', hourlyRate: 1500, currency: 'ARS' },
  tax: { state: 'OK', taxRatePercent: 21 },
  coverageMatch: { state: 'MATCH' },
};

describe('AdminPatientContractedServicesController', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue({ principal: { id: 'uid-1' } });
  });

  describe('list', () => {
    it('400 quando :id não é UUID', async () => {
      const repo = { listForPatient: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: 'not-a-uuid' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.listForPatient).not.toHaveBeenCalled();
    });

    it('200 com a lista projetada por papel', async () => {
      const repo = { listForPatient: jest.fn().mockResolvedValue([SERVICE]) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID }, user: { roles: ['recruiter'] } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json.mock.calls[0][0].data.services[0]).toMatchObject({ price: { state: 'REDACTED' }, tax: { state: 'OK', taxRatePercent: 21 } });
      expect(res.json.mock.calls[0][0].data.services[0]).not.toHaveProperty('hourlyValue');
    });

    it('047 A1/A2/A3: com vacancy:read a vaga sai inteira (4 chaves); sem a célula → null + redigida; preço redigido à parte', async () => {
      const repo = { listForPatient: jest.fn().mockResolvedValue([SERVICE]) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);

      const resCom = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID }, user: { roles: ['recruiter'] }, permissionCells: ['vacancy:read'] }), resCom);
      const com = resCom.json.mock.calls[0][0].data.services[0];
      expect(com).toMatchObject({ liveVacancy: LIVE_VACANCY, liveVacancyRedacted: false, price: { state: 'REDACTED' } });
      expect(Object.keys(com.liveVacancy).sort()).toEqual(['caseNumber', 'caseOrdinal', 'id', 'status']);

      const resSem = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID }, user: { roles: ['admin'] }, permissionCells: ['patient_services:read'] }), resSem);
      expect(resSem.json.mock.calls[0][0].data.services[0]).toMatchObject({ liveVacancy: null, liveVacancyRedacted: true });
    });

    it('500 quando o repo lança', async () => {
      const repo = { listForPatient: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando o repo rejeita com algo que NÃO é Error (String(err) no reportError)', async () => {
      const repo = { listForPatient: jest.fn().mockRejectedValue('rejeição crua') };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.list(mockReq({ params: { id: PATIENT_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('create', () => {
    it('400 quando :id não é UUID', async () => {
      const repo = { create: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: 'not-a-uuid' }, body: { serviceCode: 'AT' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('400 body inválido (serviceCode fora do vocabulário)', async () => {
      const repo = { create: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'INEXISTENTE' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('201 quando cria com sucesso', async () => {
      const repo = { create: jest.fn().mockResolvedValue(SERVICE) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT' } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(repo.create.mock.calls[0][0]).toMatchObject({ patientId: PATIENT_ID, serviceCode: 'AT', actorUid: 'uid-1' });
    });

    // Spec 015 (US-A6.1, FR-2): providerAgeBand aceito e repassado ao repo tal qual os demais
    // enums do schema (careLocation, contractType, ...) — mesmo molde da linha acima.
    it('201 quando cria com providerAgeBand válido, repassado ao repo', async () => {
      const repo = { create: jest.fn().mockResolvedValue({ ...SERVICE, providerAgeBand: 'AGE_30_45' }) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT', providerAgeBand: 'AGE_30_45' } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(repo.create.mock.calls[0][0]).toMatchObject({ providerAgeBand: 'AGE_30_45' });
    });

    // FR-2 pede "422 fora do enum"; a convenção VIVA deste controller (molde bloco C, teste
    // acima "serviceCode fora do vocabulário") responde 400 para TODO erro de validação zod
    // (`body.success===false`) — 422 fica reservado a `DeviceTypeUnknownError`, um erro de
    // NEGÓCIO descoberto DEPOIS do parse, não de shape do body. Dar 422 só a este campo
        // quebraria a consistência entre os enums do MESMO schema — ver LISTA do relatório.
    it('400 body inválido (providerAgeBand fora do vocabulário) — mesma convenção dos demais enums deste schema', async () => {
      const repo = { create: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT', providerAgeBand: 'INEXISTENTE' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('422 quando o repo lança DeviceTypeUnknownError', async () => {
      const repo = { create: jest.fn().mockRejectedValue(new DeviceTypeUnknownError(['X'])) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT' } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
    });

    // Migration 330: o banco recusou addressId de outro paciente (FK composta) → 422 com código.
    it('422 ADDRESS_NOT_OF_PATIENT quando o repo lança AddressNotOfPatientError (create)', async () => {
      const repo = { create: jest.fn().mockRejectedValue(new AddressNotOfPatientError('addr-alheio')) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT', addressId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ADDRESS_NOT_OF_PATIENT', details: { addressId: 'addr-alheio' } }));
    });

    it('500 em erro genérico', async () => {
      const repo = { create: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando rejeita com algo que não é Error', async () => {
      const repo = { create: jest.fn().mockRejectedValue(42) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT' } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('actorUid "unknown" quando não há auth context (defesa)', async () => {
      (AuthMiddleware.getAuthContext as jest.Mock).mockReturnValue(undefined);
      const repo = { create: jest.fn().mockResolvedValue(SERVICE) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT' } }), res);
      expect(repo.create.mock.calls[0][0].actorUid).toBe('unknown');
    });
  });

  describe('update', () => {
    it('400 quando params inválidos', async () => {
      const repo = { findById: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: 'not-uuid' } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 body inválido', async () => {
      const repo = { findById: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { active: true } }), res);
      expect(res.status).toHaveBeenCalledWith(400); // z.literal(false) recusa true
      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('404 quando o serviço não existe', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { providersNeeded: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 quando o serviço pertence a OUTRO paciente (guarda de posse)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue({ ...SERVICE, patientId: 'outro-paciente' }) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { providersNeeded: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('422 ADDRESS_NOT_OF_PATIENT quando o repo lança AddressNotOfPatientError (update)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockRejectedValue(new AddressNotOfPatientError('addr-alheio')) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { addressId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ADDRESS_NOT_OF_PATIENT' }));
    });

    it('422 SLOT_HAS_ACTIVE_ALLOCATION nomeando o slot quando o sync recusa desativar slot alocado (D442)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockRejectedValue(new SlotHasActiveAllocationError('svc', 'slot-1')) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { schedule: null } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, code: 'SLOT_HAS_ACTIVE_ALLOCATION', details: { slotId: 'slot-1' } }),
      );
      expect(reportError).not.toHaveBeenCalled();
      console.log('[12.P4]', 'status', res.status.mock.calls[0][0], 'code', res.json.mock.calls[0][0].code);
    });

    it('ServiceSlotOverlapError → 409 SLOT_OVERLAP (PATCH e POST), sem reportError', async () => {
      const body = { schedule: [{ dayOfWeek: 1, startTime: '08:00', durationMinutes: 240 }] };
      const repo = {
        findById: jest.fn().mockResolvedValue(SERVICE),
        update: jest.fn().mockRejectedValue(new ServiceSlotOverlapError('svc')),
        create: jest.fn().mockRejectedValue(new ServiceSlotOverlapError('svc')),
      };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, code: 'SLOT_OVERLAP' }));
      const res2 = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT', ...body } }), res2);
      expect(res2.status).toHaveBeenCalledWith(409);
      expect(res2.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SLOT_OVERLAP' }));
      expect(reportError).not.toHaveBeenCalled();
    });

    it('422 SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY quando o repo recusa apagar o horário com vaga viva (F2)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockRejectedValue(new ServiceFieldRequiredByLiveVacancyError('schedule', ['vac-1'])) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { schedule: null } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'SERVICE_FIELD_REQUIRED_BY_LIVE_VACANCY', details: { field: 'schedule', vacancyIds: ['vac-1'] } }));
    });

    it('200 quando atualiza com sucesso', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockResolvedValue(SERVICE) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { providersNeeded: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    // Spec 015 (US-A6.1, FR-2): providerAgeBand aceito no PATCH e repassado ao repo.
    it('200 quando atualiza providerAgeBand, repassado ao repo', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockResolvedValue({ ...SERVICE, providerAgeBand: 'ANY' }) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { providerAgeBand: 'ANY' } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.update.mock.calls[0][1]).toMatchObject({ providerAgeBand: 'ANY' });
    });

    it('404 quando update devolve null (corrida: apagado entre o findById e o UPDATE)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { providersNeeded: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('422 quando update lança DeviceTypeUnknownError', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockRejectedValue(new DeviceTypeUnknownError(['X'])) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { deviceTypeCodes: ['X'] } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
    });

    it('500 em erro genérico', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { providersNeeded: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando rejeita com algo que não é Error', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockRejectedValue('x') };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { providersNeeded: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  // ── C4 (histórico): quem não podia LER `hourlyValue` também não o ESCREVIA ─────────────────
  //
  // Spec 058 T054/T055: `hourlyValue` não é mais campo do serviço (o preço vem do termo do contrato). A guarda 403 de escrita saiu junto;
  // a chave legada vira 422 `LEGACY_FIELD_REMOVED` na rota (T064/T065, A1.4) — antes do ABAC. Aqui fica o que a rota ainda faz.
  describe('sem hourlyValue no serviço (spec 058)', () => {
    const naoAdmin = { roles: ['recruiter'] };

    it('recruiter atualiza campos do serviço normalmente (o preço não é mais campo do serviço)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockResolvedValue(SERVICE) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { providersNeeded: 10 }, user: naoAdmin }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.update).toHaveBeenCalled();
    });

    it('construtor sem repositórios injetados constrói os reais (pool preguiçoso — não abre conexão)', () => {
      expect(new AdminPatientContractedServicesController()).toBeInstanceOf(AdminPatientContractedServicesController);
    });
  });

  // spec 018, PR-6, ADR-5, contracts/activation.md
  describe('activateRecruitment', () => {
    it('400 quando params inválidos', async () => {
      const useCase = { execute: jest.fn() };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: 'not-a-uuid', sid: SERVICE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(useCase.execute).not.toHaveBeenCalled();
    });

    it('201 quando o use case cria a vaga — devolve vacancyId/patientStatus/statusChanged', async () => {
      const useCase = { execute: jest.fn().mockResolvedValue({ vacancyId: 'vac-1', patientStatus: 'SEARCHING', statusChanged: true }) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, user: { uid: 'staff-uid-1', roles: ['admin'] } }), res);
      expect(useCase.execute).toHaveBeenCalledWith(
        PATIENT_ID,
        SERVICE_ID,
        expect.objectContaining({ actorUserId: 'staff-uid-1', actorType: 'HUMAN', actorLabel: 'activate_recruitment' }),
      );
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { vacancyId: 'vac-1', patientStatus: 'SEARCHING', statusChanged: true },
      });
    });

    it('D469 — 201 repassa patientNotMoved (só códigos) quando o paciente não moveu por completude', async () => {
      const useCase = { execute: jest.fn().mockResolvedValue({
        vacancyId: 'vac-3', patientStatus: 'ADMISSION', statusChanged: false, patientNotMoved: { missing: ['SERVICE_SCHEDULE'] },
      }) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { vacancyId: 'vac-3', patientStatus: 'ADMISSION', statusChanged: false, patientNotMoved: { missing: ['SERVICE_SCHEDULE'] } },
      });
    });

    // spec 029 — achado: o botão gravava SYSTEM/actor_user_id null mesmo com operador humano
    // autenticado. Prova por posição do argumento (`mock.calls[0][2]`), igualdade exata com o
    // uid do req autenticado — não só "truthy" ou "não nulo".
    it('spec 029 — 3º argumento de execute() é o HumanActor derivado do uid autenticado da request (mock.calls[0][2])', async () => {
      const useCase = { execute: jest.fn().mockResolvedValue({ vacancyId: 'vac-2', patientStatus: 'ADMISSION', statusChanged: false }) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      const authenticatedUid = 'staff-uid-autenticado-2';
      await controller.activateRecruitment(
        mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, user: { uid: authenticatedUid, roles: ['admin'] } }),
        res,
      );
      const actorArg = useCase.execute.mock.calls[0][2];
      expect(actorArg.actorUserId).toBe(authenticatedUid);
      expect(actorArg.actorType).toBe('HUMAN');
      expect(actorArg.actorLabel).toBe('activate_recruitment');
    });

    // spec 029 — sem uid na request (chamada sem operador identificável): NÃO usa
    // `actorUid()` (que teria fallback 'unknown' e poluiria a coluna) — vira SYSTEM/null,
    // igual ao comportamento anterior a esta mudança.
    it('spec 029 — request sem user.uid → 3º argumento cai para SYSTEM/actorUserId null (nunca "unknown")', async () => {
      const useCase = { execute: jest.fn().mockResolvedValue({ vacancyId: 'vac-3', patientStatus: 'ADMISSION', statusChanged: false }) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(
        mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, user: { roles: ['admin'] } }),
        res,
      );
      const actorArg = useCase.execute.mock.calls[0][2];
      expect(actorArg.actorUserId).toBeNull();
      expect(actorArg.actorType).toBe('SYSTEM');
    });

    it('404 quando o paciente não existe', async () => {
      const { PatientNotFoundForRecruitmentError } = jest.requireActual('../../../application/ActivateRecruitmentUseCase');
      const useCase = { execute: jest.fn().mockRejectedValue(new PatientNotFoundForRecruitmentError(PATIENT_ID)) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, code: 'NOT_FOUND' });
    });

    it('404 quando o serviço não existe / é de outro paciente / está inativo', async () => {
      const { ServiceNotFoundForRecruitmentError } = jest.requireActual('../../../application/ActivateRecruitmentUseCase');
      const useCase = { execute: jest.fn().mockRejectedValue(new ServiceNotFoundForRecruitmentError(PATIENT_ID, SERVICE_ID)) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ success: false, code: 'NOT_FOUND' });
    });

    it('409 quando o serviço já tem vaga viva — devolve o vacancyId existente', async () => {
      const { ServiceAlreadyRecruitingError } = jest.requireActual('../../../application/ActivateRecruitmentUseCase');
      const useCase = { execute: jest.fn().mockRejectedValue(new ServiceAlreadyRecruitingError('vac-old')) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({ success: false, code: 'SERVICE_ALREADY_RECRUITING', vacancyId: 'vac-old' });
    });

    it('422 quando o gate recusa — devolve PATIENT_NOT_READY com details.missing', async () => {
      const { RecruitmentNotReadyError } = jest.requireActual('../../../application/ActivateRecruitmentUseCase');
      const useCase = { execute: jest.fn().mockRejectedValue(new RecruitmentNotReadyError(PATIENT_ID, SERVICE_ID, ['SERVICE_SCHEDULE'])) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json.mock.calls[0][0]).toMatchObject({
        success: false,
        code: 'PATIENT_NOT_READY',
        details: { missing: ['SERVICE_SCHEDULE'] },
      });
    });

    it('500 em erro genérico (instância de Error)', async () => {
      const useCase = { execute: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando rejeita com algo que não é Error', async () => {
      const useCase = { execute: jest.fn().mockRejectedValue('rejeição crua') };
      const controller = new AdminPatientContractedServicesController({} as never, useCase as never);
      const res = mockRes();
      await controller.activateRecruitment(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Failed to activate recruitment' });
    });

    it('construtor sem use case injetado constrói o real (pool preguiçoso — não abre conexão)', () => {
      expect(new AdminPatientContractedServicesController()).toBeInstanceOf(AdminPatientContractedServicesController);
    });
  });
});
