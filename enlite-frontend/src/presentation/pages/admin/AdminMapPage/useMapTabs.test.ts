import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMapTabs } from './useMapTabs';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

const comEnforcement = (permissions: string[], enforcement: 'on' | 'off') => {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
};
afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

describe('useMapTabs — as abas do mapa por célula de endereço (D286 fase 2)', () => {
  it('só patient_address:read: a única aba é Pacientes e ela é a ativa, mesmo com Prestadores pedida', () => {
    comEnforcement(['patient_address:read'], 'on');
    const { result } = renderHook(() => useMapTabs());
    expect(result.current.visibleTabs).toEqual(['patients']);
    expect(result.current.kind).toBe('patients');
    act(() => result.current.setKind('workers'));
    expect(result.current.kind).toBe('patients');
  });

  it('as duas células: a pedida vale', () => {
    comEnforcement(['worker_address:read', 'patient_address:read'], 'on');
    const { result } = renderHook(() => useMapTabs());
    expect(result.current.visibleTabs).toEqual(['workers', 'patients']);
    act(() => result.current.setKind('patients'));
    expect(result.current.kind).toBe('patients');
  });

  it('NENHUMA célula de endereço: nenhuma aba, e `kind` fica no pedido (nada desenha, nada busca)', () => {
    comEnforcement(['worker:read'], 'on');
    const { result } = renderHook(() => useMapTabs());
    expect(result.current.visibleTabs).toEqual([]);
    expect(result.current.kind).toBe('workers');
  });

  it('enforcement off: as duas', () => {
    comEnforcement([], 'off');
    const { result } = renderHook(() => useMapTabs());
    expect(result.current.visibleTabs).toEqual(['workers', 'patients']);
  });
});
