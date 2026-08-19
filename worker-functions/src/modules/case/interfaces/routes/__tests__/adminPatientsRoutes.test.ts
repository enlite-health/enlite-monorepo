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
import { PermissionMiddleware } from '@modules/identity/interfaces/middleware/PermissionMiddleware';
import type { AdminPatientsController } from '../../controllers/AdminPatientsController';
import type { AdminPatientChatIdsController } from '../../controllers/AdminPatientChatIdsController';
import type { AdminPatientChatRolesController } from '../../controllers/AdminPatientChatRolesController';
import type { AuthMiddleware } from '@modules/identity';

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
const ESPERADO: Record<string, string> = {
  'GET /patient-chat-roles': 'patient:read',
  'POST /patient-chat-roles': 'patient:write',
  'PATCH /patient-chat-roles/:code': 'patient:write',
  'DELETE /patient-chat-roles/:code': 'patient:write',
  'GET /chat-groups': 'messaging:read',
  'GET /patients/stats': 'patient:read',
  'GET /patients/funnel': 'patient:read',
  'GET /patients/chat-map': 'patient:read',
  'GET /patients': 'patient:read',
  'POST /patients': 'patient:write',
  'GET /patients/:id': 'patient:read',
  'GET /patients/:patientId/addresses': 'patient:read',
  'POST /patients/:patientId/addresses': 'patient:write',
  'GET /patients/:id/vacancies': 'vacancy:read',
  'PUT /patients/:id/status': 'patient:write',
  'POST /patients/:id/activate': 'patient:write',
  'GET /patients/:id/chat-candidates': 'messaging:read',
  'PUT /patients/:id/chat-ids': 'patient:write',
  'PATCH /patients/:id/test-flag': 'patient:write',
  'DELETE /patients/:id': 'patient:delete',
  'PATCH /patients/:id/:section': 'patient:write',
};

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
    activatePatient: responde('activatePatient'),
    updatePatientTestFlag: responde('updatePatientTestFlag'),
    purgeTestPatient: responde('purgeTestPatient'),
    updatePatientSection: responde('updatePatientSection'),
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

  const auth = {
    requireAdmin: () => (_req: unknown, _res: unknown, next: express.NextFunction) => next(),
    requireStaff: () => (_req: unknown, _res: unknown, next: express.NextFunction) => next(),
  } as unknown as AuthMiddleware;

  const permissions = new PermissionMiddleware({
    client: {
      resolve: jest.fn(),
      can: jest.fn(),
      isFeatureAvailable: jest.fn(),
      featureConfig: jest.fn(),
      invalidate: jest.fn(),
    },
    audit: { record: jest.fn() },
    env: {},
  });

  return { controller, chatIds, chatRoles, auth, permissions };
}

/** O router com TODOS os dublês — o default dos testes. */
function build() {
  const { controller, chatIds, chatRoles, auth, permissions } = pecas();
  return createAdminPatientsRoutes(controller, auth, permissions, chatIds, chatRoles);
}

describe('createAdminPatientsRoutes', () => {
  it('TODA rota da família declara célula', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
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

  it('a família declara exatamente 21 rotas — a conta que saiu do PENDING_DECLARATIONS', () => {
    expect(scanExpressRouter(build())).toHaveLength(21);
  });

  it('a família é `admin.patients` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_PATIENTS_FAMILY).toBe('admin.patients');
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
    ['post', '/api/admin/patients/abc-123/activate', 'activatePatient'],
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
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());

    const res = await request(app)[metodo](caminho).expect(200);

    expect(res.body.m).toBe(esperado);
  });

  // Os dois casos de captura que o cabeçalho do router chama de contrato:
  // 'stats' e 'test-flag' seriam engolidos se a ordem mudasse.
  it("'stats' não é capturado como :id", async () => {
    const app = express();
    app.use('/api/admin', build());
    const res = await request(app).get('/api/admin/patients/stats').expect(200);
    expect(res.body.m).toBe('getPatientStats');
  });

  it("'test-flag' não é capturado como :section pelo PATCH dinâmico", async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());
    const res = await request(app).patch('/api/admin/patients/abc-123/test-flag').expect(200);
    expect(res.body.m).toBe('updatePatientTestFlag');
  });

  it('o PATCH dinâmico segue recebendo as seções de verdade', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/admin', build());
    const res = await request(app).patch('/api/admin/patients/abc-123/clinical').expect(200);
    expect(res.body).toMatchObject({ m: 'updatePatientSection', id: 'abc-123', section: 'clinical' });
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
