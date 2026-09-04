/**
 * adminPatientsRoutes.test.ts
 *
 * Cada rota chama o método certo do controller certo, sob a guarda certa, e
 * as estáticas (/stats, /funnel, /chat-map, /map) vêm ANTES de /patients/:id.
 */
// Os defaults do router instanciam controllers reais (que abrem pool/KMS);
// aqui eles viram classes vazias — o que se testa é a fiação, não o controller.
jest.mock('../../controllers/AdminPatientChatIdsController', () => ({ AdminPatientChatIdsController: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../controllers/AdminPatientChatRolesController', () => ({ AdminPatientChatRolesController: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../controllers/AdminPatientsMapController', () => ({ AdminPatientsMapController: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../controllers/AdminPatientAddressesController', () => ({ AdminPatientAddressesController: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../controllers/AdminInsuranceProvidersController', () => ({ AdminInsuranceProvidersController: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../controllers/AdminPatientContractedServicesController', () => ({ AdminPatientContractedServicesController: jest.fn().mockImplementation(() => ({})) }));
jest.mock('@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController', () => ({ AdminPatientDiagnosesController: jest.fn().mockImplementation(() => ({})) }));
jest.mock('@modules/terminology/interfaces/controllers/AdminTerminologySearchController', () => ({ AdminTerminologySearchController: jest.fn().mockImplementation(() => ({})) }));

import express from 'express';
import request from 'supertest';
import { createAdminPatientsRoutes } from '../adminPatientsRoutes';
import type { AdminPatientsController } from '../../controllers/AdminPatientsController';
import type { AdminPatientChatIdsController } from '../../controllers/AdminPatientChatIdsController';
import type { AdminPatientChatRolesController } from '../../controllers/AdminPatientChatRolesController';
import type { AdminPatientsMapController } from '../../controllers/AdminPatientsMapController';
import type { AdminPatientAddressesController } from '../../controllers/AdminPatientAddressesController';
import type { AdminInsuranceProvidersController } from '../../controllers/AdminInsuranceProvidersController';
import type { AdminPatientContractedServicesController } from '../../controllers/AdminPatientContractedServicesController';
import type { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import type { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import type { AuthMiddleware } from '@modules/identity';

type Handler = (req: express.Request, res: express.Response) => void;
const calls: Record<string, jest.Mock> = {};
const c = (name: string): Handler =>
  (calls[name] = jest.fn((_req: express.Request, res: express.Response) => { res.status(200).json({ handler: name }); }));

const controller = {
  getPatientStats: c('getPatientStats'), getPatientFunnel: c('getPatientFunnel'), listPatients: c('listPatients'),
  createPatient: c('createPatient'), getPatientById: c('getPatientById'), listPatientAddresses: c('listPatientAddresses'),
  createPatientAddress: c('createPatientAddress'), listPatientVacancies: c('listPatientVacancies'),
  updatePatientStatus: c('updatePatientStatus'), activatePatient: c('activatePatient'),
  updatePatientTestFlag: c('updatePatientTestFlag'), purgeTestPatient: c('purgeTestPatient'), updatePatientSection: c('updatePatientSection'),
  getPatientStatusHistory: c('getPatientStatusHistory'),
} as unknown as AdminPatientsController;
const chatIds = { getChatGroups: c('getChatGroups'), getChatMap: c('getChatMap'), getChatCandidates: c('getChatCandidates'), updateChatIds: c('updateChatIds') } as unknown as AdminPatientChatIdsController;
const chatRoles = { list: c('rolesList'), create: c('rolesCreate'), update: c('rolesUpdate'), delete: c('rolesDelete') } as unknown as AdminPatientChatRolesController;
const mapController = { getMapPoints: c('getMapPoints') } as unknown as AdminPatientsMapController;
const addresses = { updatePatientAddress: c('updatePatientAddress') } as unknown as AdminPatientAddressesController;
const providers = { list: c('providersList'), create: c('providersCreate') } as unknown as AdminInsuranceProvidersController;
// Spec 013 (bloco C): CRUD do serviço contratado — sem DELETE (lex C-a.4/C-e.2).
const contractedServices = {
  list: c('csList'), create: c('csCreate'), update: c('csUpdate'),
  associateProvider: c('csAssociateProvider'), updateProvider: c('csUpdateProvider'),
} as unknown as AdminPatientContractedServicesController;
// Spec 016 F2 (D263): diagnóstico estruturado CID-11 — sem DELETE físico.
const diagnoses = { list: c('diagList'), create: c('diagCreate'), update: c('diagUpdate') } as unknown as AdminPatientDiagnosesController;
const terminologySearch = { search: c('terminologySearch') } as unknown as AdminTerminologySearchController;

const seen: string[] = [];
const guard = (label: string) => (req: express.Request, _res: express.Response, next: express.NextFunction) => { seen.push(`${label} ${req.method} ${req.path}`); next(); };
const authMiddleware = { requireStaff: () => guard('staff'), requireAdmin: () => guard('admin') } as unknown as AuthMiddleware;

const app = express();
app.use(express.json());
app.use('/api/admin', createAdminPatientsRoutes(controller, authMiddleware, chatIds, chatRoles, mapController, addresses, providers, contractedServices, diagnoses, terminologySearch));

const ID = '11111111-1111-1111-1111-111111111111';

describe('createAdminPatientsRoutes', () => {
  beforeEach(() => { seen.length = 0; jest.clearAllMocks(); });

  const cases: Array<[string, string, string, string]> = [
    ['get', '/patient-chat-roles', 'rolesList', 'staff'],
    ['post', '/patient-chat-roles', 'rolesCreate', 'admin'],
    ['patch', '/patient-chat-roles/family', 'rolesUpdate', 'admin'],
    ['delete', '/patient-chat-roles/family', 'rolesDelete', 'admin'],
    ['get', '/chat-groups', 'getChatGroups', 'staff'],
    ['get', '/patients/stats', 'getPatientStats', 'staff'],
    ['get', '/patients/funnel', 'getPatientFunnel', 'staff'],
    ['get', '/patients/chat-map', 'getChatMap', 'staff'],
    ['post', '/patients/map', 'getMapPoints', 'staff'],
    ['get', '/patients', 'listPatients', 'staff'],
    ['post', '/patients', 'createPatient', 'staff'],
    ['get', `/patients/${ID}`, 'getPatientById', 'staff'],
    ['get', `/patients/${ID}/addresses`, 'listPatientAddresses', 'staff'],
    ['post', `/patients/${ID}/addresses`, 'createPatientAddress', 'staff'],
    ['get', `/patients/${ID}/vacancies`, 'listPatientVacancies', 'staff'],
    ['put', `/patients/${ID}/status`, 'updatePatientStatus', 'staff'],
    ['post', `/patients/${ID}/activate`, 'activatePatient', 'staff'],
    ['get', `/patients/${ID}/chat-candidates`, 'getChatCandidates', 'staff'],
    ['put', `/patients/${ID}/chat-ids`, 'updateChatIds', 'staff'],
    ['patch', `/patients/${ID}/test-flag`, 'updatePatientTestFlag', 'admin'],
    ['delete', `/patients/${ID}`, 'purgeTestPatient', 'admin'],
    ['patch', `/patients/${ID}/clinical`, 'updatePatientSection', 'staff'],
    // Spec 012 (bloco B): catálogo de coberturas, Historial, logística por endereço, seção coverage.
    ['get', '/catalogs/insurance-providers', 'providersList', 'staff'],
    ['post', '/catalogs/insurance-providers', 'providersCreate', 'admin'],
    ['get', `/patients/${ID}/status-history`, 'getPatientStatusHistory', 'staff'],
    ['patch', `/patients/${ID}/addresses/${ID}`, 'updatePatientAddress', 'staff'],
    ['patch', `/patients/${ID}/coverage`, 'updatePatientSection', 'staff'],
    // Spec 013 (bloco C): serviço contratado — literais ANTES do PATCH dinâmico /:id/:section.
    ['get', `/patients/${ID}/contracted-services`, 'csList', 'staff'],
    ['post', `/patients/${ID}/contracted-services`, 'csCreate', 'staff'],
    ['patch', `/patients/${ID}/contracted-services/${ID}`, 'csUpdate', 'staff'],
    ['post', `/patients/${ID}/contracted-services/${ID}/providers`, 'csAssociateProvider', 'staff'],
    ['patch', `/patients/${ID}/contracted-services/${ID}/providers/${ID}`, 'csUpdateProvider', 'staff'],
    // Spec 016 F2 (D263): diagnóstico estruturado CID-11 — literais ANTES do PATCH dinâmico.
    ['get', `/patients/${ID}/diagnoses`, 'diagList', 'staff'],
    ['post', `/patients/${ID}/diagnoses`, 'diagCreate', 'staff'],
    ['patch', `/patients/${ID}/diagnoses/${ID}`, 'diagUpdate', 'staff'],
    ['get', '/terminology/search', 'terminologySearch', 'staff'],
  ];

  it.each(cases)('%s %s → %s (guarda %s)', async (method, path, handler, guardLabel) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](`/api/admin${path}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ handler });
    expect(calls[handler]).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([`${guardLabel} ${method.toUpperCase()} ${path}`]);
  });

  it('GET /patients/map não é o mapa (é POST): cai em /patients/:id', async () => {
    const res = await request(app).get('/api/admin/patients/map');
    expect(res.body).toEqual({ handler: 'getPatientById' });
    expect(calls.getMapPoints).not.toHaveBeenCalled();
  });

  it('os controllers de chat e mapa têm default (não precisam ser injetados)', () => {
    const router = createAdminPatientsRoutes(controller, authMiddleware);
    const paths = (router.stack as Array<{ route?: { path: string } }>).map((l) => l.route?.path).filter(Boolean);
    expect(paths).toContain('/patients/map');
    expect(paths).toContain('/chat-groups');
    expect(paths).toContain('/catalogs/insurance-providers');
    expect(paths).toContain('/patients/:patientId/addresses/:addressId');
    expect(paths).toContain('/patients/:id/contracted-services');
    expect(paths).toContain('/patients/:id/contracted-services/:sid');
    expect(paths).toContain('/patients/:id/contracted-services/:sid/providers');
    expect(paths).toContain('/patients/:id/contracted-services/:sid/providers/:pid');
    expect(paths).toContain('/patients/:id/diagnoses');
    expect(paths).toContain('/patients/:id/diagnoses/:did');
    expect(paths).toContain('/terminology/search');
  });
});
