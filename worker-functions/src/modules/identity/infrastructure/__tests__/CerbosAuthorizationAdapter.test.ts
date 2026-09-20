/**
 * O adapter do Cerbos mandava só `roles` no principal — então QUALQUER policy
 * escrita sobre permissão negava, e o painel ficaria mudo se alguém ligasse
 * `USE_CERBOS=true`. É o buraco que o ADR-006 apontou e que a change
 * `painel-grupos-permissao` fecha. O que se prova aqui é o PAYLOAD.
 */

import { CerbosAuthorizationAdapter } from '../CerbosAuthorizationAdapter';
import { PrincipalType, type AuthContext } from '../../domain/Auth';

const ENDPOINT = 'http://cerbos.local';

function contexto(over: Partial<AuthContext['principal']> = {}): AuthContext {
  return {
    principal: { id: 'u1', type: PrincipalType.USER, roles: ['recruiter'], ...over },
    metadata: { requestId: 'req-1' },
  } as AuthContext;
}

function respondeCom(body: unknown, ok = true): jest.Mock {
  const fetchMock = jest.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function payloadDe(fetchMock: jest.Mock): Record<string, never> {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe('CerbosAuthorizationAdapter — atributos do principal', () => {
  const adapter = new CerbosAuthorizationAdapter({ cerbosEndpoint: ENDPOINT });

  afterEach(() => jest.restoreAllMocks());

  it('envia permissions e countries resolvidos do grupo', async () => {
    const fetchMock = respondeCom({ results: { read: 'EFFECT_ALLOW' } });

    await adapter.checkPermission(
      contexto({ permissions: ['worker:read', 'patient:read'], countries: ['AR', 'BR'], country: 'AR' }),
      { type: 'worker', id: 'w1' },
      'read',
    );

    expect(payloadDe(fetchMock)).toMatchObject({
      principal: {
        id: 'u1',
        roles: ['recruiter'],
        attr: { permissions: ['worker:read', 'patient:read'], countries: ['AR', 'BR'], country: 'AR' },
      },
    });
  });

  it('sem resolução (engine desligado) envia listas VAZIAS — o estado real, não um default', async () => {
    const fetchMock = respondeCom({ results: { read: 'EFFECT_DENY' } });

    const decision = await adapter.checkPermission(contexto(), { type: 'worker' }, 'read');

    expect(payloadDe(fetchMock)).toMatchObject({
      principal: { attr: { permissions: [], countries: [] } },
    });
    expect(decision.allowed).toBe(false);
  });

  it('o PLAN manda o mesmo principal do CHECK — antes divergia e a policy decidia diferente', async () => {
    const fetchMock = respondeCom({ resourceIds: ['w1'] });

    await adapter.listAccessibleResources(contexto({ permissions: ['worker:read'] }), 'worker', 'read');

    expect(payloadDe(fetchMock)).toMatchObject({
      principal: { attr: { permissions: ['worker:read'], countries: [] } },
    });
  });
});

describe('CerbosAuthorizationAdapter — decisões e indisponibilidade', () => {
  const adapter = new CerbosAuthorizationAdapter({ cerbosEndpoint: ENDPOINT, playgroundEnabled: true });

  afterEach(() => jest.restoreAllMocks());

  it('EFFECT_ALLOW permite e devolve as policies e o auditId do Cerbos', async () => {
    respondeCom({ results: { read: 'EFFECT_ALLOW' }, metadata: { policies: ['worker.yaml'], auditId: 'a1' } });

    const decision = await adapter.checkPermission(contexto(), { type: 'worker' }, 'read');

    expect(decision).toEqual({
      allowed: true,
      reason: 'Cerbos allowed',
      policies: ['worker.yaml'],
      auditLogId: 'a1',
    });
  });

  it('sem metadata, gera id de correlação próprio', async () => {
    respondeCom({ results: { read: 'EFFECT_ALLOW' } });
    const decision = await adapter.checkPermission(contexto(), { type: 'worker' }, 'read');
    expect(decision.auditLogId).toMatch(/^audit_/);
  });

  it('Cerbos fora do ar NEGA (fail-closed)', async () => {
    respondeCom({}, false);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    const decision = await adapter.checkPermission(contexto(), { type: 'worker' }, 'read');

    expect(decision).toMatchObject({ allowed: false, reason: 'Authorization service unavailable' });
  });

  it('checkPermissions decide um a um', async () => {
    respondeCom({ results: { read: 'EFFECT_ALLOW', delete: 'EFFECT_ALLOW' } });

    const decisions = await adapter.checkPermissions(contexto(), [
      { resource: { type: 'worker' }, action: 'read' },
      { resource: { type: 'worker' }, action: 'nope' },
    ]);

    expect(decisions.map((d) => d.allowed)).toEqual([true, false]);
  });

  it('plan indisponível devolve lista vazia e decisão negativa', async () => {
    respondeCom({}, false);
    const result = await adapter.listAccessibleResources(contexto(), 'worker', 'read');
    expect(result).toMatchObject({ resourceIds: [], decision: { allowed: false } });
  });

  it('plan sem resourceIds devolve lista vazia com decisão positiva', async () => {
    respondeCom({});
    const result = await adapter.listAccessibleResources(contexto(), 'worker', 'read');
    expect(result).toMatchObject({ resourceIds: [], decision: { allowed: true } });
  });

  it('playground só existe quando habilitado', async () => {
    expect(adapter.getPlaygroundUrl()).toBe(`${ENDPOINT}/playground`);
    expect(new CerbosAuthorizationAdapter({ cerbosEndpoint: ENDPOINT }).getPlaygroundUrl()).toBeNull();
  });

  it('reloadPolicies devolve o resultado do servidor, e false quando ele não responde', async () => {
    respondeCom({});
    await expect(adapter.reloadPolicies()).resolves.toBe(true);

    global.fetch = jest.fn().mockRejectedValue(new Error('fora')) as unknown as typeof fetch;
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(adapter.reloadPolicies()).resolves.toBe(false);
  });
});
