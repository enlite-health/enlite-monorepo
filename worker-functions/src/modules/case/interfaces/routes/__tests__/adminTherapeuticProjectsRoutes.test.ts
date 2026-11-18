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
import type { AdminServiceShiftTemplatesController } from '../../controllers/AdminServiceShiftTemplatesController';

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
// PR-8b 8b.4: patient_therapeutic_project:write splitado — create na versão nova ("Novo"),
// update na versão MINOR ("Editar") e no annul (pr8b-mapa-rotas.tsv linhas 38-39).
const PROJETO_CREATE = 'patient_therapeutic_project:create';
const PROJETO_UPDATE = 'patient_therapeutic_project:update';
const OBJ_READ = 'catalog_therapeutic_objectives:read';
const OBJ_UPDATE = 'catalog_therapeutic_objectives:update';
const ACT_READ = 'catalog_therapeutic_activities:read';
const ACT_UPDATE = 'catalog_therapeutic_activities:update';

/**
 * O mapa esperado, escrito à mão a partir da D299.3 e do cabeçalho do router:
 * o container do paciente para as versões, UMA célula por catálogo (Gabriel, 08/09) e as rotas da 091 (§9.4,
 * célula LITERAL em cada uma; `cascade` exige DUAS, na ordem dos guards: `A + B`).
 */
const ESPERADO: Record<string, string> = {
  'GET /patients/:id/therapeutic-projects': PROJETO_READ,
  'POST /patients/:id/therapeutic-projects': PROJETO_CREATE,
  'GET /patients/:id/therapeutic-projects/:vid': PROJETO_READ,
  'POST /patients/:id/therapeutic-projects/:vid/annul': PROJETO_UPDATE,
  // 091 (§9.4) — cascata e busca de categoria.
  'POST /therapeutic-catalogs/cascade': `${OBJ_READ} + ${ACT_READ}`,
  'GET /therapeutic-catalogs/icd-categories': OBJ_READ,
  // Objetivos: lista, escrita, e vínculo com categoria CID-11 (escrever vínculo = `update` do objetivo).
  'GET /therapeutic-catalogs/specific-objectives': OBJ_READ,
  'POST /therapeutic-catalogs/specific-objectives': 'catalog_therapeutic_objectives:create',
  'PATCH /therapeutic-catalogs/specific-objectives/:itemId': OBJ_UPDATE,
  'GET /therapeutic-catalogs/specific-objectives/:itemId/categories': OBJ_READ,
  'POST /therapeutic-catalogs/specific-objectives/:itemId/categories': OBJ_UPDATE,
  'DELETE /therapeutic-catalogs/specific-objectives/:itemId/categories/:code': OBJ_UPDATE,
  // Atividades: idem, com as células de atividade.
  'GET /therapeutic-catalogs/activities': ACT_READ,
  'POST /therapeutic-catalogs/activities': 'catalog_therapeutic_activities:create',
  'PATCH /therapeutic-catalogs/activities/:itemId': ACT_UPDATE,
  'GET /therapeutic-catalogs/activities/:itemId/categories': ACT_READ,
  'POST /therapeutic-catalogs/activities/:itemId/categories': ACT_UPDATE,
  'DELETE /therapeutic-catalogs/activities/:itemId/categories/:code': ACT_UPDATE,
  // Motivos de saída (492) — kind fora do laço terapêutico, célula literal própria; `/options` lê sob patient_services:read.
  'GET /therapeutic-catalogs/service-exit-reasons': 'catalog_service_exit_reasons:read',
  'POST /therapeutic-catalogs/service-exit-reasons': 'catalog_service_exit_reasons:create',
  'PATCH /therapeutic-catalogs/service-exit-reasons/:itemId': 'catalog_service_exit_reasons:update',
  'GET /therapeutic-catalogs/service-exit-reasons/options': 'patient_services:read',
  // Guardias predefinidas (550, spec 074) — controller próprio; `/options` lê sob patient_services:read.
  'GET /therapeutic-catalogs/service-shift-templates': 'catalog_service_shift_templates:read',
  'POST /therapeutic-catalogs/service-shift-templates': 'catalog_service_shift_templates:create',
  'PATCH /therapeutic-catalogs/service-shift-templates/:itemId': 'catalog_service_shift_templates:update',
  'GET /therapeutic-catalogs/service-shift-templates/options': 'patient_services:read',
};

/** Cada handler devolve o próprio nome — é o que identifica quem foi chamado (e com que kind). */
function controllerDuble(): AdminTherapeuticProjectsController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, id: req.params.id, vid: req.params.vid, itemId: req.params.itemId });
  const respondeCatalogo = (nome: string) => (kind: string, req: express.Request, res: express.Response) =>
    res.json({ m: nome, kind, itemId: req.params.itemId });
  // Vínculo com categoria: o `owner` (objective|activity) vem da ROTA, nunca do cliente.
  const respondeVinculo = (nome: string) => (owner: string, req: express.Request, res: express.Response) =>
    res.json({ m: nome, owner, itemId: req.params.itemId, code: req.params.code });
  return {
    list: responde('list'),
    create: responde('create'),
    get: responde('get'),
    annul: responde('annul'),
    listCatalog: respondeCatalogo('listCatalog'),
    createCatalogItem: respondeCatalogo('createCatalogItem'),
    updateCatalogItem: respondeCatalogo('updateCatalogItem'),
    listServiceExitReasonOptions: responde('listServiceExitReasonOptions'),
    cascade: responde('cascade'),
    searchIcdCategories: responde('searchIcdCategories'),
    listCategoryLinks: respondeVinculo('listCategoryLinks'),
    addCategoryLink: respondeVinculo('addCategoryLink'),
    removeCategoryLink: respondeVinculo('removeCategoryLink'),
  } as unknown as AdminTherapeuticProjectsController;
}

/** Dublê do controller das guardias (4º parâmetro): cada handler devolve o próprio nome. */
function shiftTemplatesDuble(): AdminServiceShiftTemplatesController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) => res.json({ m: nome, itemId: req.params.itemId });
  return {
    listShiftTemplates: responde('listShiftTemplates'),
    createShiftTemplate: responde('createShiftTemplate'),
    updateShiftTemplate: responde('updateShiftTemplate'),
    listShiftTemplateOptions: responde('listShiftTemplateOptions'),
  } as unknown as AdminServiceShiftTemplatesController;
}

const build = () => createAdminTherapeuticProjectsRoutes(controllerDuble(), authDouble(), permissionsDouble(), shiftTemplatesDuble());

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

  it('cada uma das 26 rotas declara a célula LITERAL do mapa (D299.3, §9.4 da 091)', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route) => [
        `${route.method} ${route.path}`,
        (route.cells ?? []).map((c) => cellKey(c.resource, c.action)).join(' + ') || null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('são exatamente 26 rotas: 4 do projeto + cascade + icd-categories + 2 catálogos × 6 + motivos de saída (3 + options) + guardias (3 + options)', () => {
    expect(scanExpressRouter(build())).toHaveLength(26);
  });

  it('DELETE só existe nos vínculos de categoria (…/categories/:code) — versão é imutável (lex C5) e item de catálogo é baixa lógica', () => {
    const deletes = scanExpressRouter(build()).filter((r) => r.method === 'DELETE').map((r) => r.path);
    expect(deletes).toEqual([
      '/therapeutic-catalogs/specific-objectives/:itemId/categories/:code',
      '/therapeutic-catalogs/activities/:itemId/categories/:code',
    ]);
  });

  it('091: `segments` NÃO existe — nenhuma rota, nenhuma célula `catalog_therapeutic_segments`', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas.some((r) => r.path.includes('segments'))).toBe(false);
    expect(rotas.some((r) => (r.cells ?? []).some((c) => c.resource === 'catalog_therapeutic_segments'))).toBe(false);
  });

  it.each([
    ['get', '/api/admin/therapeutic-catalogs/segments'],
    ['post', '/api/admin/therapeutic-catalogs/segments'],
    ['patch', '/api/admin/therapeutic-catalogs/segments/i-1'],
  ] as const)('091: %s %s → 404 (rota removida)', async (metodo, caminho) => {
    await request(app())[metodo](caminho).expect(404);
  });

  it('091: `cascade` declara as DUAS células, objetivos:read e atividades:read, nesta ordem', () => {
    const cascade = scanExpressRouter(build()).find((r) => r.method === 'POST' && r.path === '/therapeutic-catalogs/cascade');
    expect((cascade?.cells ?? []).map((c) => cellKey(c.resource, c.action))).toEqual([OBJ_READ, ACT_READ]);
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
    ['post', '/api/admin/therapeutic-catalogs/cascade', 'cascade'],
    ['get', '/api/admin/therapeutic-catalogs/icd-categories', 'searchIcdCategories'],
    ['get', '/api/admin/therapeutic-catalogs/specific-objectives/i-1/categories', 'listCategoryLinks'],
    ['post', '/api/admin/therapeutic-catalogs/specific-objectives/i-1/categories', 'addCategoryLink'],
    ['delete', '/api/admin/therapeutic-catalogs/specific-objectives/i-1/categories/6A02', 'removeCategoryLink'],
    ['get', '/api/admin/therapeutic-catalogs/activities/i-1/categories', 'listCategoryLinks'],
    ['post', '/api/admin/therapeutic-catalogs/activities/i-1/categories', 'addCategoryLink'],
    ['delete', '/api/admin/therapeutic-catalogs/activities/i-1/categories/6A02', 'removeCategoryLink'],
    ['get', '/api/admin/therapeutic-catalogs/service-exit-reasons', 'listCatalog'],
    ['post', '/api/admin/therapeutic-catalogs/service-exit-reasons', 'createCatalogItem'],
    ['patch', '/api/admin/therapeutic-catalogs/service-exit-reasons/i-1', 'updateCatalogItem'],
    ['get', '/api/admin/therapeutic-catalogs/service-exit-reasons/options', 'listServiceExitReasonOptions'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const res = await request(app())[metodo](caminho).expect(200);
    expect(res.body.m).toBe(esperado);
  });

  it.each([
    ['specific-objectives'],
    ['activities'],
    ['service-exit-reasons'],
  ])('o kind `%s` chega ao controller pela ROTA, não por param do cliente', async (kind) => {
    const res = await request(app()).get(`/api/admin/therapeutic-catalogs/${kind}`).expect(200);
    expect(res.body.kind).toBe(kind);
  });

  it.each([
    ['get', '/api/admin/therapeutic-catalogs/specific-objectives/i-1/categories', 'objective'],
    ['post', '/api/admin/therapeutic-catalogs/specific-objectives/i-1/categories', 'objective'],
    ['delete', '/api/admin/therapeutic-catalogs/specific-objectives/i-1/categories/6A02', 'objective'],
    ['get', '/api/admin/therapeutic-catalogs/activities/i-1/categories', 'activity'],
    ['post', '/api/admin/therapeutic-catalogs/activities/i-1/categories', 'activity'],
    ['delete', '/api/admin/therapeutic-catalogs/activities/i-1/categories/6A02', 'activity'],
  ] as const)('091: %s %s → o dono do vínculo (%s) vem da ROTA e `:code` chega como param', async (metodo, caminho, dono) => {
    const res = await request(app())[metodo](caminho).expect(200);
    expect(res.body.owner).toBe(dono);
    expect(res.body.itemId).toBe('i-1');
  });

  it('R1 rotas de guardias exigem a célula certa', async () => {
    const guardias = scanExpressRouter(build()).filter((r) => r.path.startsWith('/therapeutic-catalogs/service-shift-templates'));
    expect(guardias.map((r) => `${r.method} ${r.path} → ${r.cell ? cellKey(r.cell.resource, r.cell.action) : null}`).sort()).toEqual([
      'GET /therapeutic-catalogs/service-shift-templates → catalog_service_shift_templates:read',
      'GET /therapeutic-catalogs/service-shift-templates/options → patient_services:read',
      'PATCH /therapeutic-catalogs/service-shift-templates/:itemId → catalog_service_shift_templates:update',
      'POST /therapeutic-catalogs/service-shift-templates → catalog_service_shift_templates:create',
    ]);
    const base = '/api/admin/therapeutic-catalogs/service-shift-templates';
    expect((await request(app()).get(base).expect(200)).body.m).toBe('listShiftTemplates');
    expect((await request(app()).post(base).expect(200)).body.m).toBe('createShiftTemplate');
    expect((await request(app()).patch(`${base}/i-1`).expect(200)).body.m).toBe('updateShiftTemplate');
    expect((await request(app()).get(`${base}/options`).expect(200)).body.m).toBe('listShiftTemplateOptions');
  });

  describe('trilha (lex C9/C13: só nomes de container)', () => {
    it('as 4 rotas do projeto gravam trilha de `patient`; as de catálogo NÃO gravam nenhuma', async () => {
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
      await request(app([PROJETO_CREATE])).post('/api/admin/patients/abc-123/therapeutic-projects').send({}).expect(200);
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

    // ⚠️ `req.therapeuticContactContainers` (lex C6) só é lido no `finish` do `logResourceAccess`
    // REAL (`res.once('finish', ...)`, depois do handler rodar). O dublê deste arquivo captura a
    // ação SÍNCRONA, antes do controller — não reproduz essa ordem. A prova de que o campo chega
    // à trilha depois de escrito pelo controller é do `resourceAccessLog` real (unit próprio) +
    // e2e; aqui já está provado que `readTrail`/`versionTrail` LEEM o campo quando presente
    // (`contactContainersOf`, testado indiretamente pelas asserções de `therapeuticTrailAction`
    // em `therapeuticProjectAccess.test.ts`).
  });
});
