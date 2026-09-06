/**
 * Router SINTÉTICO, mas Express de VERDADE: a varredura anda em `_router.stack`,
 * uma estrutura interna do framework. Um mock desse formato provaria que o
 * código lê o mock, não que lê o Express — e é justamente na forma real
 * (sub-router montado, parâmetro na rota, middleware sem rota) que ele quebra.
 */

import express, { Router, type RequestHandler } from 'express';
import {
  cellsForaDeRota,
  declaredCells,
  mountPathOf,
  scanExpressRouter,
  undeclaredRoutes,
} from '../scanExpressRouter';
import { markPermissionHandler, readPermissionMetadata, exemptHandler, readExemptMetadata } from '../permissionMetadata';
import { CELL_DESCRIPTION } from '../../../domain/PermissionCell';

const ok: RequestHandler = (_req, res) => res.json({});

/** Simula o que o `requirePermission` do grupo 3 vai fazer: carimbar o guard. */
function guard(resource: string, action: string): RequestHandler {
  return markPermissionHandler(((_req, _res, next) => next()) as RequestHandler, { resource, action });
}

function buildApp(): express.Express {
  const app = express();

  const workers = Router();
  workers.get('/', guard('worker', 'read'), ok);
  workers.get('/:id', guard('worker_pii', 'read'), ok);
  workers.delete('/:id', guard('worker', 'delete'), ok);
  workers.post('/sem-declaracao', ok); // a rota que o teste de rotas tem que pegar

  const nested = Router();
  nested.patch('/:tagId', guard('worker', 'write'), ok);
  workers.use('/tags', nested);

  // sub-router montado num caminho COM parâmetro — o Express guarda isso só na
  // regexp da camada, e é onde a reconstrução do caminho costuma sair errada
  const candidatos = Router();
  candidatos.get('/', guard('funnel', 'read'), ok);
  app.use('/api/admin/vacancies/:vacancyId/candidates', candidatos);

  app.use('/api/admin/workers', workers);
  app.get('/health', ok); // fora do domínio governado
  app.use('/api/docs', guard('api_docs', 'read')); // middleware montado COM célula
  return app;
}

describe('scanExpressRouter', () => {
  const routes = scanExpressRouter(buildApp());
  const find = (method: string, path: string) =>
    routes.find((route) => route.method === method && route.path === path);

  it('encontra rota de sub-router com o caminho de montagem reconstruído', () => {
    expect(find('GET', '/api/admin/workers')?.cell).toEqual({ resource: 'worker', action: 'read' });
    expect(find('GET', '/api/admin/workers/:id')?.cell).toEqual({ resource: 'worker_pii', action: 'read' });
    expect(find('DELETE', '/api/admin/workers/:id')?.cell).toEqual({ resource: 'worker', action: 'delete' });
  });

  it('desce em sub-router aninhado (router dentro de router)', () => {
    expect(find('PATCH', '/api/admin/workers/tags/:tagId')?.cell).toEqual({
      resource: 'worker',
      action: 'write',
    });
  });

  it('reconstrói o caminho de montagem com parâmetro (:vacancyId)', () => {
    expect(find('GET', '/api/admin/vacancies/:vacancyId/candidates')?.cell).toEqual({
      resource: 'funnel',
      action: 'read',
    });
  });

  it('inclui middleware montado com célula como entrada USE', () => {
    expect(find('USE', '/api/docs')?.cell).toEqual({ resource: 'api_docs', action: 'read' });
  });

  it('lista rota sem declaração — a entrada do teste deny-when-undeclared', () => {
    const semDeclaracao = undeclaredRoutes(routes, (route) => route.path.startsWith('/api/admin'));
    expect(semDeclaracao.map((route) => `${route.method} ${route.path}`)).toEqual([
      'POST /api/admin/workers/sem-declaracao',
    ]);
    // `/health` não é do domínio governado — não pode aparecer
    expect(undeclaredRoutes(routes, (route) => route.path.startsWith('/api/admin'))
      .some((route) => route.path === '/health')).toBe(false);
  });

  it('declaredCells deduplica e ordena — é o que vai para o catálogo', () => {
    expect(declaredCells(routes).map((cell) => `${cell.resource}:${cell.action}`)).toEqual([
      'api_docs:read',
      'funnel:read',
      'worker:delete',
      'worker:read',
      'worker:write',
      'worker_pii:read',
    ]);
  });

  it('alvo cujo acesso a `router` LANÇA (getter de depreciação do Express 4) não derruba a varredura', () => {
    const armadilha = {
      get router(): never {
        throw new Error("'app.router' is deprecated!");
      },
    };
    expect(scanExpressRouter(armadilha as never)).toEqual([]);
  });

  it('app sem router montado devolve lista vazia (e não explode)', () => {
    expect(scanExpressRouter(express())).toEqual([]);
    expect(scanExpressRouter(Router())).toEqual([]);
  });
});

describe('mountPathOf — camadas fora do feitio comum', () => {
  it('camada sem regexp ou montada na raiz não contribui caminho', () => {
    expect(mountPathOf({})).toBe('');
    expect(mountPathOf({ regexp: Object.assign(/^\/?(?=\/|$)/, { fast_slash: true }) })).toBe('');
  });

  it('parâmetro sem `keys` correspondente vira `:param` em vez de sumir', () => {
    const regexp = /^\/api\/x(?:\/([^/]+?))\/y\/?(?=\/|$)/ as RegExp & { fast_slash?: boolean };
    expect(mountPathOf({ regexp })).toBe('/api/x/:param/y');
  });
});

describe('rota registrada com vários caminhos e sem método', () => {
  it('uma rota com dois paths vira duas entradas', () => {
    const app = express();
    app.get(['/a', '/b'], guard('dashboard', 'read'), ok);
    const paths = scanExpressRouter(app).map((route) => route.path);
    expect(paths).toEqual(expect.arrayContaining(['/a', '/b']));
  });
});

describe('permissionMetadata', () => {
  it('carimba sem tornar a propriedade enumerável (não vaza em spread/log)', () => {
    const handler = markPermissionHandler(((_req, _res, next) => next()) as RequestHandler, {
      resource: 'patient',
      action: 'delete',
    });
    expect(readPermissionMetadata(handler)).toEqual({ resource: 'patient', action: 'delete' });
    expect(Object.keys(handler)).toEqual([]);
  });

  it('não confunde qualquer coisa com handler declarado', () => {
    expect(readPermissionMetadata(undefined)).toBeUndefined();
    expect(readPermissionMetadata({ resource: 'x' })).toBeUndefined();
    expect(readPermissionMetadata(() => undefined)).toBeUndefined();
  });
});

/**
 * Os ramos DEFENSIVOS da varredura (`?? []`, `|| '/'`, o empate no comparador).
 * Não são preciosismo de cobertura: é aqui que a varredura cai quando o router
 * tem forma inesperada — e uma varredura que quebra em silêncio significa
 * catálogo incompleto E guard cego, as duas proteções de uma vez.
 *
 * Camadas sintéticas de propósito NESTE bloco: o Express não produz camada sem
 * `stack`, sem `methods` ou com `path` ausente, e são exatamente essas formas
 * que os fallbacks existem para tolerar.
 */
describe('ramos defensivos da varredura', () => {
  function comCamadas(layers: unknown[]): ReturnType<typeof scanExpressRouter> {
    return scanExpressRouter({ _router: { stack: layers } } as never);
  }

  it('rota sem `stack` e sem `methods` vira USE, sem quebrar', () => {
    expect(comCamadas([{ route: { path: '/api/admin/x' } }])).toEqual([
      { method: 'USE', path: '/api/admin/x' },
    ]);
  });

  it('rota com `methods` todo false também vira USE', () => {
    expect(comCamadas([{ route: { path: '/x', methods: { get: false }, stack: [] } }])[0].method).toBe('USE');
  });

  it('rota sem `path` cai na raiz em vez de virar caminho vazio', () => {
    expect(comCamadas([{ route: { methods: { get: true }, stack: [] } }])).toEqual([
      { method: 'GET', path: '/' },
    ]);
  });

  it('middleware com célula montado na RAIZ vira `/` (e não caminho vazio)', () => {
    const cell = { resource: 'api_docs', action: 'read' };
    const handle = markPermissionHandler(((_req, _res, next) => next()) as RequestHandler, cell);
    expect(comCamadas([{ handle, regexp: Object.assign(/^\/?$/, { fast_slash: true }) }])).toEqual([
      { method: 'USE', path: '/', cell },
    ]);
  });

  it('mountPathOf devolve vazio para regexp que resolve na raiz', () => {
    expect(mountPathOf({ regexp: /^\/(?=\/|$)/ } as never)).toBe('');
  });

  it('duas rotas com a MESMA célula colapsam em uma entrada', () => {
    // E é por isso que o ramo de empate do comparador é inalcançável: o dedup
    // por chave acontece ANTES do sort, então nunca há dois itens iguais para
    // comparar — com uma entrada só, o comparador nem chega a ser chamado.
    const cell = { resource: 'worker', action: 'read' };
    const rotas = [
      { method: 'GET', path: '/a', cell },
      { method: 'GET', path: '/b', cell },
    ];
    // A asserção é sobre a DEDUPE, que é o que este caso prova. A `description`
    // que o `declaredCells` passou a preencher (C2 da F2) é contrato de outro
    // caso, logo abaixo — travar a forma do objeto aqui faria este teste
    // reprovar toda vez que uma definição de célula nova fosse escrita.
    expect(declaredCells(rotas)).toHaveLength(1);
    expect(declaredCells(rotas)[0]).toMatchObject(cell);
  });
});

describe('declaredCells — a definição da célula chega ao catálogo (C2 da F2)', () => {
  const rota = (resource: string, action: string, description?: string) => ({
    method: 'GET',
    path: `/api/admin/${resource}`,
    cell: { resource, action, ...(description ? { description } : {}) },
  });

  it('célula SEM descrição na rota sai com a definição do vocabulário', () => {
    const [c] = declaredCells([rota('worker_contact', 'read')] as never);
    expect(c.description).toBe(CELL_DESCRIPTION['worker_contact:read']);
    expect(c.description).toContain('telefone');
  });

  it('o que a ROTA declara ganha do vocabulário — a rota conhece o caso particular', () => {
    const [c] = declaredCells([rota('worker_pii', 'read', 'só nesta rota')] as never);
    expect(c.description).toBe('só nesta rota');
  });

  it('célula sem definição em lugar nenhum sai `null`, nunca `undefined`', () => {
    const [c] = declaredCells([rota('coisa_nova', 'read')] as never);
    expect(c.description).toBeNull();
  });

  it('a definição NÃO se perde na dedupe de duas rotas com a mesma célula', () => {
    const cs = declaredCells([rota('worker_pii', 'read'), rota('worker_pii', 'read')] as never);
    expect(cs).toHaveLength(1);
    expect(cs[0].description).toBe(CELL_DESCRIPTION['worker_pii:read']);
  });
});

describe('cellsForaDeRota — a 2ª fonte do catálogo (B1 do gate `revisao-pr`)', () => {
  /**
   * 🔴 O conjunto é FIXO de propósito. Célula que o código enforça abaixo da
   * rota e ninguém declarar não existe em `iam.permissions` — o painel não a
   * oferece, ninguém a recebe, e no flip a projeção redige para TODO MUNDO.
   * Se alguém escrever uma definição nova em `CELL_DESCRIPTION` sem rota, este
   * caso fica vermelho e obriga a decisão a ser consciente.
   */
  it('as células sem rota são EXATAMENTE `worker_contact:read`, `worker:disable`, os containers de paciente (D286) e as ferramentas da D116', () => {
    const deRota = declaredCells([
      { method: 'GET', path: '/w', cell: { resource: 'worker', action: 'read' } },
      { method: 'GET', path: '/d', cell: { resource: 'worker_pii', action: 'read' } },
    ]);

    expect(cellsForaDeRota(deRota).map((c) => `${c.resource}:${c.action}`)).toEqual([
      'worker_contact:read',
      // D286 fase 2 — endereço do prestador (ficha e mapa); o fixture de rota deste teste não declara o mapa
      'worker_address:read',
      'worker:disable',
      // D116 — ferramentas sem botão no painel (purga de teste, monitor sintético, docs); declaradas
      // em CELL_DESCRIPTION no sync main→stage de 06/09 para o painel não as mostrar sem texto.
      'patient:delete',
      'messaging:write',
      'integration:execute',
      'test_fixtures:execute',
      'api_docs:read',
      // D286 — os containers da ficha do paciente. A maioria É declarada por rota no app real
      // (endereços, serviços, diagnósticos, seções); aqui o fixture de rota não declara nenhuma,
      // então TODAS saem como complemento — e é isso que garante que nenhuma some do catálogo.
      'patient_identity:read',
      'patient_identity:write',
      'patient_clinical:read',
      'patient_clinical:write',
      'patient_care_team:read',
      'patient_family:read',
      'patient_family:write',
      'patient_chat:read',
      'patient_chat:write',
      'patient_coverage:read',
      'patient_coverage:write',
      'patient_address:read',
      'patient_address:write',
      'patient_services:read',
      'patient_services:write',
    ]);
  });

  it('cada uma chega ao catálogo COM a definição escrita — é ela que o painel mostra', () => {
    const fora = cellsForaDeRota([]);
    const contato = fora.find((c) => c.resource === 'worker_contact');

    expect(contato?.description).toContain('CONTATO do prestador');
    expect(fora.every((c) => (c.description ?? '').length > 0)).toBe(true);
  });

  it('o que a ROTA já declarou não é repetido — a rota conhece o caso particular', () => {
    const deRota = declaredCells([
      { method: 'GET', path: '/c', cell: { resource: 'worker_contact', action: 'read', description: 'só nesta rota' } },
    ]);

    const fora = cellsForaDeRota(deRota);

    expect(fora.map((c) => `${c.resource}:${c.action}`)).not.toContain('worker_contact:read');
    expect(fora.map((c) => `${c.resource}:${c.action}`)).toContain('worker:disable');
  });

  it('🔴 varredura VAZIA não é mascarada — a fusão do wiring devolve vazio', () => {
    // O `SyncPermissionCatalogUseCase` aborta fail-closed com lista vazia. Se a
    // fusão somasse as de código incondicionalmente, varredura vazia chegaria
    // como "4 células" e o sync descontinuaria as 40 de rota de uma vez. Este
    // caso reproduz a expressão do wiring.
    const deRota = declaredCells([]);
    const paraSincronizar = deRota.length === 0 ? [] : [...deRota, ...cellsForaDeRota(deRota)];

    expect(deRota).toEqual([]);
    expect(paraSincronizar).toEqual([]);
    // E a 2ª fonte SOZINHA não é vazia — é isso que tornaria o mascaramento possível.
    expect(cellsForaDeRota(deRota).length).toBeGreaterThan(0);
  });
});

describe('isenção declarada na montagem (exemptHandler)', () => {
  it('a varredura lê a marca de isenção da rota, em qualquer posição da pilha', () => {
    const app = express();
    app.get('/v1/self', (_req, _res, next) => next(), exemptHandler('self'), (_req, res) => res.end());
    app.get('/v1/nada', (_req, res) => res.end());
    const rotas = scanExpressRouter(app);
    expect(rotas.find((r) => r.path === '/v1/self')?.exempt).toEqual({ reason: 'self' });
    expect(rotas.find((r) => r.path === '/v1/nada')?.exempt).toBeUndefined();
  });

  it('readExemptMetadata só lê função — string, objeto e undefined devolvem undefined', () => {
    expect(readExemptMetadata('x')).toBeUndefined();
    expect(readExemptMetadata({})).toBeUndefined();
    expect(readExemptMetadata(undefined)).toBeUndefined();
    expect(readExemptMetadata(exemptHandler('r'))).toEqual({ reason: 'r' });
  });

  it('o handler isento é passthrough: chama next() e não responde', () => {
    const next = jest.fn();
    exemptHandler('r')({} as never, {} as never, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
