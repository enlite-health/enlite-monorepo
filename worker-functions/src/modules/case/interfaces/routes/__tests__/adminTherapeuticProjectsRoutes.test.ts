/**
 * As rotas do Projeto Terapêutico (spec 017, D299) — router próprio montado em `/api/admin`, na
 * família `admin.patients`. Mesmo contrato do `adminPatientsRoutes.test.ts`: varre o router de
 * VERDADE com o mesmo `scanExpressRouter` que alimenta o catálogo de células, e afirma a célula de
 * cada rota a partir do MAPA escrito à mão (D299.3 + o cabeçalho do router), não do código — senão
 * o teste concordaria com qualquer erro de declaração.
 *
 * ⚠️ Cobre só este router. O oráculo do app inteiro é o e2e `permission-route-inventory`.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminTherapeuticProjectsRoutes } from '../adminTherapeuticProjectsRoutes';
import type { AdminTherapeuticProjectsController } from '../../controllers/AdminTherapeuticProjectsController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

/**
 * A trilha em si é assunto do e2e. Mas o dublê EXECUTA a função de `action` que a rota passou —
 * sem isso, `readTrail`/`writeTrail` (as ÚNICAS duas linhas de lógica do arquivo) nunca rodariam,
 * e o teste mediria só a tabela de rotas. É o mesmo motivo do dublê de `requireCountryScope` no
 * `adminPatientsRoutes.test.ts`.
 */
const trilhas: Array<{ tipo: string; acao: string }> = [];
jest.mock('@shared/audit/resourceAccessLog', () => ({
  logResourceAccess:
    (tipo: string, acao: string | ((req: unknown) => string)) =>
    (req: unknown, _res: unknown, next: () => void) => {
      trilhas.push({ tipo, acao: typeof acao === 'function' ? acao(req) : acao });
      next();
    },
}));

const PROJETO_READ = 'patient_therapeutic_project:read';
const PROJETO_WRITE = 'patient_therapeutic_project:write';

/**
 * O mapa esperado, escrito à mão a partir da D299.3 e do cabeçalho do router:
 * o container do paciente para as versões, e UMA célula por catálogo (Gabriel, 08/09).
 */
const ESPERADO: Record<string, string> = {
  'GET /patients/:id/therapeutic-projects': PROJETO_READ,
  'POST /patients/:id/therapeutic-projects': PROJETO_WRITE,
  'GET /patients/:id/therapeutic-projects/:vid': PROJETO_READ,
  'POST /patients/:id/therapeutic-projects/:vid/annul': PROJETO_WRITE,
  'GET /therapeutic-catalogs/specific-objectives': 'catalog_therapeutic_objectives:read',
  'POST /therapeutic-catalogs/specific-objectives': 'catalog_therapeutic_objectives:write',
  'PATCH /therapeutic-catalogs/specific-objectives/:itemId': 'catalog_therapeutic_objectives:write',
  'GET /therapeutic-catalogs/activities': 'catalog_therapeutic_activities:read',
  'POST /therapeutic-catalogs/activities': 'catalog_therapeutic_activities:write',
  'PATCH /therapeutic-catalogs/activities/:itemId': 'catalog_therapeutic_activities:write',
};

/** Cada handler devolve o próprio nome — é o que identifica quem foi chamado (e com que kind). */
function controllerDuble(): AdminTherapeuticProjectsController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, id: req.params.id, vid: req.params.vid, itemId: req.params.itemId });
  const respondeCatalogo = (nome: string) => (kind: string, req: express.Request, res: express.Response) =>
    res.json({ m: nome, kind, itemId: req.params.itemId });
  return {
    list: responde('list'),
    create: responde('create'),
    get: responde('get'),
    annul: responde('annul'),
    listCatalog: respondeCatalogo('listCatalog'),
    createCatalogItem: respondeCatalogo('createCatalogItem'),
    updateCatalogItem: respondeCatalogo('updateCatalogItem'),
  } as unknown as AdminTherapeuticProjectsController;
}

const build = () => createAdminTherapeuticProjectsRoutes(controllerDuble(), authDouble(), permissionsDouble());

/** App com o router montado onde ele vive em produção. `celulas` simula o que o engine carimba. */
function app(celulas?: string[]) {
  const a = express();
  a.use(express.json());
  if (celulas) {
    a.use((req, _res, next) => {
      (req as express.Request & { permissionCells?: string[] }).permissionCells = celulas;
      next();
    });
  }
  a.use('/api/admin', build());
  return a;
}

describe('createAdminTherapeuticProjectsRoutes', () => {
  beforeEach(() => {
    trilhas.length = 0;
  });

  it('TODA rota do router declara célula — nenhuma passa sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('cada uma das 13 rotas declara a célula do mapa (D299.3)', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('são exatamente 10 rotas: 4 do projeto + 2 catálogos × 3 verbos (tipo de patologia não é catálogo)', () => {
    expect(scanExpressRouter(build())).toHaveLength(10);
  });

  it('não existe DELETE em lugar nenhum — versão é imutável (lex C5) e catálogo é baixa lógica', () => {
    expect(scanExpressRouter(build()).map((r) => r.method)).not.toContain('DELETE');
  });

  it('a célula do catálogo é LITERAL por rota — não há `:kind` dinâmico que a calcule em runtime', () => {
    const caminhos = scanExpressRouter(build()).map((r) => r.path);
    expect(caminhos.some((p) => p.includes(':kind'))).toBe(false);
    expect(caminhos).toContain('/therapeutic-catalogs/activities');
  });

  it('NÃO existe rota nem célula de catálogo de tipo de patologia: deriva do CID-11 (Gabriel 08/09, D163/D164)', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas.some((r) => r.path.includes('pathology'))).toBe(false);
    expect(rotas.some((r) => r.cell?.resource === 'catalog_pathology_types')).toBe(false);
  });

  it('a leitura das versões NÃO exige a célula clínica — ela é cumulativa e conferida na projeção (lex C7)', () => {
    const leitura = scanExpressRouter(build()).filter((r) => r.method === 'GET' && r.path.includes('therapeutic-projects'));
    expect(leitura).toHaveLength(2);
    for (const r of leitura) expect(cellKey(r.cell!.resource, r.cell!.action)).toBe(PROJETO_READ);
  });

  // A ordem de registro é contrato: `/therapeutic-projects/:vid` depois de `/therapeutic-projects`.
  // tsc não pega nenhum destes — todas as assinaturas são iguais.
  it.each([
    ['get', '/api/admin/patients/abc-123/therapeutic-projects', 'list'],
    ['post', '/api/admin/patients/abc-123/therapeutic-projects', 'create'],
    ['get', '/api/admin/patients/abc-123/therapeutic-projects/v-1', 'get'],
    ['post', '/api/admin/patients/abc-123/therapeutic-projects/v-1/annul', 'annul'],
    ['get', '/api/admin/therapeutic-catalogs/specific-objectives', 'listCatalog'],
    ['post', '/api/admin/therapeutic-catalogs/specific-objectives', 'createCatalogItem'],
    ['patch', '/api/admin/therapeutic-catalogs/specific-objectives/i-1', 'updateCatalogItem'],
    ['get', '/api/admin/therapeutic-catalogs/activities', 'listCatalog'],
    ['post', '/api/admin/therapeutic-catalogs/activities', 'createCatalogItem'],
    ['patch', '/api/admin/therapeutic-catalogs/activities/i-1', 'updateCatalogItem'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const res = await request(app())[metodo](caminho).expect(200);
    expect(res.body.m).toBe(esperado);
  });

  it.each([
    ['specific-objectives'],
    ['activities'],
  ])('o kind `%s` chega ao controller pela ROTA, não por param do cliente', async (kind) => {
    const res = await request(app()).get(`/api/admin/therapeutic-catalogs/${kind}`).expect(200);
    expect(res.body.kind).toBe(kind);
  });

  describe('trilha (lex C9/C13: só nomes de container)', () => {
    it('as 4 rotas do projeto gravam trilha de `patient`; as 9 de catálogo NÃO gravam nenhuma', async () => {
      await request(app()).get('/api/admin/patients/abc-123/therapeutic-projects').expect(200);
      await request(app()).get('/api/admin/therapeutic-catalogs/activities').expect(200);
      await request(app()).post('/api/admin/therapeutic-catalogs/activities').send({ label: 'x' }).expect(200);
      await request(app()).patch('/api/admin/therapeutic-catalogs/activities/i-1').send({ label: 'x' }).expect(200);
      expect(trilhas).toEqual([{ tipo: 'patient', acao: 'read_project:therapeuticProject+clinical+services' }]);
    });

    it('leitura sem `?purpose` → `read_project`; `?purpose=export` só vale na versão (lex C13) — na LISTA é leitura comum', async () => {
      await request(app()).get('/api/admin/patients/abc-123/therapeutic-projects').expect(200);
      await request(app()).get('/api/admin/patients/abc-123/therapeutic-projects/v-1?purpose=export').expect(200);
      await request(app()).get('/api/admin/patients/abc-123/therapeutic-projects?purpose=print').expect(200);
      // A lista com `?purpose=export` não exporta PDF nenhum: a trilha não pode dizer que exportou.
      await request(app()).get('/api/admin/patients/abc-123/therapeutic-projects?purpose=export').expect(200);
      expect(trilhas.map((t) => t.acao)).toEqual([
        'read_project:therapeuticProject+clinical+services',
        'export_pdf:therapeuticProject+clinical+services',
        'read_project:therapeuticProject+clinical+services',
        'read_project:therapeuticProject+clinical+services',
      ]);
    });

    it('as duas escritas (criar e anular) gravam `write_project`', async () => {
      await request(app()).post('/api/admin/patients/abc-123/therapeutic-projects').send({}).expect(200);
      await request(app()).post('/api/admin/patients/abc-123/therapeutic-projects/v-1/annul').send({}).expect(200);
      expect(trilhas.map((t) => t.acao)).toEqual([
        'write_project:therapeuticProject+clinical+services',
        'write_project:therapeuticProject+clinical+services',
      ]);
    });

    it('sem célula clínica a trilha diz que o clínico NÃO foi servido — o `+clinical` some', async () => {
      await request(app([PROJETO_READ])).get('/api/admin/patients/abc-123/therapeutic-projects').expect(200);
      await request(app([PROJETO_READ])).get('/api/admin/patients/abc-123/therapeutic-projects/v-1?purpose=export').expect(200);
      await request(app([PROJETO_WRITE])).post('/api/admin/patients/abc-123/therapeutic-projects').send({}).expect(200);
      expect(trilhas.map((t) => t.acao)).toEqual([
        'read_project:therapeuticProject',
        'export_pdf:therapeuticProject',
        'write_project:therapeuticProject',
      ]);
    });

    it('com a célula clínica declarada, a trilha diz os DOIS containers; com serviços também, os TRÊS (lex A1 C4)', async () => {
      await request(app([PROJETO_READ, 'patient_clinical:read'])).get('/api/admin/patients/abc-123/therapeutic-projects').expect(200);
      expect(trilhas.map((t) => t.acao)).toEqual(['read_project:therapeuticProject+clinical']);
      await request(app([PROJETO_READ, 'patient_clinical:read', 'patient_services:read'])).get('/api/admin/patients/abc-123/therapeutic-projects').expect(200);
      expect(trilhas.map((t) => t.acao).at(-1)).toBe('read_project:therapeuticProject+clinical+services');
    });

    it('a ação da trilha nunca carrega id nem texto — só nomes de container', async () => {
      await request(app([PROJETO_READ])).get('/api/admin/patients/abc-123/therapeutic-projects/v-1').expect(200);
      expect(trilhas[0].acao).toMatch(/^read_project:[A-Za-z+]+$/);
    });
  });
});
