/**
 * A TERCEIRA família a declarar célula (task 3.5-A1). Mesmo papel dos testes de
 * `admin.users` e `admin.patients`: varrer o router de verdade (o mesmo
 * `scanExpressRouter` do catálogo) e afirmar que TODA rota declara, e declara a
 * célula do mapa — não a que o código escolheu.
 *
 * ⚠️ `admin.workers` é a primeira família ESPALHADA em 4 arquivos. Por isso o
 * teste monta as quatro peças e afirma a conta fechada de 31: se alguém
 * declarar três dos quatro routers, o número aqui denuncia. O oráculo COMPLETO
 * das 226 rotas continua sendo o e2e `permission-route-inventory`, contra o app
 * de pé.
 */

import express from 'express';
import { appDeRota } from '@shared/__tests__/appDeRota';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminWorkerRoutes, ADMIN_WORKERS_FAMILY } from '../adminWorkerRoutes';
import { createAdminWorkerDocumentsRoutes } from '../adminWorkerDocumentsRoutes';
import { createWorkerDocumentsRoutes } from '../workerDocumentsRoutes';
import {
  createWorkerContextRoutes,
  ingestRateLimitKey,
} from '@modules/matching/interfaces/routes/workerContextRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const trilhaArgs: unknown[][] = [];
jest.mock('@shared/audit/resourceAccessLog', () => ({
  logResourceAccess: (...args: unknown[]) => {
    trilhaArgs.push(args);
    return (_req: unknown, _res: unknown, next: express.NextFunction) => next();
  },
}));

/** Mapa esperado — copiado do route-permission-map.md, não do código. */
const ESPERADO_WORKERS: Record<string, string> = {
  'GET /workers/stats': 'worker:read',
  // PII: mesmo payload da ficha (corrigido contra o mapa da 0.6 — ver o router).
  'GET /workers/by-phone': 'worker_pii:read',
  'GET /workers/case-options': 'worker:read',
  'GET /workers/filter-options': 'worker:read',
  // Mapa de prestadores (REQ-04, DEC-14) — POST com corpo; leitura de pontos, célula de leitura.
  'POST /workers/map': 'worker_address:read',
  'POST /workers/sync-talentum': 'talentum:write',
  'GET /workers/export': 'worker:export',
  'GET /workers/:id/timeline': 'worker:read',
  'GET /workers/:id': 'worker:read',
  'PATCH /workers/:id/test-flag': 'worker:write',
  'PATCH /workers/:id/profile': 'worker:write',
  'PUT /workers/:id/service-area': 'worker:write',
  'GET /workers': 'worker:read',
  'GET /worker-tags': 'worker:read',
  'POST /worker-tags': 'worker:write',
  'PATCH /worker-tags/:id': 'worker:write',
  'DELETE /worker-tags/:id': 'worker:write',
  'POST /workers/:id/tags/:tagId': 'worker:write',
  'DELETE /workers/:id/tags/:tagId': 'worker:write',
};

const ESPERADO_DOCS: Record<string, string> = {
  'POST /workers/:id/documents/upload-url': 'worker_document:write',
  'POST /workers/:id/documents/save': 'worker_document:write',
  'POST /workers/:id/documents/view-url': 'worker_document:read',
  'DELETE /workers/:id/documents/:type': 'worker_document:delete',
  'POST /workers/:id/documents/:type/validate': 'worker_document:validate',
  'DELETE /workers/:id/documents/:type/validate': 'worker_document:validate',
};

const ESPERADO_ADICIONAIS: Record<string, string> = {
  'GET /admin/workers/:id/additional-documents': 'worker_document:read',
  'POST /admin/workers/:id/additional-documents/upload-url': 'worker_document:write',
  'POST /admin/workers/:id/additional-documents': 'worker_document:write',
  'DELETE /admin/workers/:id/additional-documents/:docId': 'worker_document:delete',
};

const ESPERADO_CONTEXTO: Record<string, string> = {
  'GET /workers/:id/current-interview': 'interview:read',
  'GET /workers/:id/available-vacancies': 'vacancy:read',
  'POST /workers/:id/documents/ingest-from-url': 'worker_document:write',
};

/** As 9 rotas do PRÓPRIO prestador — não são decisão de staff, não têm célula. */
const ROTAS_DO_PRESTADOR = [
  'GET /workers/me/documents',
  'POST /workers/me/documents/upload-url',
  'POST /workers/me/documents/save',
  'POST /workers/me/documents/view-url',
  'DELETE /workers/me/documents/:type',
  'GET /workers/me/additional-documents',
  'POST /workers/me/additional-documents/upload-url',
  'POST /workers/me/additional-documents',
  'DELETE /workers/me/additional-documents/:id',
];

/** Cada handler devolve o próprio nome — é o que identifica quem foi chamado. */
const responde = (nome: string) => (req: express.Request, res: express.Response) =>
  res.json({ m: nome, id: req.params.id });

function routerPrincipal(comMapa = true) {
  const c = {
    workers: {
      getWorkerByPhone: responde('getWorkerByPhone'),
      exportWorkers: responde('exportWorkers'),
      getWorkerById: responde('getWorkerById'),
      listWorkers: responde('listWorkers'),
    },
    aux: {
      getWorkerDateStats: responde('getWorkerDateStats'),
      listCaseOptions: responde('listCaseOptions'),
      getFilterOptions: responde('getFilterOptions'),
      syncTalentumWorkers: responde('syncTalentumWorkers'),
    },
    testFlag: { updateTestFlag: responde('updateTestFlag') },
    profile: { updateProfile: responde('updateProfile') },
    serviceArea: { updateServiceArea: responde('updateServiceArea') },
    tags: {
      list: responde('tags.list'),
      create: responde('tags.create'),
      update: responde('tags.update'),
      delete: responde('tags.delete'),
      assign: responde('tags.assign'),
      remove: responde('tags.remove'),
    },
    timeline: { getTimeline: responde('getTimeline') },
    ...(comMapa ? { map: { getMapPoints: responde('getMapPoints') } } : {}),
  };
  return createAdminWorkerRoutes(c as never, authDouble(), permissionsDouble());
}

function routerDocumentos() {
  const c = {
    getUploadSignedUrl: responde('docs.upload-url'),
    saveDocumentPath: responde('docs.save'),
    getViewSignedUrl: responde('docs.view-url'),
    deleteDocument: responde('docs.delete'),
    validateDocument: responde('docs.validate'),
    invalidateDocument: responde('docs.invalidate'),
  };
  return createAdminWorkerDocumentsRoutes(c as never, authDouble(), permissionsDouble());
}

function routerAdicionais() {
  const me = {
    getDocuments: responde('me.getDocuments'),
    getUploadSignedUrl: responde('me.upload-url'),
    saveDocumentPath: responde('me.save'),
    getViewSignedUrl: responde('me.view-url'),
    deleteDocument: responde('me.delete'),
  };
  const meAdicional = {
    list: responde('me.additional.list'),
    getUploadUrl: responde('me.additional.upload-url'),
    save: responde('me.additional.save'),
    remove: responde('me.additional.remove'),
  };
  const admin = {
    list: responde('admin.additional.list'),
    getUploadUrl: responde('admin.additional.upload-url'),
    save: responde('admin.additional.save'),
    remove: responde('admin.additional.remove'),
  };
  return createWorkerDocumentsRoutes(
    me as never, meAdicional as never, admin as never, authDouble(), permissionsDouble(),
  );
}

function routerContexto() {
  const c = {
    currentInterview: responde('currentInterview'),
    availableVacancies: responde('availableVacancies'),
    ingestFromUrl: responde('ingestFromUrl'),
  };
  return createWorkerContextRoutes(c as never, authDouble(), permissionsDouble());
}

function declaradas(router: express.Router): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(router).map((route) => [
      `${route.method} ${route.path}`,
      route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
    ]),
  );
}

describe('família admin.workers — as 4 peças declaram célula', () => {
  it('a família é `admin.workers` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_WORKERS_FAMILY).toBe('admin.workers');
  });

  it.each([
    ['adminWorkerRoutes', routerPrincipal, ESPERADO_WORKERS],
    ['adminWorkerDocumentsRoutes', routerDocumentos, ESPERADO_DOCS],
    ['workerContextRoutes', routerContexto, ESPERADO_CONTEXTO],
  ])('%s: cada rota declara a célula do mapa', (_nome, monta, esperado) => {
    expect(declaradas(monta())).toEqual(esperado);
  });

  it('workerDocumentsRoutes: as 4 rotas ADMIN declaram, as 9 do prestador não', () => {
    const todas = declaradas(routerAdicionais());
    const comCelula = Object.fromEntries(Object.entries(todas).filter(([, celula]) => celula !== null));
    const semCelula = Object.entries(todas)
      .filter(([, celula]) => celula === null)
      .map(([rota]) => rota);

    expect(comCelula).toEqual(ESPERADO_ADICIONAIS);
    expect(semCelula.sort()).toEqual([...ROTAS_DO_PRESTADOR].sort());
  });

  it.each([
    ['adminWorkerRoutes', routerPrincipal],
    ['adminWorkerDocumentsRoutes', routerDocumentos],
    ['workerContextRoutes', routerContexto],
  ])('%s: nenhuma rota fica sem declaração', (_nome, monta) => {
    expect(undeclaredRoutes(scanExpressRouter(monta()), () => true)).toEqual([]);
  });

  it('a família soma exatamente 32 rotas — as 31 do PENDING_DECLARATIONS + o mapa (main, 05/09)', () => {
    const total =
      Object.keys(ESPERADO_WORKERS).length +
      Object.keys(ESPERADO_DOCS).length +
      Object.keys(ESPERADO_ADICIONAIS).length +
      Object.keys(ESPERADO_CONTEXTO).length;
    expect(total).toBe(32);
  });

  it('abrir a FICHA é worker:read (D286 fase 2) — o dossiê NÃO vem junto: sai projetado por container', () => {
    // Até 06/09 a rota exigia `worker_pii:read` para a tela inteira. Agora a célula da rota é a
    // operacional e quem segura DNI/nascimento/endereço é a projeção (`AdminWorkersDetailBuilder`,
    // espião de decrypt = 0). A distinção ficha × lista continua — mudou de lugar, não sumiu.
    const rotas = scanExpressRouter(routerPrincipal());
    expect(rotas.find((r) => r.method === 'GET' && r.path === '/workers/:id')?.cell).toMatchObject({
      resource: 'worker',
      action: 'read',
    });
    expect(rotas.find((r) => r.method === 'GET' && r.path === '/workers')?.cell).toMatchObject({
      resource: 'worker',
      action: 'read',
    });
  });

  it('by-phone é worker_pii:read — devolve o MESMO dossiê da ficha, não um resumo', () => {
    // O mapa da 0.6 dizia `worker:read`. Com ele, `worker:read` sozinho seria
    // negado em `/workers/:id` e pegaria o dossiê idêntico por telefone.
    const rota = scanExpressRouter(routerPrincipal()).find((r) => r.path === '/workers/by-phone');
    expect(rota?.cell).toMatchObject({ resource: 'worker_pii', action: 'read' });
  });

  it('exportar é célula própria (worker:export), não uma leitura a mais', () => {
    const rota = scanExpressRouter(routerPrincipal()).find((r) => r.path === '/workers/export');
    expect(rota?.cell).toMatchObject({ resource: 'worker', action: 'export' });
  });

  describe('ordem das rotas — o que o tsc não pega', () => {
    it.each([
      ['get', '/api/admin/workers/export', 'exportWorkers'],
      ['get', '/api/admin/workers/stats', 'getWorkerDateStats'],
      ['get', '/api/admin/workers/filter-options', 'getFilterOptions'],
      ['get', '/api/admin/workers/case-options', 'listCaseOptions'],
      ['get', '/api/admin/workers/by-phone', 'getWorkerByPhone'],
      ['post', '/api/admin/workers/map', 'getMapPoints'],
    ])('%s %s NÃO é capturado por /workers/:id', async (metodo, caminho, esperado) => {
      const app = express();
      app.use('/api/admin', routerPrincipal());

      const res = await request(app)[metodo as 'get'](caminho).expect(200);

      expect(res.body.m).toBe(esperado);
    });

    it('C6 — a trilha do by-phone tira o id do HANDLER, nunca do telefone', () => {
      // A trilha é mock aqui, então supertest não alcançaria a arrow. O que
      // importa não é ela rodar: é o CONTRATO dela — de onde o id vem.
      routerPrincipal();
      const doByPhone = trilhaArgs.find((a) => a[1] === 'read_by_phone');
      expect(doByPhone).toBeDefined();
      expect(doByPhone![0]).toBe('worker');

      const idFrom = doByPhone![2] as (r: Record<string, unknown>) => string | undefined;

      // Com o worker resolvido pelo handler → o UUID.
      expect(idFrom({ recursoAcessadoId: 'w-uuid-1', query: { phone: '+5491133445566' } }))
        .toBe('w-uuid-1');

      // SEM o handler ter resolvido → `undefined`, e a trilha não grava. O que
      // NÃO pode acontecer é cair no telefone da query como identificador.
      expect(idFrom({ query: { phone: '+5491133445566' } })).toBeUndefined();
    });

    it('GET /workers/map não existe (é POST): "map" cai em /workers/:id, no handler de detalhe', async () => {
      const app = express();
      app.use('/api/admin', routerPrincipal());

      const res = await request(app).get('/api/admin/workers/map').expect(200);

      expect(res.body).toMatchObject({ m: 'getWorkerById', id: 'map' });
    });

    it('sem controller de mapa, POST /workers/map é 404 e o resto continua', async () => {
      const app = express();
      app.use('/api/admin', routerPrincipal(false));

      await request(app).post('/api/admin/workers/map').expect(404);
      const res = await request(app).get('/api/admin/workers').expect(200);
      expect(res.body.m).toBe('listWorkers');
    });

    it('/workers/:id/timeline não é engolido por /workers/:id', async () => {
      const app = express();
      app.use('/api/admin', routerPrincipal());

      const res = await request(app).get('/api/admin/workers/abc-123/timeline').expect(200);

      expect(res.body).toMatchObject({ m: 'getTimeline', id: 'abc-123' });
    });

    it('a ficha por id continua chegando no handler de id', async () => {
      const app = express();
      app.use('/api/admin', routerPrincipal());

      const res = await request(app).get('/api/admin/workers/abc-123').expect(200);

      expect(res.body).toMatchObject({ m: 'getWorkerById', id: 'abc-123' });
    });

    it('validate não é capturado por /documents/:type', async () => {
      const app = express();
      app.use('/api/admin', routerDocumentos());

      const res = await request(app).delete('/api/admin/workers/abc/documents/dni/validate').expect(200);

      expect(res.body.m).toBe('docs.invalidate');
    });
  });

  /**
   * Cada rota chega no MÉTODO certo do controller. Trocar dois handlers de
   * lugar numa família de 31 rotas é o erro clássico, e o tsc não pega (todas
   * as assinaturas são iguais). Exaustivo de propósito: é o que garante que
   * acrescentar rota sem teste derrube a cobertura per-file.
   */
  describe('cada rota chega no handler certo', () => {
    // Ver `@shared/__tests__/appDeRota`: app NOVO por caso do `it.each` era a
    // maior fonte de falso positivo desta suíte — 2 falhas em 15 rodadas dela
    // sozinha, com `400 Bad Request` (clientError do socket) e `200` truncado.
    const appCom = (monta: () => express.Router, prefixo: string) =>
      appDeRota(`${monta.name}|${prefixo}`, prefixo, monta);

    it.each([
      ['get', '/api/admin/workers/stats', 'getWorkerDateStats'],
      ['get', '/api/admin/workers/by-phone', 'getWorkerByPhone'],
      ['get', '/api/admin/workers/case-options', 'listCaseOptions'],
      ['get', '/api/admin/workers/filter-options', 'getFilterOptions'],
      ['post', '/api/admin/workers/map', 'getMapPoints'],
      ['post', '/api/admin/workers/sync-talentum', 'syncTalentumWorkers'],
      ['get', '/api/admin/workers/export', 'exportWorkers'],
      ['get', '/api/admin/workers/w1/timeline', 'getTimeline'],
      ['get', '/api/admin/workers/w1', 'getWorkerById'],
      ['patch', '/api/admin/workers/w1/test-flag', 'updateTestFlag'],
      ['patch', '/api/admin/workers/w1/profile', 'updateProfile'],
      ['put', '/api/admin/workers/w1/service-area', 'updateServiceArea'],
      ['get', '/api/admin/workers', 'listWorkers'],
      ['get', '/api/admin/worker-tags', 'tags.list'],
      ['post', '/api/admin/worker-tags', 'tags.create'],
      ['patch', '/api/admin/worker-tags/t1', 'tags.update'],
      ['delete', '/api/admin/worker-tags/t1', 'tags.delete'],
      ['post', '/api/admin/workers/w1/tags/t1', 'tags.assign'],
      ['delete', '/api/admin/workers/w1/tags/t1', 'tags.remove'],
    ] as const)('adminWorkerRoutes: %s %s → %s', async (metodo, caminho, esperado) => {
      const res = await request(appCom(routerPrincipal, '/api/admin'))[metodo](caminho).expect(200);
      expect(res.body.m).toBe(esperado);
    });

    it.each([
      ['post', '/api/admin/workers/w1/documents/upload-url', 'docs.upload-url'],
      ['post', '/api/admin/workers/w1/documents/save', 'docs.save'],
      ['post', '/api/admin/workers/w1/documents/view-url', 'docs.view-url'],
      ['delete', '/api/admin/workers/w1/documents/dni', 'docs.delete'],
      ['post', '/api/admin/workers/w1/documents/dni/validate', 'docs.validate'],
      ['delete', '/api/admin/workers/w1/documents/dni/validate', 'docs.invalidate'],
    ] as const)('adminWorkerDocumentsRoutes: %s %s → %s', async (metodo, caminho, esperado) => {
      const res = await request(appCom(routerDocumentos, '/api/admin'))[metodo](caminho).expect(200);
      expect(res.body.m).toBe(esperado);
    });

    it.each([
      ['get', '/api/workers/me/documents', 'me.getDocuments'],
      ['post', '/api/workers/me/documents/upload-url', 'me.upload-url'],
      ['post', '/api/workers/me/documents/save', 'me.save'],
      ['post', '/api/workers/me/documents/view-url', 'me.view-url'],
      ['delete', '/api/workers/me/documents/dni', 'me.delete'],
      ['get', '/api/workers/me/additional-documents', 'me.additional.list'],
      ['post', '/api/workers/me/additional-documents/upload-url', 'me.additional.upload-url'],
      ['post', '/api/workers/me/additional-documents', 'me.additional.save'],
      ['delete', '/api/workers/me/additional-documents/d1', 'me.additional.remove'],
      ['get', '/api/admin/workers/w1/additional-documents', 'admin.additional.list'],
      ['post', '/api/admin/workers/w1/additional-documents/upload-url', 'admin.additional.upload-url'],
      ['post', '/api/admin/workers/w1/additional-documents', 'admin.additional.save'],
      ['delete', '/api/admin/workers/w1/additional-documents/d1', 'admin.additional.remove'],
    ] as const)('workerDocumentsRoutes: %s %s → %s', async (metodo, caminho, esperado) => {
      const res = await request(appCom(routerAdicionais, '/api'))[metodo](caminho).expect(200);
      expect(res.body.m).toBe(esperado);
    });

    it.each([
      ['get', '/api/admin/workers/w1/current-interview', 'currentInterview'],
      ['get', '/api/admin/workers/w1/available-vacancies', 'availableVacancies'],
      ['post', '/api/admin/workers/w1/documents/ingest-from-url', 'ingestFromUrl'],
    ] as const)('workerContextRoutes: %s %s → %s', async (metodo, caminho, esperado) => {
      const res = await request(appCom(routerContexto, '/api/admin'))[metodo](caminho).expect(200);
      expect(res.body.m).toBe(esperado);
    });
  });

  /**
   * O rate limit do ingest é por workerId, não por IP: atrás do balanceador do
   * Cloud Run todo request pode chegar com o MESMO IP, o que tornaria o limite
   * global (um prestador travaria todos os outros).
   */
  describe('rate limit do ingest — chave por workerId, não por IP', () => {
    it('com workerId no path, a chave é o prestador', () => {
      expect(ingestRateLimitKey({ params: { id: 'w1' } } as unknown as express.Request)).toBe('worker:w1');
    });

    it('sem workerId, cai no IP — e sem IP, num marcador explícito', () => {
      expect(ingestRateLimitKey({ params: {}, ip: '10.0.0.1' } as unknown as express.Request)).toBe('ip:10.0.0.1');
      expect(ingestRateLimitKey({ params: {} } as unknown as express.Request)).toBe('ip:unknown');
    });

    /**
     * MORRE se o fallback voltar a usar `req.ip` cru: em IPv6 cada cliente tem
     * um /64 (às vezes /56) inteiro à disposição — trocar só o sufixo furaria
     * o limite porque cada endereço geraria uma chave diferente. Com
     * `ipKeyGenerator`, dois endereços do MESMO /56 colapsam na MESMA chave.
     */
    it('sem workerId, dois IPv6 do mesmo /56 geram a MESMA chave (ipKeyGenerator, não req.ip cru)', () => {
      const chave1 = ingestRateLimitKey({ params: {}, ip: '2001:db8:1:1::1' } as unknown as express.Request);
      const chave2 = ingestRateLimitKey({ params: {}, ip: '2001:db8:1:1::2' } as unknown as express.Request);
      expect(chave1).toBe(chave2);
      expect(chave1).not.toBe('ip:2001:db8:1:1::1');
    });

    it('sem workerId, IPv6 de /56 diferente gera chave diferente', () => {
      const chave1 = ingestRateLimitKey({ params: {}, ip: '2001:db8:1:1::1' } as unknown as express.Request);
      const chave2 = ingestRateLimitKey({ params: {}, ip: '2001:db8:2:1::1' } as unknown as express.Request);
      expect(chave1).not.toBe(chave2);
    });
  });

  /**
   * LIGAÇÃO real, não só a função isolada: os testes acima chamam
   * `ingestRateLimitKey` diretamente — se alguém trocar a linha
   * `keyGenerator: ingestRateLimitKey` do `rateLimit({...})` por um inline
   * qualquer (ex.: `(req) => req.ip ?? 'unknown'`), aqueles testes continuam
   * verdes, porque não exercitam o SITE onde o `keyGenerator:` é referenciado.
   *
   * Aqui a prova é pelo comportamento do limitador MONTADO: com o MESMO
   * workerId, a chave tem que ser `worker:<id>` INDEPENDENTE do IP de origem —
   * então 5 requisições do MESMO workerId vindas de 5 endereços IPv6
   * DIFERENTES (mesmo /56, via X-Forwarded-For + `trust proxy` para que
   * `req.ip` receba o valor) esgotam o `max=5` e a 6ª é 429. Se a linha
   * `keyGenerator:` for trocada por algo baseado em IP (perdendo o ramo do
   * workerId), cada endereço vira uma chave nova e o teste NUNCA vê 429.
   */
  describe('rate limit do ingest — LIGAÇÃO real: mesmo workerId, IPs diferentes não escapam do limite', () => {
    const controladorLigacao = {
      currentInterview: responde('currentInterview'),
      availableVacancies: responde('availableVacancies'),
      ingestFromUrl: jest.fn((req: express.Request, res: express.Response) => {
        res.status(200).json({ m: 'ingestFromUrl', id: req.params.id });
      }),
    };
    const routerLigacao = createWorkerContextRoutes(controladorLigacao as never, authDouble(), permissionsDouble());
    const servidorLigacao = appDeRota(
      'workerContextRoutesWiring',
      '/api/admin',
      () => routerLigacao,
      (app) => app.set('trust proxy', true),
    );

    it('5 IPv6 DIFERENTES do MESMO /56, MESMO workerId → a 6ª é 429 (chave é worker:<id>, não IP)', async () => {
      const enderecos = [
        '2001:db8:1:1::70', '2001:db8:1:1::71', '2001:db8:1:1::72',
        '2001:db8:1:1::73', '2001:db8:1:1::74', '2001:db8:1:1::75',
      ];
      for (let i = 0; i < 5; i++) {
        const ok = await request(servidorLigacao)
          .post('/api/admin/workers/wire1/documents/ingest-from-url')
          .set('X-Forwarded-For', enderecos[i])
          .send({});
        expect(ok.status).toBe(200);
      }
      (controladorLigacao.ingestFromUrl as jest.Mock).mockClear();
      const bloqueado = await request(servidorLigacao)
        .post('/api/admin/workers/wire1/documents/ingest-from-url')
        .set('X-Forwarded-For', enderecos[5])
        .send({});
      expect(bloqueado.status).toBe(429);
      expect(controladorLigacao.ingestFromUrl).not.toHaveBeenCalled();
    });
  });
});
