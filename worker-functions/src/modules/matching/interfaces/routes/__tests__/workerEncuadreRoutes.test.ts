/**
 * Família `admin.encuadre` (task 3.5-A6) — a ÚLTIMA a declarar, e a que **zera**
 * o `PENDING_DECLARATIONS`.
 *
 * São as 10 rotas que o perímetro não alcançava: `requireStaff`, mas moram em
 * `/api/workers/` e `/api/cases/`, fora de `GOVERNED_PREFIXES`. Entraram por NOME
 * no PR #237 e aqui recebem célula.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createWorkerEncuadreRoutes, ADMIN_ENCUADRE_FAMILY } from '../workerEncuadreRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** Mapa esperado — copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'GET /workers/status-dashboard': 'worker:read',
  'GET /workers/by-status/:status': 'worker:read',
  'PUT /workers/:id/status': 'worker:write',
  'PUT /workers/:id/occupation': 'worker:write',
  'GET /workers/docs-expiring': 'worker_document:read',
  'PUT /workers/:id/doc-expiry': 'worker_document:write',
  'GET /workers/:id/encuadres': 'match:read',
  'GET /workers/:id/cases': 'match:read',
  'GET /cases/:caseNumber/encuadres': 'match:read',
  'GET /cases/:caseNumber/workers': 'match:read',
};

const responde = (nome: string) => (req: express.Request, res: express.Response) =>
  res.json({ m: nome, id: req.params.id ?? req.params.caseNumber ?? req.params.status });

function build(): express.Router {
  const controller = Object.fromEntries(
    ['getStatusDashboard', 'getWorkersByStatus', 'updateWorkerStatus', 'updateOccupation',
     'getDocsExpiringSoon', 'updateDocExpiry', 'getWorkerEncuadres', 'getWorkerCases',
     'getCaseEncuadres', 'getCaseWorkers'].map((m) => [m, responde(m)]),
  );
  return createWorkerEncuadreRoutes(controller as never, authDouble(), permissionsDouble());
}

function declaradas(): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(build()).map((r) => [
      `${r.method} ${r.path}`,
      r.cell ? cellKey(r.cell.resource, r.cell.action) : null,
    ]),
  );
}

describe('família admin.encuadre — as 10 rotas que o perímetro não alcançava', () => {
  it('a família é `admin.encuadre` — nome PRÓPRIO, não `admin.workers`', () => {
    // Desvio deliberado da recomendação do plano: estas rotas são a parte menos
    // exercitada da superfície (estavam fora do perímetro até 19/08). Virar
    // sozinhas, depois de `admin.workers` já ter provado estabilidade, é o
    // isolamento de risco para o qual a família existe.
    expect(ADMIN_ENCUADRE_FAMILY).toBe('admin.encuadre');
  });

  it('cada rota declara a célula do mapa (route-permission-map.md)', () => {
    expect(declaradas()).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('a família soma exatamente 10 rotas — as que ZERAM o PENDING_DECLARATIONS', () => {
    expect(scanExpressRouter(build())).toHaveLength(10);
  });

  it('reusa células de `admin.workers` — célula é transversal, família é rollout', () => {
    // Nenhuma célula aqui é nova: as 5 já são declaradas por `admin.workers`.
    // O que esta família acrescenta é uma ALAVANCA de rollout separada.
    expect(new Set(Object.values(declaradas()))).toEqual(
      new Set(['worker:read', 'worker:write', 'worker_document:read', 'worker_document:write', 'match:read']),
    );
  });

  it('ESCREVER status/ocupação de funil é worker:write — não uma leitura de dashboard', () => {
    expect(declaradas()['PUT /workers/:id/status']).toBe('worker:write');
    expect(declaradas()['PUT /workers/:id/occupation']).toBe('worker:write');
    expect(declaradas()['GET /workers/status-dashboard']).toBe('worker:read');
  });

  it('vencimento de documento é worker_document, não worker', () => {
    expect(declaradas()['GET /workers/docs-expiring']).toBe('worker_document:read');
    expect(declaradas()['PUT /workers/:id/doc-expiry']).toBe('worker_document:write');
  });

  it('as 4 leituras de encuadre/caso são match:read', () => {
    for (const rota of ['GET /workers/:id/encuadres', 'GET /workers/:id/cases',
                        'GET /cases/:caseNumber/encuadres', 'GET /cases/:caseNumber/workers']) {
      expect(declaradas()[rota]).toBe('match:read');
    }
  });

  describe('ordem das rotas — o que o tsc não pega', () => {
    it('`docs-expiring` e `status-dashboard` não são engolidos por `/workers/:id/...`', async () => {
      const app = express();
      app.use('/api', build());

      expect((await request(app).get('/api/workers/docs-expiring').expect(200)).body.m)
        .toBe('getDocsExpiringSoon');
      expect((await request(app).get('/api/workers/status-dashboard').expect(200)).body.m)
        .toBe('getStatusDashboard');
    });
  });

  it.each([
    ['get', '/api/workers/status-dashboard', 'getStatusDashboard'],
    ['get', '/api/workers/by-status/ACTIVE', 'getWorkersByStatus'],
    ['put', '/api/workers/w1/status', 'updateWorkerStatus'],
    ['put', '/api/workers/w1/occupation', 'updateOccupation'],
    ['get', '/api/workers/docs-expiring', 'getDocsExpiringSoon'],
    ['put', '/api/workers/w1/doc-expiry', 'updateDocExpiry'],
    ['get', '/api/workers/w1/encuadres', 'getWorkerEncuadres'],
    ['get', '/api/workers/w1/cases', 'getWorkerCases'],
    ['get', '/api/cases/42/encuadres', 'getCaseEncuadres'],
    ['get', '/api/cases/42/workers', 'getCaseWorkers'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = express();
    app.use('/api', build());

    const res = await request(app)[metodo](caminho).expect(200);

    expect(res.body.m).toBe(esperado);
  });
});
