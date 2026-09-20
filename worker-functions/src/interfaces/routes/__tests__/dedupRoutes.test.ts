/**
 * Família `admin.dedup` (task 3.5-A5), a ÚLTIMA de propósito: `dedup:execute`
 * funde cadastros de PESSOAS. 9 rotas, 2 células, ambas no seed da 206.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createDedupRoutes, ADMIN_DEDUP_FAMILY } from '../dedupRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** Mapa esperado — copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'GET /groups': 'dedup:read',
  'GET /groups/:phoneNormalized': 'dedup:read',
  'POST /merge': 'dedup:execute',
  'POST /dismiss': 'dedup:execute',
  'POST /merges/:auditId/undo': 'dedup:execute',
  'GET /history': 'dedup:read',
  'GET /imported-groups': 'dedup:read',
  'GET /candidates': 'dedup:read',
  'POST /manual-group': 'dedup:execute',
};

const responde = (nome: string) => (req: express.Request, res: express.Response) =>
  res.json({ m: nome, id: req.params.phoneNormalized ?? req.params.auditId });

function build(): express.Router {
  const controller = Object.fromEntries(
    ['listGroups', 'getGroupDetail', 'executeMerge', 'dismissGroup', 'undoMerge',
     'listHistory', 'listImportedGroups', 'searchCandidates', 'buildManualGroup']
      .map((m) => [m, responde(m)]),
  );
  return createDedupRoutes(controller as never, authDouble(), permissionsDouble());
}

function declaradas(): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(build()).map((r) => [
      `${r.method} ${r.path}`,
      r.cell ? cellKey(r.cell.resource, r.cell.action) : null,
    ]),
  );
}

describe('família admin.dedup — 9 rotas, 2 células', () => {
  it('a família é `admin.dedup` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_DEDUP_FAMILY).toBe('admin.dedup');
  });

  it('cada rota declara a célula do mapa (route-permission-map.md)', () => {
    expect(declaradas()).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('a família soma exatamente 9 rotas — a conta que saiu do PENDING_DECLARATIONS', () => {
    expect(scanExpressRouter(build())).toHaveLength(9);
  });

  it('TODA rota que muda cadastro é dedup:execute — nenhuma escapa como read', () => {
    // `merge` reparenta telefone, e-mail e histórico de uma pessoa para outra;
    // `dismiss` e `manual-group` mudam o que o Centro vai propor; `undo`
    // desfaz. Nenhuma delas pode cair em `dedup:read` por descuido.
    for (const rota of ['POST /merge', 'POST /dismiss', 'POST /merges/:auditId/undo', 'POST /manual-group']) {
      expect(declaradas()[rota]).toBe('dedup:execute');
    }
  });

  it('e toda LEITURA é dedup:read', () => {
    for (const rota of ['GET /groups', 'GET /groups/:phoneNormalized', 'GET /history',
                        'GET /imported-groups', 'GET /candidates']) {
      expect(declaradas()[rota]).toBe('dedup:read');
    }
  });

  it('a divisão é exatamente 5 leituras × 4 execuções', () => {
    const valores = Object.values(declaradas());
    expect(valores.filter((c) => c === 'dedup:read')).toHaveLength(5);
    expect(valores.filter((c) => c === 'dedup:execute')).toHaveLength(4);
  });

  describe('ordem das rotas — o que o tsc não pega', () => {
    it('`/groups/:phoneNormalized` não engole `/groups`', async () => {
      const app = express();
      app.use('/api/admin/dedup', build());

      expect((await request(app).get('/api/admin/dedup/groups').expect(200)).body.m).toBe('listGroups');
      expect((await request(app).get('/api/admin/dedup/groups/5491122').expect(200)).body).toMatchObject({
        m: 'getGroupDetail',
        id: '5491122',
      });
    });
  });

  it.each([
    ['get', '/api/admin/dedup/groups', 'listGroups'],
    ['get', '/api/admin/dedup/groups/549', 'getGroupDetail'],
    ['post', '/api/admin/dedup/merge', 'executeMerge'],
    ['post', '/api/admin/dedup/dismiss', 'dismissGroup'],
    ['post', '/api/admin/dedup/merges/a1/undo', 'undoMerge'],
    ['get', '/api/admin/dedup/history', 'listHistory'],
    ['get', '/api/admin/dedup/imported-groups', 'listImportedGroups'],
    ['get', '/api/admin/dedup/candidates', 'searchCandidates'],
    ['post', '/api/admin/dedup/manual-group', 'buildManualGroup'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = express();
    app.use('/api/admin/dedup', build());

    const res = await request(app)[metodo](caminho).expect(200);

    expect(res.body.m).toBe(esperado);
  });
});
