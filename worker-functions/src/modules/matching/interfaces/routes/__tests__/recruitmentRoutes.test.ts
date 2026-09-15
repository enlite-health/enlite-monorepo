/**
 * Família `admin.recruitment` (task 3.5-A3): 11 rotas ao todo, 5 células, todas
 * já no seed da 206. **Dez moram neste router; a 11ª
 * (`GET /api/admin/recruitment/health`) é declarada no `src/index.ts`** — o
 * controller dela depende do `dbPool`, criado depois deste mount. Por isso o
 * número afirmado aqui é 10, e o oráculo das 11 é o e2e
 * `permission-route-inventory`, contra o app de pé.
 */

// ⚠️ ANTES de qualquer import de `src/`: o router constrói
// `RecruitmentAnalyticsController` e `RecruitmentBlockedController` DENTRO da
// fábrica, e ambos pedem o pool no construtor. A URL é falsa de propósito —
// `pg.Pool` não conecta até a primeira query, e este teste não faz nenhuma.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://unit:unit@127.0.0.1:1/unit';

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createRecruitmentRoutes, ADMIN_RECRUITMENT_FAMILY } from '../recruitmentRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** Mapa esperado — copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'GET /admin/recruitment/clickup-cases': 'recruitment:read',
  'GET /admin/recruitment/talentum-workers': 'talentum:read',
  'GET /admin/recruitment/progreso': 'recruitment:read',
  'GET /admin/recruitment/publications': 'recruitment:read',
  'GET /admin/recruitment/encuadres': 'match:read',
  'GET /admin/recruitment/global-metrics': 'recruitment:read',
  'GET /admin/recruitment/case/:caseNumber': 'recruitment:read',
  'GET /admin/recruitment/zones': 'recruitment:read',
  // PR-8b 8b.4: calcular reemplazos exige create E update (pr8b-mapa-rotas.tsv linha 78,
  // regra-orquestrador 15/09 — cálculo em massa sem :id). O scanner só carimba o 1º guard do
  // array (scanExpressRouter.ts, cellOfRoute); o 2º é provado por
  // pr8b-ambiguous-routes.test.ts.
  'POST /admin/recruitment/calculate-reemplazos': 'recruitment:create',
  'GET /admin/recruitment/blocked-attempts': 'recruitment:read',
};

const responde = (nome: string) => (req: express.Request, res: express.Response) =>
  res.json({ m: nome, caso: req.params.caseNumber });

/** Só o `recruitmentController` é injetável — os outros dois o router constrói. */
function build(): express.Router {
  const controller = Object.fromEntries(
    ['getClickUpCases', 'getTalentumWorkers', 'getProgresoWorkers', 'getPublications', 'getEncuadres']
      .map((m) => [m, responde(m)]),
  );
  return createRecruitmentRoutes(controller as never, authDouble(), permissionsDouble());
}

function declaradas(): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(build()).map((r) => [
      `${r.method} ${r.path}`,
      r.cell ? cellKey(r.cell.resource, r.cell.action) : null,
    ]),
  );
}

describe('família admin.recruitment — as 10 rotas deste router declaram célula', () => {
  it('a família é `admin.recruitment` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_RECRUITMENT_FAMILY).toBe('admin.recruitment');
  });

  it('cada rota declara a célula do mapa (route-permission-map.md)', () => {
    expect(declaradas()).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('este router tem 10 rotas — a 11ª da família é declarada no src/index.ts', () => {
    expect(scanExpressRouter(build())).toHaveLength(10);
  });

  it('a lista de encuadres é match:read, não recruitment:read — é dado de match', () => {
    expect(declaradas()['GET /admin/recruitment/encuadres']).toBe('match:read');
  });

  it('a lista do Talentum é talentum:read — portal externo tem célula própria', () => {
    expect(declaradas()['GET /admin/recruitment/talentum-workers']).toBe('talentum:read');
  });

  it('calcular reemplazos ESCREVE — recruitment:create (+ update, pr8b-ambiguous-routes.test.ts), não read', () => {
    expect(declaradas()['POST /admin/recruitment/calculate-reemplazos']).toBe('recruitment:create');
  });

  /**
   * As 5 rotas do controller INJETÁVEL chegam no método certo. As outras 5 usam
   * controllers que o router constrói internamente (mesma dívida de injeção das
   * famílias anteriores): ali só dá para afirmar que a request não caiu no
   * handler de outra rota — que é o erro de ordem a pegar.
   */
  it.each([
    ['get', '/api/admin/recruitment/clickup-cases', 'getClickUpCases'],
    ['get', '/api/admin/recruitment/talentum-workers', 'getTalentumWorkers'],
    ['get', '/api/admin/recruitment/progreso', 'getProgresoWorkers'],
    ['get', '/api/admin/recruitment/publications', 'getPublications'],
    ['get', '/api/admin/recruitment/encuadres', 'getEncuadres'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = express();
    app.use('/api', build());

    const res = await request(app)[metodo](caminho).expect(200);

    expect(res.body.m).toBe(esperado);
  });

  it.each([
    ['get', '/api/admin/recruitment/global-metrics'],
    ['get', '/api/admin/recruitment/case/42'],
    ['get', '/api/admin/recruitment/zones'],
    ['post', '/api/admin/recruitment/calculate-reemplazos'],
    ['get', '/api/admin/recruitment/blocked-attempts'],
  ] as const)('%s %s despacha para o controller interno, não para outro handler', async (metodo, caminho) => {
    const app = express();
    app.use('/api', build());

    const res = await request(app)[metodo](caminho);

    expect(res.body.m).toBeUndefined();
  });
});
