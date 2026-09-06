/**
 * AdminPatientContractedServicesController — CRUD do serviço contratado (spec 013, bloco C).
 * Repos mockados: a prova end-to-end (SQL real, redação, guarda de posse) é o e2e
 * `tests/e2e/patient-contracted-services.e2e.test.ts`. Aqui cobrimos os ramos de
 * validação/erro que o e2e não teria como forçar sem sabotar a API.
 */
jest.mock('@modules/identity', () => ({
  AuthMiddleware: { getAuthContext: jest.fn() },
}));
jest.mock('@shared/logging', () => ({ reportError: jest.fn() }));

import { AdminPatientContractedServicesController } from '../AdminPatientContractedServicesController';
import { DeviceTypeUnknownError } from '../../../infrastructure/PatientDeviceTypeRepository';
import { ProviderAlreadyActiveError } from '../../../infrastructure/ContractedServiceProviderRepository';
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

const SERVICE = { id: SERVICE_ID, patientId: PATIENT_ID, hourlyValue: 1500 };

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
      expect(res.json.mock.calls[0][0].data.services[0]).toMatchObject({ hourlyValue: null, hourlyValueRedacted: true });
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
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { weeklyHours: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 quando o serviço pertence a OUTRO paciente (guarda de posse)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue({ ...SERVICE, patientId: 'outro-paciente' }) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { weeklyHours: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 quando atualiza com sucesso', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockResolvedValue(SERVICE) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { weeklyHours: 1 } }), res);
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
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { weeklyHours: 1 } }), res);
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
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { weeklyHours: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando rejeita com algo que não é Error', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockRejectedValue('x') };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { weeklyHours: 1 } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('associateProvider', () => {
    it('400 params inválidos', async () => {
      const controller = new AdminPatientContractedServicesController({} as never, {} as never);
      const res = mockRes();
      await controller.associateProvider(mockReq({ params: { id: PATIENT_ID, sid: 'x' }, body: { workerId: WORKER_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 body inválido (workerId ausente)', async () => {
      const repo = { findById: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.associateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('404 quando o serviço não existe ou é de outro paciente', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.associateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { workerId: WORKER_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('201 quando associa com sucesso', async () => {
      const repo = { findById: jest.fn().mockResolvedValue({ ...SERVICE, country: 'AR' }) };
      const providerRepo = { associate: jest.fn().mockResolvedValue({ id: PROVIDER_ID }) };
      const controller = new AdminPatientContractedServicesController(repo as never, providerRepo as never);
      const res = mockRes();
      await controller.associateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { workerId: WORKER_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(providerRepo.associate.mock.calls[0][0]).toMatchObject({ serviceId: SERVICE_ID, workerId: WORKER_ID, country: 'AR', actorUid: 'uid-1' });
    });

    it('409 quando o par já está ativo', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE) };
      const providerRepo = { associate: jest.fn().mockRejectedValue(new ProviderAlreadyActiveError(SERVICE_ID, WORKER_ID)) };
      const controller = new AdminPatientContractedServicesController(repo as never, providerRepo as never);
      const res = mockRes();
      await controller.associateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { workerId: WORKER_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(409);
    });

    it('500 em erro genérico', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE) };
      const providerRepo = { associate: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientContractedServicesController(repo as never, providerRepo as never);
      const res = mockRes();
      await controller.associateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { workerId: WORKER_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando rejeita com algo que não é Error', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE) };
      const providerRepo = { associate: jest.fn().mockRejectedValue('x') };
      const controller = new AdminPatientContractedServicesController(repo as never, providerRepo as never);
      const res = mockRes();
      await controller.associateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { workerId: WORKER_ID } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('updateProvider', () => {
    it('400 params inválidos', async () => {
      const controller = new AdminPatientContractedServicesController({} as never, {} as never);
      const res = mockRes();
      await controller.updateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID, pid: 'x' }, body: {} }), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('400 body inválido (active:true — só false é caminho de baixa)', async () => {
      const repo = { findById: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.updateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID, pid: PROVIDER_ID }, body: { active: true } }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('404 quando o serviço não existe/é de outro paciente', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.updateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID, pid: PROVIDER_ID }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('404 quando o :pid não pertence ao serviço', async () => {
      const repo = { findById: jest.fn().mockResolvedValue({ ...SERVICE, providers: [] }) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.updateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID, pid: PROVIDER_ID }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('200 quando atualiza com sucesso (baixa)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue({ ...SERVICE, providers: [{ id: PROVIDER_ID }] }) };
      const providerRepo = { update: jest.fn().mockResolvedValue({ id: PROVIDER_ID, active: false }) };
      const controller = new AdminPatientContractedServicesController(repo as never, providerRepo as never);
      const res = mockRes();
      await controller.updateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID, pid: PROVIDER_ID }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(providerRepo.update.mock.calls[0]).toEqual([PROVIDER_ID, { active: false, actorUid: 'uid-1' }]);
    });

    it('500 em erro genérico', async () => {
      const repo = { findById: jest.fn().mockResolvedValue({ ...SERVICE, providers: [{ id: PROVIDER_ID }] }) };
      const providerRepo = { update: jest.fn().mockRejectedValue(new Error('boom')) };
      const controller = new AdminPatientContractedServicesController(repo as never, providerRepo as never);
      const res = mockRes();
      await controller.updateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID, pid: PROVIDER_ID }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('500 quando rejeita com algo que não é Error', async () => {
      const repo = { findById: jest.fn().mockResolvedValue({ ...SERVICE, providers: [{ id: PROVIDER_ID }] }) };
      const providerRepo = { update: jest.fn().mockRejectedValue('x') };
      const controller = new AdminPatientContractedServicesController(repo as never, providerRepo as never);
      const res = mockRes();
      await controller.updateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID, pid: PROVIDER_ID }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    // C8: `update()` devolve null quando a linha sumiu entre o findById e o UPDATE — 200 com
    // `data: null` mente para um cliente que tipa o campo como não-nulo
    // (AdminContractedServicesApiService.ts:126). O irmão `update` do serviço já devolve 404.
    it('C8: 404 (nunca 200 com data:null) quando a alocação some entre a leitura e a escrita', async () => {
      const repo = { findById: jest.fn().mockResolvedValue({ ...SERVICE, providers: [{ id: PROVIDER_ID }] }) };
      const providerRepo = { update: jest.fn().mockResolvedValue(null) };
      const controller = new AdminPatientContractedServicesController(repo as never, providerRepo as never);
      const res = mockRes();
      await controller.updateProvider(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID, pid: PROVIDER_ID }, body: { active: false } }), res);
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json.mock.calls[0][0]).toEqual({ success: false, error: 'Provider allocation not found' });
    });
  });

  // ── C4: quem não pode LER `hourlyValue` também não o ESCREVE ──────────────────────────────
  //
  // A rota é `staffOnly` e o schema aceita `hourlyValue` de qualquer um. Um `recruiter` recebe
  // `hourlyValue: null, hourlyValueRedacted: true` em TODA leitura (projectContractedServiceForActor)
  // e podia gravar 0 por cima do valor que não vê. É a mesma regra que o módulo já enforça para
  // `emergencyInstructions` e `onHoldNote` (AdminPatientsController).
  describe('C4 — hourlyValue: leitura restrita, escrita idem', () => {
    const naoAdmin = { roles: ['recruiter'] };

    it('create: recruiter mandando hourlyValue → 403 e o repositório NÃO é chamado', async () => {
      const repo = { create: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT', hourlyValue: 0 }, user: naoAdmin }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json.mock.calls[0][0]).toMatchObject({ success: false, details: { field: 'hourlyValue' } });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('update: recruiter mandando hourlyValue → 403 e o repositório NÃO é chamado', async () => {
      const repo = { findById: jest.fn(), update: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { hourlyValue: 0 }, user: naoAdmin }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('update: recruiter mandando `hourlyValue: null` (APAGAR) também é 403 — a chave é que manda', async () => {
      const repo = { findById: jest.fn(), update: jest.fn() };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { hourlyValue: null }, user: naoAdmin }), res);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('recruiter SEM a chave passa normalmente (a trava é do campo, não da rota)', async () => {
      const repo = { findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockResolvedValue(SERVICE) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { weeklyHours: 10 }, user: naoAdmin }), res);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(repo.update).toHaveBeenCalled();
    });

    it('construtor sem repositórios injetados constrói os reais (pool preguiçoso — não abre conexão)', () => {
      expect(new AdminPatientContractedServicesController()).toBeInstanceOf(AdminPatientContractedServicesController);
    });

    it('admin mandando hourlyValue passa (create e update)', async () => {
      const repo = { create: jest.fn().mockResolvedValue(SERVICE), findById: jest.fn().mockResolvedValue(SERVICE), update: jest.fn().mockResolvedValue(SERVICE) };
      const controller = new AdminPatientContractedServicesController(repo as never, {} as never);
      const res1 = mockRes();
      await controller.create(mockReq({ params: { id: PATIENT_ID }, body: { serviceCode: 'AT', hourlyValue: 1500 } }), res1);
      expect(res1.status).toHaveBeenCalledWith(201);
      const res2 = mockRes();
      await controller.update(mockReq({ params: { id: PATIENT_ID, sid: SERVICE_ID }, body: { hourlyValue: 1500 } }), res2);
      expect(res2.status).toHaveBeenCalledWith(200);
    });
  });
});
