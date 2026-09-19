/**
 * Família `admin.integrations` (task 3.5-A4): mesma célula NOVA (`integration:execute`, fora do
 * seed da 206) reaproveitada pelas 3 rotas do router — backfill AnaCare (F0) + lançamento unitário
 * e em lote do Axonico (F4, `integracao-axonico`). Uma célula, N rotas — não uma célula por rota.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminIntegrationsRoutes, ADMIN_INTEGRATIONS_FAMILY } from '../adminIntegrationsRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

jest.mock('../../controllers/AnaCareBackfillController', () => ({
  AnaCareBackfillController: jest.fn().mockImplementation(() => ({
    handle: (_req: express.Request, res: express.Response) => res.json({ m: 'handle' }),
  })),
}));

function build(): express.Router {
  return createAdminIntegrationsRoutes(authDouble(), permissionsDouble());
}

describe('família admin.integrations', () => {
  it('a família é `admin.integrations`', () => {
    expect(ADMIN_INTEGRATIONS_FAMILY).toBe('admin.integrations');
  });

  it('as 3 rotas declaram integration:execute — célula NOVA da D116', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas).toHaveLength(3);
    for (const rota of rotas) {
      expect(rota.cell).toMatchObject({ resource: 'integration', action: 'execute' });
    }
  });

  it('`execute`, não `write`: backfill/lançamento DISPARAM ação contra terceiro', () => {
    // A distinção não é estilo — `execute` está em SENSITIVE_ACTIONS (D-P4),
    // então o ALLOW também vai para a trilha. Com `write` não iria.
    const rotas = scanExpressRouter(build());
    for (const rota of rotas) {
      expect(cellKey(rota.cell!.resource, rota.cell!.action)).toBe('integration:execute');
    }
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('a rota chega no handler do backfill', async () => {
    const app = express();
    app.use('/api/admin', build());

    const res = await request(app).post('/api/admin/integrations/anacare/backfill').expect(200);

    expect(res.body.m).toBe('handle');
  });
});
