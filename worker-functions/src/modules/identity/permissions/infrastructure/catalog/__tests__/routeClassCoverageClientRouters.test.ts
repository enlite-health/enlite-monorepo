/**
 * acesso-do-cliente F3 (T305/T307): toda rota não-staff dos routers de
 * prestador/público declara classe. Routers REAIS, controllers e guards dublê.
 * `index.ts` não é importável em unit (fatos F4): suas rotas ficam para o e2e.
 */

import express, { type RequestHandler } from 'express';
import { scanExpressRouter, type ScannedRoute } from '../scanExpressRouter';
import { markRouteClass } from '../routeClass';
import { createAccountLinkRoutes } from '../../../../../account-link/accountLinkRoutes';
import { createWorkerDocumentsRoutes } from '../../../../../worker/interfaces/routes/workerDocumentsRoutes';
import { createWorkerApplicationsRoutes } from '../../../../../matching/interfaces/routes/workerApplicationsRoutes';
import { createConsentRoutes } from '../../../../../mcp/interfaces/oauth/consentRoutes';
import { createClaimRoutes } from '../../../../../auth/interfaces/routes/claimRoutes';

const pass: RequestHandler = (_req, _res, next) => next();
// Dublê do AuthMiddleware: `requireStaff` marca `staff`, como o real.
const auth = {
  requireAuth: () => pass,
  requirePermission: () => pass,
  requireStaff: () => markRouteClass(((_q, _s, n) => n()) as RequestHandler, 'staff'),
} as never;
const permissions = { family: () => ({ require: () => pass }) } as never;
const stub = {} as never;

function scan(router: express.Router): ScannedRoute[] {
  const app = express();
  app.use('/api', router);
  return scanExpressRouter(app);
}

const casos: Array<[string, () => express.Router, number]> = [
  ['accountLinkRoutes', () => createAccountLinkRoutes(stub, auth), 6],
  ['workerDocumentsRoutes', () => createWorkerDocumentsRoutes(stub, stub, stub, auth, permissions), 9],
  ['workerApplicationsRoutes', () => createWorkerApplicationsRoutes(stub, auth), 1],
  ['consentRoutes', () => createConsentRoutes({ tokens: stub, auditor: stub, staff: stub } as never), 1],
  ['claimRoutes', () => createClaimRoutes(stub, auth), 2],
];

describe('routeClass — cobertura dos routers de prestador/público (T305/T307)', () => {
  it.each(casos)('%s: toda rota não-staff tem class ≠ null', (_nome, build, esperadas) => {
    const naoStaff = scan(build()).filter((r) => r.class !== 'staff');
    expect(naoStaff).toHaveLength(esperadas); // 0 = não medi, não sucesso
    expect(naoStaff.filter((r) => r.class == null).map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });
});
