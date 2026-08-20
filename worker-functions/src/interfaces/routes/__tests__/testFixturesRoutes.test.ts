/**
 * Família `admin.test_fixtures` (task 3.5-A4): uma rota, uma célula NOVA
 * (`test_fixtures:execute`, fora do seed da 206). A rota APAGA dado `is_test`.
 */

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createTestFixturesRoutes, ADMIN_TEST_FIXTURES_FAMILY } from '../testFixturesRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

function build(): express.Router {
  const controller = {
    cleanup: (_req: express.Request, res: express.Response) => res.json({ m: 'cleanup' }),
  };
  return createTestFixturesRoutes(controller as never, authDouble(), permissionsDouble());
}

describe('família admin.test_fixtures', () => {
  it('a família é `admin.test_fixtures`', () => {
    expect(ADMIN_TEST_FIXTURES_FAMILY).toBe('admin.test_fixtures');
  });

  it('a rota declara test_fixtures:execute — célula NOVA da D116', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas).toHaveLength(1);
    expect(cellKey(rotas[0].cell!.resource, rotas[0].cell!.action)).toBe('test_fixtures:execute');
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('a rota chega no handler de cleanup', async () => {
    const app = express();
    app.use('/api/admin/test-fixtures', build());

    const res = await request(app).post('/api/admin/test-fixtures/cleanup').expect(200);

    expect(res.body.m).toBe('cleanup');
  });
});
