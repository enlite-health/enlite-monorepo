/**
 * Família `admin.analytics` (task 3.5-A3): 15 rotas, 4 células, todas já no seed
 * da migration 206. Mesmo papel dos testes das famílias anteriores — varre o
 * router de verdade e afirma que TODA rota declara, e declara a célula do MAPA.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAnalyticsRoutes, ADMIN_ANALYTICS_FAMILY } from '../analyticsRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** Mapa esperado — copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'GET /workers': 'analytics:read',
  'GET /workers/missing-documents': 'analytics:read',
  'GET /workers/:workerId/vacancies': 'analytics:read',
  'GET /vacancies': 'analytics:read',
  'GET /vacancies/case/:caseNumber': 'analytics:read',
  'GET /vacancies/:id/incomplete-registrations': 'analytics:read',
  'GET /vacancies/:id': 'analytics:read',
  'GET /dedup/candidates': 'dedup:read',
  'POST /dedup/run': 'dedup:execute',
  'GET /dashboard/global': 'dashboard:read',
  'GET /dashboard/zones': 'dashboard:read',
  'GET /dashboard/reemplazos': 'dashboard:read',
  'GET /dashboard/management': 'dashboard:read',
  'GET /dashboard/zone-analytics': 'dashboard:read',
  'GET /dashboard/cases/:caseNumber': 'dashboard:read',
};

const responde = (nome: string) => (req: express.Request, res: express.Response) =>
  res.json({ m: nome, id: req.params.id ?? req.params.workerId ?? req.params.caseNumber });

function build(): express.Router {
  const controller = Object.fromEntries(
    ['getWorkerStats', 'getWorkersMissingDocuments', 'getWorkerVacancyEngagement', 'listVacancies',
     'getVacancyByCaseNumber', 'getVacancyIncompleteRegistrations', 'getVacancyById',
     'getDedupCandidates', 'runDeduplication', 'getGlobalMetrics', 'getZoneMetrics',
     'getReemplazosMetrics', 'getManagementMetrics', 'getZoneAnalytics', 'getCaseMetrics']
      .map((m) => [m, responde(m)]),
  );
  return createAnalyticsRoutes(controller as never, authDouble(), permissionsDouble());
}

function declaradas(): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(build()).map((r) => [
      `${r.method} ${r.path}`,
      r.cell ? cellKey(r.cell.resource, r.cell.action) : null,
    ]),
  );
}

describe('família admin.analytics — 15 rotas declaram célula', () => {
  it('a família é `admin.analytics` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_ANALYTICS_FAMILY).toBe('admin.analytics');
  });

  it('cada rota declara a célula do mapa (route-permission-map.md)', () => {
    expect(declaradas()).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('a família soma exatamente 15 rotas — a conta que saiu do PENDING_DECLARATIONS', () => {
    expect(scanExpressRouter(build())).toHaveLength(15);
  });

  it('RODAR a deduplicação é dedup:execute — ver candidatos é dedup:read', () => {
    // A célula destrutiva da família `admin.dedup` (A5) mora AQUI. Fica nesta
    // família de propósito: família é o que a flag liga, e mover uma rota de
    // família por causa da célula quebraria essa correspondência.
    expect(declaradas()['POST /dedup/run']).toBe('dedup:execute');
    expect(declaradas()['GET /dedup/candidates']).toBe('dedup:read');
  });

  it('o dashboard é dashboard:read — não analytics:read', () => {
    for (const rota of Object.keys(ESPERADO).filter((r) => r.includes('/dashboard/'))) {
      expect(declaradas()[rota]).toBe('dashboard:read');
    }
  });

  describe('ordem das rotas — o que o tsc não pega', () => {
    it.each([
      ['get', '/analytics/workers/missing-documents', 'getWorkersMissingDocuments'],
      ['get', '/analytics/vacancies/case/42', 'getVacancyByCaseNumber'],
      ['get', '/analytics/vacancies/v1/incomplete-registrations', 'getVacancyIncompleteRegistrations'],
      ['get', '/analytics/dashboard/global', 'getGlobalMetrics'],
      ['get', '/analytics/dashboard/zones', 'getZoneMetrics'],
      ['get', '/analytics/dashboard/zone-analytics', 'getZoneAnalytics'],
    ] as const)('%s %s NÃO é capturado pela rota paramétrica', async (metodo, caminho, esperado) => {
      const app = express();
      app.use('/analytics', build());

      const res = await request(app)[metodo](caminho).expect(200);

      expect(res.body.m).toBe(esperado);
    });
  });

  /**
   * As 15 rotas chegam no MÉTODO certo. Exaustivo de propósito: é o que faz a
   * cobertura per-file fechar em 100% e o que pega handler trocado de lugar,
   * que o tsc não vê porque todas as assinaturas são iguais.
   */
  it.each([
    ['get', '/analytics/workers', 'getWorkerStats'],
    ['get', '/analytics/workers/missing-documents', 'getWorkersMissingDocuments'],
    ['get', '/analytics/workers/w1/vacancies', 'getWorkerVacancyEngagement'],
    ['get', '/analytics/vacancies', 'listVacancies'],
    ['get', '/analytics/vacancies/case/42', 'getVacancyByCaseNumber'],
    ['get', '/analytics/vacancies/v1/incomplete-registrations', 'getVacancyIncompleteRegistrations'],
    ['get', '/analytics/vacancies/v1', 'getVacancyById'],
    ['get', '/analytics/dedup/candidates', 'getDedupCandidates'],
    ['post', '/analytics/dedup/run', 'runDeduplication'],
    ['get', '/analytics/dashboard/global', 'getGlobalMetrics'],
    ['get', '/analytics/dashboard/zones', 'getZoneMetrics'],
    ['get', '/analytics/dashboard/reemplazos', 'getReemplazosMetrics'],
    ['get', '/analytics/dashboard/management', 'getManagementMetrics'],
    ['get', '/analytics/dashboard/zone-analytics', 'getZoneAnalytics'],
    ['get', '/analytics/dashboard/cases/42', 'getCaseMetrics'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = express();
    app.use('/analytics', build());

    const res = await request(app)[metodo](caminho).expect(200);

    expect(res.body.m).toBe(esperado);
  });
});
