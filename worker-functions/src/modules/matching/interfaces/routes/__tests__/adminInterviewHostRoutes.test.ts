/**
 * Lista dourada das rotas da tela Entrevistadores (spec 055): 4 rotas, 2 células, família `admin.users`. Varre o router de verdade
 * (o `scanExpressRouter` do catálogo) e afirma que TODA rota declara, e declara a célula do MAPA — não a que o código escolheu.
 */
import express from 'express';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminInterviewHostRoutes } from '../adminInterviewHostRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

const ESPERADO: Record<string, string> = {
  'GET /interview-hosts': 'interview_host:read',
  'GET /interview-hosts/candidates': 'interview_host:update',
  'POST /interview-hosts': 'interview_host:update',
  'PATCH /interview-hosts/:id': 'interview_host:update',
};

const responde = (nome: string) => (_req: express.Request, res: express.Response) => res.json({ m: nome });
const controllerDuble = Object.fromEntries(['list', 'candidates', 'create', 'patch'].map((m) => [m, responde(m)]));

const build = (): express.Router => createAdminInterviewHostRoutes(authDouble(), permissionsDouble(), controllerDuble as never);

describe('rotas da tela Entrevistadores', () => {
  it('cada rota declara a célula do mapa (ver é read; mexer e buscar candidato é update)', () => {
    const got = Object.fromEntries(
      scanExpressRouter(build()).map((r) => [`${r.method} ${r.path}`, r.cell ? cellKey(r.cell.resource, r.cell.action) : null]),
    );
    expect(got).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('/candidates (estática) vem antes de /:id', () => {
    const paths = scanExpressRouter(build()).map((r) => r.path);
    expect(paths.indexOf('/interview-hosts/candidates')).toBeGreaterThan(-1);
    expect(paths.indexOf('/interview-hosts/candidates')).toBeLessThan(paths.indexOf('/interview-hosts/:id'));
  });
});
