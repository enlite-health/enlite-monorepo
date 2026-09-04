import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useCellAccess, useHasCell } from '../useCellAccess';
import type { AuthzContract } from '@domain/entities/Authz';

const contrato = (permissions: string[]): AuthzContract => ({
  uid: 'u1',
  tenantId: 't1',
  status: 'ACTIVE',
  permissions,
  countries: ['AR'],
  groups: [],
  features: {},
});

describe('useCellAccess', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('contrato ainda não carregado → hidden (fail-closed), com o status exposto', () => {
    const { result } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current).toEqual({ level: 'hidden', canRead: false, canWrite: false, status: 'idle' });
  });

  it('🔴 contrato em ERRO → hidden mesmo que um contrato antigo tenha sobrado', () => {
    useAdminAuthStore.setState({ authz: contrato(['permission_management:write']), authzStatus: 'error' });
    const { result } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current.level).toBe('hidden');
  });

  it('só read → read, sem write', () => {
    useAdminAuthStore.setState({ authz: contrato(['permission_management:read']), authzStatus: 'ready' });
    const { result } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current).toMatchObject({ level: 'read', canRead: true, canWrite: false });
  });

  it('write → completo', () => {
    useAdminAuthStore.setState({ authz: contrato(['permission_management:write']), authzStatus: 'ready' });
    const { result } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current).toMatchObject({ level: 'write', canRead: true, canWrite: true });
  });

  it('a mudança do contrato re-renderiza — revogação vale na hora', () => {
    useAdminAuthStore.setState({ authz: contrato(['permission_management:write']), authzStatus: 'ready' });
    const { result, rerender } = renderHook(() => useCellAccess('permission_management'));
    expect(result.current.level).toBe('write');
    useAdminAuthStore.setState({ authz: contrato([]) });
    rerender();
    expect(result.current.level).toBe('hidden');
  });
});

describe('useHasCell', () => {
  it('só responde com contrato pronto', () => {
    useAdminAuthStore.setState({ authz: contrato(['worker:export']), authzStatus: 'loading' });
    expect(renderHook(() => useHasCell('worker', 'export')).result.current).toBe(false);
    useAdminAuthStore.setState({ authzStatus: 'ready' });
    expect(renderHook(() => useHasCell('worker', 'export')).result.current).toBe(true);
  });
});

describe('contrato `ready` com authz nulo — estado impossível, mas o hook não pode explodir', () => {
  it('trata como hidden', () => {
    useAdminAuthStore.setState({ authz: null, authzStatus: 'ready' });
    expect(renderHook(() => useCellAccess('x')).result.current.level).toBe('hidden');
    expect(renderHook(() => useHasCell('x', 'read')).result.current).toBe(false);
  });
});
