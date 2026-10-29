/**
 * Lista dourada da rota da lista GLOBAL de enquadres (spec 076): 1 rota, DUAS células encadeadas, na ordem dos guards.
 * Mesmo molde de `adminEnquadreEventRoutes.test.ts`: varre o router de verdade (o `scanExpressRouter` do catálogo) e afirma
 * as células do MAPA escrito à mão — não as que o código escolheu.
 */
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminEnquadreEventListRoutes } from '../adminEnquadreEventListRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

const controllerDuble = { listAll: (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ m: 'listAll' }) };

function build() {
  return createAdminEnquadreEventListRoutes(authDouble(), permissionsDouble(), controllerDuble as never);
}

describe('rota da lista global de enquadres — 1 rota, 2 células', () => {
  it('é GET /enquadre-events, e só ela', () => {
    expect(scanExpressRouter(build()).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /enquadre-events']);
  });

  it('declara enquadre_event:read e vacancy:read, nessa ordem (as duas, não uma)', () => {
    const [rota] = scanExpressRouter(build());
    expect((rota.cells ?? []).map((c) => cellKey(c.resource, c.action))).toEqual(['enquadre_event:read', 'vacancy:read']);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });
});
