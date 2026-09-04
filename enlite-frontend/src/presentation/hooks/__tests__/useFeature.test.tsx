import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useFeature } from '../useFeature';
import type { AuthzContract } from '@domain/entities/Authz';

const prontoFeatures = (countries: string[], features: AuthzContract['features']) =>
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries, groups: [], features } as AuthzContract,
  });

describe('useFeature — retorno booleano direto (fora do FeatureGate)', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('authz null → true (fail-open)', () => {
    const { result } = renderHook(() => useFeature('screen:hook-null'));
    expect(result.current).toBe(true);
  });

  it('mapa presente, chave true → true', () => {
    prontoFeatures(['AR'], { AR: { 'screen:hook-on': { enabled: true, config: null } } });
    const { result } = renderHook(() => useFeature('screen:hook-on'));
    expect(result.current).toBe(true);
  });

  it('mapa presente, chave false → false', () => {
    prontoFeatures(['AR'], { AR: { 'screen:hook-off': { enabled: false, config: null } } });
    const { result } = renderHook(() => useFeature('screen:hook-off'));
    expect(result.current).toBe(false);
  });

  it('dedup: a mesma (motivo, chave) só avisa UMA vez, mesmo com 2 componentes montados', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prontoFeatures(['AR'], {});
    renderHook(() => useFeature('screen:hook-dedup'));
    renderHook(() => useFeature('screen:hook-dedup'));
    const chamadasParaEstaChave = warn.mock.calls.filter((c) => String(c[0]).includes('screen:hook-dedup'));
    expect(chamadasParaEstaChave).toHaveLength(1);
    warn.mockRestore();
  });
});
