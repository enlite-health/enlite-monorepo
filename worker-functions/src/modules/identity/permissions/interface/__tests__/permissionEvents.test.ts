import express from 'express';
import request from 'supertest';
import { poolMockWithConnect } from '@shared/database/poolMockSupport';
import {
  COUNTRY_FEATURE_CHANGED_EVENT,
  DomainEventPermissionPublisher,
  PERMISSION_CHANGED_EVENT,
} from '../../infrastructure/DomainEventPermissionPublisher';
import { registerPermissionEventHandlers } from '../registerPermissionEventHandlers';
import { createWellKnownPermissionsRouter } from '../wellKnownPermissionsRoute';
import type { PermissionService } from '../../application/PermissionService';
import type { ListPermissionCatalogUseCase } from '../../application/ListPermissionCatalogUseCase';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => ({ traceId: 'trace-1' }) },
}));

describe('DomainEventPermissionPublisher', () => {
  it('enfileira no outbox com os uids e o trace da request', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'evt-1' }] });
    await new DomainEventPermissionPublisher(poolMockWithConnect(query) as never).permissionChanged(['ana', 'bob']);
    expect(String(query.mock.calls[0][0])).toContain('INSERT INTO domain_events');
    expect(query.mock.calls[0][1]).toEqual([PERMISSION_CHANGED_EVENT, JSON.stringify({ uids: ['ana', 'bob'] }), 'trace-1']);
  });

  it('lista vazia não gera evento (nada mudou para ninguém)', async () => {
    const query = jest.fn();
    await new DomainEventPermissionPublisher(poolMockWithConnect(query) as never).permissionChanged([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('falha ao publicar NÃO desfaz a operação já commitada — só loga', async () => {
    const query = jest.fn().mockRejectedValue(new Error('outbox fora'));
    const publisher = new DomainEventPermissionPublisher(poolMockWithConnect(query) as never);
    await expect(publisher.permissionChanged(['ana'])).resolves.toBeUndefined();
    await expect(publisher.countryFeatureChanged('BR', 'screen:x')).resolves.toBeUndefined();
  });

  it('fora de uma request (sem trace no ALS) o evento sai com trace null', async () => {
    const als = jest.requireMock('@shared/logging') as { loggingAls: { getStore: () => unknown } };
    const original = als.loggingAls.getStore;
    als.loggingAls.getStore = () => undefined;
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'evt-3' }] });
    await new DomainEventPermissionPublisher(poolMockWithConnect(query) as never).permissionChanged(['ana']);
    expect(query.mock.calls[0][1][2]).toBeNull();
    als.loggingAls.getStore = original;
  });

  it('evento de feature carrega país e chave', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 'evt-2' }] });
    await new DomainEventPermissionPublisher(poolMockWithConnect(query) as never).countryFeatureChanged('BR', 'screen:x');
    expect(query.mock.calls[0][1][0]).toBe(COUNTRY_FEATURE_CHANGED_EVENT);
    expect(query.mock.calls[0][1][1]).toBe(JSON.stringify({ country: 'BR', featureKey: 'screen:x' }));
  });
});

describe('registerPermissionEventHandlers', () => {
  function setup() {
    const handlers = new Map<string, (payload: Record<string, unknown>) => Promise<void>>();
    const service = { invalidate: jest.fn(), invalidateFeatures: jest.fn() } as unknown as PermissionService;
    registerPermissionEventHandlers({ registerHandler: (event, handler) => handlers.set(event, handler) }, service);
    return { handlers, service };
  }

  it('registra os DOIS eventos — evento sem handler vira `failed` e acende alerta (D82)', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual([COUNTRY_FEATURE_CHANGED_EVENT, PERMISSION_CHANGED_EVENT]);
  });

  it('invalida só os uids do payload', async () => {
    const { handlers, service } = setup();
    await handlers.get(PERMISSION_CHANGED_EVENT)!({ uids: ['ana', 'bob'] });
    expect(service.invalidate).toHaveBeenCalledWith(['ana', 'bob']);
  });

  it('payload sem uid legível limpa TUDO (cache errado é pior que cache frio)', async () => {
    const { handlers, service } = setup();
    await handlers.get(PERMISSION_CHANGED_EVENT)!({});
    await handlers.get(PERMISSION_CHANGED_EVENT)!({ uids: [42, null] });
    expect(service.invalidate).toHaveBeenNthCalledWith(1, undefined);
    expect(service.invalidate).toHaveBeenNthCalledWith(2, undefined);
  });

  it('payload de feature com país inválido não vira país no log — só limpa o cache', async () => {
    const { handlers, service } = setup();
    await handlers.get(COUNTRY_FEATURE_CHANGED_EVENT)!({ country: 'XX' });
    expect(service.invalidateFeatures).toHaveBeenCalledTimes(1);
  });

  it('evento de feature limpa só a disponibilidade', async () => {
    const { handlers, service } = setup();
    await handlers.get(COUNTRY_FEATURE_CHANGED_EVENT)!({ country: 'BR', featureKey: 'screen:x' });
    expect(service.invalidateFeatures).toHaveBeenCalledTimes(1);
    expect(service.invalidate).not.toHaveBeenCalled();
  });
});

describe('GET /.well-known/permissions (lex C14 — autenticado)', () => {
  const catalog = {
    execute: jest.fn().mockResolvedValue([
      {
        category: 'Trabalhadores',
        cells: [
          { resource: 'worker', action: 'read', category: 'Trabalhadores', ownerService: 'worker-functions', deprecatedAt: null },
          { resource: 'upload', action: 'read', category: 'Importação', ownerService: 'worker-functions', deprecatedAt: new Date() },
        ],
      },
    ]),
  } as unknown as ListPermissionCatalogUseCase;

  function appWith(guardAllows: boolean) {
    const app = express();
    app.use(
      '/.well-known',
      createWellKnownPermissionsRouter(
        catalog,
        (_req, res, next) => (guardAllows ? next() : res.status(403).json({ error: 'Forbidden' })),
        { ownerService: 'worker-functions' },
      ),
    );
    return app;
  }

  it('sem credencial não passa — a lista conta a topologia do sistema', async () => {
    await request(appWith(false)).get('/.well-known/permissions').expect(403);
  });

  it('com credencial devolve o catálogo, marcando o descontinuado', async () => {
    const response = await request(appWith(true)).get('/.well-known/permissions').expect(200);
    expect(response.body.service).toBe('worker-functions');
    expect(response.body.permissions).toEqual([
      { key: 'worker:read', resource: 'worker', action: 'read', category: 'Trabalhadores', ownerService: 'worker-functions', deprecated: false },
      { key: 'upload:read', resource: 'upload', action: 'read', category: 'Trabalhadores', ownerService: 'worker-functions', deprecated: true },
    ]);
  });
});
