/**
 * O motor real. O caso que mais importa aqui não é o feliz: é o do PRESTADOR.
 * `/api/workers/me/*` chama `requirePermission('worker','update')` desde antes
 * desta change; se o motor novo decidisse por célula de staff para todo mundo,
 * o app do candidato inteiro cairia em 403 no dia da virada.
 */

import { GroupPermissionEngine, isStaffPrincipal } from '../GroupPermissionEngine';
import { PrincipalType, type AuthContext } from '../../domain/Auth';
import type { PermissionClient, ResolvedAuthz } from '@modules/identity/permissions';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

function contexto(roles: string[], id = 'u1'): AuthContext {
  return { principal: { id, type: PrincipalType.USER, roles } } as AuthContext;
}

function authz(over: Partial<ResolvedAuthz> = {}): ResolvedAuthz {
  return {
    uid: 'u1',
    tenantId: 'tenant',
    status: 'ACTIVE',
    permissions: ['worker:read'],
    countries: ['AR'],
    groups: [{ id: 'g1', name: 'Recrutador' }],
    canSimulate: false,
    simulation: null,
    ...over,
  };
}

function clientStub(resolved: ResolvedAuthz | Error = authz()): PermissionClient {
  return {
    resolve: resolved instanceof Error ? jest.fn().mockRejectedValue(resolved) : jest.fn().mockResolvedValue(resolved),
    can: jest.fn(),
    isFeatureAvailable: jest.fn(),
    featureConfig: jest.fn(),
    invalidate: jest.fn(),
  };
}

const permissivo = {
  checkPermission: jest.fn().mockResolvedValue({ allowed: true, reason: 'autenticado', auditLogId: 'x' }),
  checkPermissions: jest.fn(),
  listAccessibleResources: jest.fn(),
};

describe('GroupPermissionEngine', () => {
  afterEach(() => jest.clearAllMocks());

  it('NÃO-staff cai no motor anterior — o app do prestador segue funcionando', async () => {
    const client = clientStub();
    const engine = new GroupPermissionEngine(client, permissivo);

    const decision = await engine.checkPermission(contexto(['worker']), { type: 'worker' }, 'update');

    expect(decision.allowed).toBe(true);
    expect(client.resolve).not.toHaveBeenCalled();
    expect(permissivo.checkPermission).toHaveBeenCalled();
  });

  it('célula NÃO declarada por rota nenhuma cai no motor anterior — mesmo para staff', async () => {
    // O caso real: `/api/users/:userId` chama requirePermission('user','admin_delete')
    // desde antes desta change, e `user:admin_delete` nem existe no catálogo —
    // grupo nenhum poderia concedê-la. Sem este desvio, ligar a flag global
    // trancaria a rota para sempre (spec: "rota ainda não virada se comporta
    // como hoje").
    const client = clientStub();
    const engine = new GroupPermissionEngine(client, permissivo, {
      governsCell: (resource, action) => `${resource}:${action}` === 'user_management:read',
    });

    const decision = await engine.checkPermission(contexto(['admin']), { type: 'user' }, 'admin_delete');

    expect(decision.allowed).toBe(true);
    expect(client.resolve).not.toHaveBeenCalled();
  });

  it('célula DECLARADA por rota é decidida pelo novo modelo', async () => {
    const engine = new GroupPermissionEngine(clientStub(authz({ permissions: [] })), permissivo, {
      governsCell: (resource, action) => `${resource}:${action}` === 'user_management:read',
    });

    const decision = await engine.checkPermission(contexto(['admin']), { type: 'user_management' }, 'read');

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('user_management:read');
  });

  it('staff com a célula → permitido', async () => {
    const engine = new GroupPermissionEngine(clientStub(), permissivo);
    const decision = await engine.checkPermission(contexto(['recruiter']), { type: 'worker' }, 'read');
    expect(decision).toMatchObject({ allowed: true, policies: ['group_permissions'] });
  });

  it('staff sem a célula → negado, dizendo qual falta', async () => {
    const engine = new GroupPermissionEngine(clientStub(authz({ permissions: [] })), permissivo);
    const decision = await engine.checkPermission(contexto(['admin']), { type: 'worker' }, 'delete');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('worker:delete');
  });

  it('conta não-ACTIVE é negada antes de olhar células', async () => {
    const engine = new GroupPermissionEngine(clientStub(authz({ status: 'SUSPENDED' })), permissivo);
    const decision = await engine.checkPermission(contexto(['admin']), { type: 'worker' }, 'read');
    expect(decision).toMatchObject({ allowed: false, reason: 'Conta com status SUSPENDED' });
  });

  it('status nulo também nega (nunca "sem status logo pode")', async () => {
    const engine = new GroupPermissionEngine(clientStub(authz({ status: null })), permissivo);
    const decision = await engine.checkPermission(contexto(['admin']), { type: 'worker' }, 'read');
    expect(decision.reason).toContain('desconhecido');
  });

  it('falha ao resolver NEGA', async () => {
    const engine = new GroupPermissionEngine(clientStub(new Error('banco fora')), permissivo);
    const decision = await engine.checkPermission(contexto(['admin']), { type: 'worker' }, 'read');
    expect(decision).toMatchObject({ allowed: false, reason: 'Falha ao resolver permissões' });
  });

  it('principal de staff sem id → negado', async () => {
    const engine = new GroupPermissionEngine(clientStub(), permissivo);
    const decision = await engine.checkPermission(contexto(['admin'], ''), { type: 'worker' }, 'read');
    expect(decision).toMatchObject({ allowed: false, reason: 'Principal sem identidade' });
  });

  it('checkPermissions decide cada item', async () => {
    const engine = new GroupPermissionEngine(clientStub(), permissivo);
    const decisions = await engine.checkPermissions(contexto(['admin']), [
      { resource: { type: 'worker' }, action: 'read' },
      { resource: { type: 'worker' }, action: 'delete' },
    ]);
    expect(decisions.map((d) => d.allowed)).toEqual([true, false]);
  });

  it('listAccessibleResources devolve a decisão e lista vazia (como o motor anterior)', async () => {
    const engine = new GroupPermissionEngine(clientStub(), permissivo);
    const result = await engine.listAccessibleResources(contexto(['admin']), 'worker', 'read');
    expect(result).toEqual({ resourceIds: [], decision: expect.objectContaining({ allowed: true }) });
  });
});

describe('isStaffPrincipal', () => {
  it.each([
    [['admin'], true],
    [['recruiter'], true],
    [['community_manager'], true],
    [['worker'], false],
    [[], false],
  ])('%s → %s', (roles, esperado) => {
    expect(isStaffPrincipal(contexto(roles as string[]))).toBe(esperado);
  });

  it('principal sem roles não é staff', () => {
    expect(isStaffPrincipal({ principal: { id: 'x', type: PrincipalType.USER } } as AuthContext)).toBe(false);
  });
});
