/**
 * A 2ª família a declarar célula (task 3.5). Mesmo contrato do
 * `adminUsersRoutes.test.ts`: varre o router de VERDADE com o mesmo
 * `scanExpressRouter` que alimenta o catálogo, e afirma que toda rota declara —
 * e declara a célula do mapa, copiada de `route-permission-map.md` e não do
 * código (senão o teste concordaria com qualquer erro que eu tivesse cometido).
 *
 * ⚠️ Cobre só esta família. O oráculo das 226 rotas do app é o e2e
 * `permission-route-inventory`, contra o app de pé.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { createAdminPatientsRoutes, ADMIN_PATIENTS_FAMILY } from '../adminPatientsRoutes';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import type { AdminPatientsController } from '../../controllers/AdminPatientsController';
import type { AdminPatientChatIdsController } from '../../controllers/AdminPatientChatIdsController';
import type { AdminPatientChatRolesController } from '../../controllers/AdminPatientChatRolesController';
import type { AdminPatientsMapController } from '../../controllers/AdminPatientsMapController';
import type { AdminPatientAddressesController } from '../../controllers/AdminPatientAddressesController';
import type { AdminInsuranceProvidersController } from '../../controllers/AdminInsuranceProvidersController';
import type { AdminPatientContractedServicesController } from '../../controllers/AdminPatientContractedServicesController';
import type { AdminPatientDiagnosesController } from '@modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController';
import type { AdminTerminologySearchController } from '@modules/terminology/interfaces/controllers/AdminTerminologySearchController';
import type { AdminPatientContactRowsController } from '../../controllers/AdminPatientContactRowsController';
import type { AdminPatientExternalContactsController } from '../../controllers/AdminPatientExternalContactsController';
import type { AdminPatientEmergencyContactController } from '../../controllers/AdminPatientEmergencyContactController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

/**
 * O guard de país é assunto de outra task — aqui ele não pode atrapalhar, mas
 * também não pode ser um buraco: o dublê EXECUTA o extrator que a rota passou,
 * para o teste conseguir afirmar de ONDE o país saiu (body × query). Sem isso o
 * `(req) => req.body?.country` do POST /patients nunca rodaria, e a única linha
 * do arquivo com lógica de verdade ficaria sem cobertura.
 */
let mockPaisVisto: string | undefined;
jest.mock('@modules/identity/interfaces/middleware/countryScopeGuard', () => ({
  requireCountryScope:
    (extrator?: (req: unknown) => string | undefined) =>
    (req: unknown, _res: unknown, next: () => void) => {
      mockPaisVisto = extrator ? extrator(req) : undefined;
      next();
    },
}));

/** A trilha de leitura de ficha é testada no e2e dela; aqui é ruído. */
jest.mock('@shared/audit/resourceAccessLog', () => ({
  logResourceAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

/** Mapa esperado — copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string | null> = {
  'GET /patient-chat-roles': 'patient:read',
  'POST /patient-chat-roles': 'patient:create',
  'PATCH /patient-chat-roles/:code': 'patient:update',
  'DELETE /patient-chat-roles/:code': 'patient:update',
  // Catálogo de coberturas (mig 311, spec 012): mesma régua dos papéis de chat.
  'GET /catalogs/insurance-providers': 'patient_coverage:read',
  'POST /catalogs/insurance-providers': 'patient:create',
  'GET /chat-groups': 'messaging:read',
  'GET /patients/stats': 'patient:read',
  'GET /patients/funnel': 'patient:read',
  'GET /patients/chat-map': 'patient:read',
  // Mapa de pacientes (REQ-04): POST com corpo, leitura.
  'POST /patients/map': 'patient_address:read',
  'GET /patients': 'patient:read',
  'POST /patients': 'patient:create',
  'GET /patients/:id': 'patient:read',
  // D286: endereços são o container `patient_address` — a mesma célula vale no mapa (lex C7).
  'GET /patients/:patientId/addresses': 'patient_address:read',
  'POST /patients/:patientId/addresses': 'patient_address:create',
  'PATCH /patients/:patientId/addresses/:addressId': 'patient_address:update',
  'GET /patients/:id/vacancies': 'vacancy:read',
  'PUT /patients/:id/status': 'patient:update',
  'GET /patients/:id/status-history': 'patient:read',
  // 410 (spec 018, PR-6, ADR-5): ativar deixou de ser rota única do paciente. Sem célula, como o
  // 410 de support-network.
  'POST /patients/:id/activate': null,
  'POST /patients/:id/contracted-services/:sid/activate-recruitment': 'patient_services:update',
  'GET /patients/:id/chat-candidates': 'messaging:read',
  'PUT /patients/:id/chat-ids': 'patient_chat:update',
  'PATCH /patients/:id/test-flag': 'patient:update',
  'DELETE /patients/:id': 'patient:delete',
  // Serviço contratado (spec 013), diagnósticos CID-11 (spec 016) e terminologia —
  // sob a célula GROSSA no sync main→stage; o fatiamento por container é a D286.
  'GET /patients/:id/contracted-services': 'patient_services:read',
  'POST /patients/:id/contracted-services': 'patient_services:create',
  'PATCH /patients/:id/contracted-services/:sid': 'patient_services:update',
  'POST /patients/:id/contracted-services/:sid/providers': 'patient_services:update',
  'PATCH /patients/:id/contracted-services/:sid/providers/:pid': 'patient_services:update',
  'GET /patients/:id/diagnoses': 'patient_clinical:read',
  'POST /patients/:id/diagnoses': 'patient_clinical:create',
  'PATCH /patients/:id/diagnoses/:did': 'patient_clinical:update',
  'GET /terminology/search': 'patient_clinical:read',
  // D286 (lex C5): o PATCH dinâmico por seção virou rotas explícitas, uma por container.
  // `support-network` SAIU do whitelist (spec 018, PR-1, SUP-37) — a rota abaixo é 410, sem célula.
  'PATCH /patients/:id/general': 'patient_identity:update',
  'PATCH /patients/:id/clinical': 'patient_clinical:update',
  'PATCH /patients/:id/coverage': 'patient_coverage:update',
  'PATCH /patients/:id/service': 'patient_services:update',
  // 410 sem célula (a rota não faz mais nada com o dado — só recusa).
  'PATCH /patients/:id/support-network': null,
  // Escrita por linha (spec 018, PR-1, ADR-1; contracts/support-network.md).
  'POST /patients/:id/responsibles': 'patient_family:create',
  'PATCH /patients/:id/responsibles/:rid': 'patient_family:update',
  'POST /patients/:id/responsibles/:rid/deactivate': 'patient_family:update',
  'POST /patients/:id/coverage-emergency-contacts': 'patient_coverage:create',
  'PATCH /patients/:id/coverage-emergency-contacts/:cid': 'patient_coverage:update',
  'POST /patients/:id/coverage-emergency-contacts/:cid/deactivate': 'patient_coverage:update',
  // Equipe tratante — escrita por linha (spec 018, PR-5, US-11; contracts/care-team.md). Célula
  // NOVA `patient_care_team:write` (a de leitura já existia, PR-1).
  'POST /patients/:id/professionals': 'patient_care_team:create',
  'PATCH /patients/:id/professionals/:pid': 'patient_care_team:update',
  'POST /patients/:id/professionals/:pid/deactivate': 'patient_care_team:update',
  // Contatos externos sem vínculo familiar + marca de emergência (spec 018, PR-2, `lex` #4/D-A).
  'POST /patients/:id/external-contacts': 'patient_family:create',
  'PATCH /patients/:id/external-contacts/:xid': 'patient_family:update',
  'POST /patients/:id/external-contacts/:xid/deactivate': 'patient_family:update',
  'PUT /patients/:id/emergency-contact': 'patient_family:update',
  'DELETE /patients/:id/emergency-contact': 'patient_family:update',
};

/** Rotas da família SEM célula, de propósito: só recusam (410), nunca fazem nada com o dado. */
const SEM_CELULA_DE_PROPOSITO = (route: { method: string; path: string }): boolean =>
  (route.method === 'PATCH' && route.path === '/patients/:id/support-network') ||
  (route.method === 'POST' && route.path === '/patients/:id/activate');

/** Cada handler devolve o próprio nome — é o que identifica quem foi chamado. */
function pecas() {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, id: req.params.id, section: req.params.section, code: req.params.code });

  const controller = {
    getPatientStats: responde('getPatientStats'),
    getPatientFunnel: responde('getPatientFunnel'),
    listPatients: responde('listPatients'),
    createPatient: responde('createPatient'),
    getPatientById: responde('getPatientById'),
    listPatientAddresses: responde('listPatientAddresses'),
    createPatientAddress: responde('createPatientAddress'),
    listPatientVacancies: responde('listPatientVacancies'),
    updatePatientStatus: responde('updatePatientStatus'),
    updatePatientTestFlag: responde('updatePatientTestFlag'),
    purgeTestPatient: responde('purgeTestPatient'),
    updatePatientSection: responde('updatePatientSection'),
    getPatientStatusHistory: responde('getPatientStatusHistory'),
  } as unknown as AdminPatientsController;

  const chatIds = {
    getChatGroups: responde('getChatGroups'),
    getChatMap: responde('getChatMap'),
    getChatCandidates: responde('getChatCandidates'),
    updateChatIds: responde('updateChatIds'),
  } as unknown as AdminPatientChatIdsController;

  const chatRoles = {
    list: responde('chatRoles.list'),
    create: responde('chatRoles.create'),
    update: responde('chatRoles.update'),
    delete: responde('chatRoles.delete'),
  } as unknown as AdminPatientChatRolesController;

  const map = { getMapPoints: responde('getMapPoints') } as unknown as AdminPatientsMapController;
  const addresses = { updatePatientAddress: responde('updatePatientAddress') } as unknown as AdminPatientAddressesController;
  const insurance = {
    list: responde('providers.list'),
    create: responde('providers.create'),
  } as unknown as AdminInsuranceProvidersController;
  const contracted = {
    list: responde('cs.list'),
    create: responde('cs.create'),
    update: responde('cs.update'),
    activateRecruitment: responde('cs.activateRecruitment'),
    associateProvider: responde('cs.associateProvider'),
    updateProvider: responde('cs.updateProvider'),
  } as unknown as AdminPatientContractedServicesController;
  const diagnoses = {
    list: responde('diag.list'),
    create: responde('diag.create'),
    update: responde('diag.update'),
  } as unknown as AdminPatientDiagnosesController;
  const terminology = { search: responde('terminology.search') } as unknown as AdminTerminologySearchController;
  const contactRows = {
    createResponsible: responde('rows.createResponsible'),
    updateResponsible: responde('rows.updateResponsible'),
    deactivateResponsible: responde('rows.deactivateResponsible'),
    createCoverageEmergencyContact: responde('rows.createCoverageEmergencyContact'),
    updateCoverageEmergencyContact: responde('rows.updateCoverageEmergencyContact'),
    deactivateCoverageEmergencyContact: responde('rows.deactivateCoverageEmergencyContact'),
    createProfessional: responde('rows.createProfessional'),
    updateProfessional: responde('rows.updateProfessional'),
    deactivateProfessional: responde('rows.deactivateProfessional'),
  } as unknown as AdminPatientContactRowsController;
  // Spec 018, PR-2: contatos externos + marca de emergência.
  const externalContacts = {
    create: responde('external.create'),
    update: responde('external.update'),
    deactivate: responde('external.deactivate'),
  } as unknown as AdminPatientExternalContactsController;
  const emergencyContact = {
    mark: responde('emergency.mark'),
    unmark: responde('emergency.unmark'),
  } as unknown as AdminPatientEmergencyContactController;

  return {
    controller, chatIds, chatRoles, map, addresses, insurance, contracted, diagnoses, terminology, contactRows,
    externalContacts, emergencyContact,
    auth: authDouble(), permissions: permissionsDouble(),
  };
}

/** O router com TODOS os dublês — o default dos testes. */
function build() {
  const p = pecas();
  return createAdminPatientsRoutes(
    p.controller, p.auth, p.permissions, p.chatIds, p.chatRoles,
    p.map, p.addresses, p.insurance, p.contracted, p.diagnoses, p.terminology, p.contactRows,
    p.externalContacts, p.emergencyContact,
  );
}

describe('createAdminPatientsRoutes', () => {
  it('TODA rota da família declara célula, exceto os 410 (support-network e /activate — não fazem nada com o dado)', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), (r) => !SEM_CELULA_DE_PROPOSITO(r))).toEqual([]);
  });

  it('cada rota declara a célula do mapa (route-permission-map.md)', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('a família declara exatamente 54 rotas — 45 do PR-1 (39 de antes/D286 + o 410 de support-network + as 6 por linha) + activate-recruitment (PR-6) + as 3 da equipe tratante (PR-5) + as 5 do PR-2 (contatos externos + marca de emergência)', () => {
    expect(scanExpressRouter(build())).toHaveLength(54);
  });

  it('a família é `admin.patients` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_PATIENTS_FAMILY).toBe('admin.patients');
  });

  it('sem o 12º/13º/14º argumento (contactRowsController/externalContacts/emergencyContact omitidos), o factory usa os DEFAULTS', () => {
    // Os defaults `new AdminPatientContactRowsController()` / `new AdminPatientExternalContactsController()` /
    // `new AdminPatientEmergencyContactController()` constroem os repositórios reais, que pegam o
    // pool de `DatabaseConnection.getInstance()` NA CONSTRUÇÃO (não é preguiçoso como o comentário
    // do factory presumia) — precisa de config de banco só para o `new` não estourar; nenhuma
    // query roda neste teste.
    const antes = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db';
    try {
      const p = pecas();
      const router = createAdminPatientsRoutes(
        p.controller, p.auth, p.permissions, p.chatIds, p.chatRoles,
        p.map, p.addresses, p.insurance, p.contracted, p.diagnoses, p.terminology,
        // 12º/13º/14º omitidos de propósito
      );
      expect(scanExpressRouter(router)).toHaveLength(54);
    } finally {
      if (antes === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = antes;
    }
  });

  // As 3 escolhas de célula que NÃO são o óbvio `patient:*`. Se alguém
  // "uniformizar" depois, o teste diz por que não.
  it('a lista de vagas do paciente exige vacancy:read — não é caminho lateral para o funil', () => {
    const rota = scanExpressRouter(build()).find((r) => r.path === '/patients/:id/vacancies');
    expect(rota?.cell).toMatchObject({ resource: 'vacancy', action: 'read' });
  });

  it.each([
    ['/chat-groups', 'GET'],
    ['/patients/:id/chat-candidates', 'GET'],
  ])('%s lê conversa da org, então exige messaging:read', (caminho, metodo) => {
    const rota = scanExpressRouter(build()).find((r) => r.path === caminho && r.method === metodo);
    expect(rota?.cell).toMatchObject({ resource: 'messaging', action: 'read' });
  });

  it('a purga de paciente exige patient:delete — a célula nova da D116', () => {
    const rota = scanExpressRouter(build()).find((r) => r.method === 'DELETE' && r.path === '/patients/:id');
    expect(rota?.cell).toMatchObject({ resource: 'patient', action: 'delete' });
  });

  // A ordem de registro é contrato (o cabeçalho do router explica cada caso).
  // tsc não pega nenhum destes: todas as assinaturas são iguais.
  it.each([
    ['get', '/api/admin/patients/stats', 'getPatientStats'],
    ['get', '/api/admin/patients/funnel', 'getPatientFunnel'],
    ['get', '/api/admin/patients/chat-map', 'getChatMap'],
    ['get', '/api/admin/patients', 'listPatients'],
    ['post', '/api/admin/patients', 'createPatient'],
    ['get', '/api/admin/patients/abc-123', 'getPatientById'],
    ['get', '/api/admin/patients/abc-123/vacancies', 'listPatientVacancies'],
    ['get', '/api/admin/patients/abc-123/addresses', 'listPatientAddresses'],
    ['put', '/api/admin/patients/abc-123/status', 'updatePatientStatus'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/activate-recruitment', 'cs.activateRecruitment'],
    ['get', '/api/admin/patients/abc-123/chat-candidates', 'getChatCandidates'],
    ['put', '/api/admin/patients/abc-123/chat-ids', 'updateChatIds'],
    ['patch', '/api/admin/patients/abc-123/test-flag', 'updatePatientTestFlag'],
    ['delete', '/api/admin/patients/abc-123', 'purgeTestPatient'],
    ['post', '/api/admin/patients/abc-123/addresses', 'createPatientAddress'],
    ['get', '/api/admin/patient-chat-roles', 'chatRoles.list'],
    ['post', '/api/admin/patient-chat-roles', 'chatRoles.create'],
    ['patch', '/api/admin/patient-chat-roles/FAMILIAR', 'chatRoles.update'],
    ['delete', '/api/admin/patient-chat-roles/FAMILIAR', 'chatRoles.delete'],
    ['get', '/api/admin/chat-groups', 'getChatGroups'],
    ['get', '/api/admin/catalogs/insurance-providers', 'providers.list'],
    ['post', '/api/admin/catalogs/insurance-providers', 'providers.create'],
    ['post', '/api/admin/patients/map', 'getMapPoints'],
    ['get', '/api/admin/patients/abc-123/status-history', 'getPatientStatusHistory'],
    ['patch', '/api/admin/patients/abc-123/addresses/addr-1', 'updatePatientAddress'],
    ['get', '/api/admin/patients/abc-123/contracted-services', 'cs.list'],
    ['post', '/api/admin/patients/abc-123/contracted-services', 'cs.create'],
    ['patch', '/api/admin/patients/abc-123/contracted-services/s1', 'cs.update'],
    ['post', '/api/admin/patients/abc-123/contracted-services/s1/providers', 'cs.associateProvider'],
    ['patch', '/api/admin/patients/abc-123/contracted-services/s1/providers/p1', 'cs.updateProvider'],
    ['get', '/api/admin/patients/abc-123/diagnoses', 'diag.list'],
    ['post', '/api/admin/patients/abc-123/diagnoses', 'diag.create'],
    ['patch', '/api/admin/patients/abc-123/diagnoses/d1', 'diag.update'],
    ['get', '/api/admin/terminology/search', 'terminology.search'],
    ['post', '/api/admin/patients/abc-123/responsibles', 'rows.createResponsible'],
    ['patch', '/api/admin/patients/abc-123/responsibles/r1', 'rows.updateResponsible'],
    ['post', '/api/admin/patients/abc-123/responsibles/r1/deactivate', 'rows.deactivateResponsible'],
    ['post', '/api/admin/patients/abc-123/coverage-emergency-contacts', 'rows.createCoverageEmergencyContact'],
    ['patch', '/api/admin/patients/abc-123/coverage-emergency-contacts/c1', 'rows.updateCoverageEmergencyContact'],
    ['post', '/api/admin/patients/abc-123/coverage-emergency-contacts/c1/deactivate', 'rows.deactivateCoverageEmergencyContact'],
    ['post', '/api/admin/patients/abc-123/professionals', 'rows.createProfessional'],
    ['patch', '/api/admin/patients/abc-123/professionals/p1', 'rows.updateProfessional'],
    ['post', '/api/admin/patients/abc-123/professionals/p1/deactivate', 'rows.deactivateProfessional'],
    ['post', '/api/admin/patients/abc-123/external-contacts', 'external.create'],
    ['patch', '/api/admin/patients/abc-123/external-contacts/x1', 'external.update'],
    ['post', '/api/admin/patients/abc-123/external-contacts/x1/deactivate', 'external.deactivate'],
    ['put', '/api/admin/patients/abc-123/emergency-contact', 'emergency.mark'],
    ['delete', '/api/admin/patients/abc-123/emergency-contact', 'emergency.unmark'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());

    const res = await request(app)[metodo](caminho).expect(200);

    expect(res.body.m).toBe(esperado);
  });

  // Os dois casos de captura que o cabeçalho do router chama de contrato:
  // 'stats' e 'test-flag' seriam engolidos se a ordem mudasse.
  it("GET /patients/map não é o mapa (é POST): 'map' cai em /patients/:id", async () => {
    const app = express();
    app.use('/api/admin', build());

    const res = await request(app).get('/api/admin/patients/map').expect(200);

    expect(res.body).toMatchObject({ m: 'getPatientById', id: 'map' });
  });

  it("'stats' não é capturado como :id", async () => {
    const app = express();
    app.use('/api/admin', build());
    const res = await request(app).get('/api/admin/patients/stats').expect(200);
    expect(res.body.m).toBe('getPatientStats');
  });

  it("'test-flag' continua chegando no seu handler (não existe mais PATCH dinâmico para capturá-lo)", async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());
    const res = await request(app).patch('/api/admin/patients/abc-123/test-flag').expect(200);
    expect(res.body.m).toBe('updatePatientTestFlag');
  });

  it.each(['general', 'clinical', 'coverage', 'service'])(
    'PATCH /patients/:id/%s chega em updatePatientSection com a seção fixada pela rota (D286)',
    async (section) => {
      const app = express();
      app.use(express.json());
      app.use('/api/admin', build());
      const res = await request(app).patch(`/api/admin/patients/abc-123/${section}`).expect(200);
      expect(res.body).toMatchObject({ m: 'updatePatientSection', id: 'abc-123', section });
    },
  );

  it('PATCH /patients/:id/support-network → 410 (spec 018, PR-1, SUP-37) — nunca chega no controller de seção', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());
    const res = await request(app).patch('/api/admin/patients/abc-123/support-network').expect(410);
    expect(res.body).toMatchObject({ success: false, code: 'SUPPORT_NETWORK_LIST_WRITE_REMOVED' });
  });

  it('POST /patients/:id/activate → 410 (spec 018, PR-6, ADR-5) — nunca chega em nenhum controller', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());
    const res = await request(app).post('/api/admin/patients/abc-123/activate').expect(410);
    expect(res.body).toMatchObject({ success: false, code: 'ACTIVATION_SPLIT' });
  });

  it('seção fora do whitelist é 404 — não existe mais rota dinâmica que a aceite', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());
    await request(app).patch('/api/admin/patients/abc-123/nao-existe').expect(404);
  });

  // Criar paciente para outro país é o mesmo pedido cross-país do `?country=`,
  // e no POST ele vem do BODY. Se alguém trocar por `req.query.country` numa
  // refatoração, o guard passaria a olhar o lugar errado e a policy recusaria o
  // INSERT com erro cru de RLS em vez de explicar.
  it('POST /patients entrega ao guard de país o país do BODY', async () => {
    mockPaisVisto = undefined;
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());

    await request(app).post('/api/admin/patients').send({ country: 'BR', nome: 'x' }).expect(200);

    expect(mockPaisVisto).toBe('BR');
  });

  it('sem corpo parseado, o extrator devolve undefined em vez de estourar', async () => {
    mockPaisVisto = 'sujeira-da-execucao-anterior';
    const app = express();
    // De propósito SEM express.json(): `req.body` é undefined, e é o `?.` que
    // segura. Um `req.body.country` cru derrubaria a rota com TypeError.
    app.use('/api/admin', build());

    await request(app).post('/api/admin/patients').expect(200);

    expect(mockPaisVisto).toBeUndefined();
  });
});
