import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useFeature } from '../useFeature';
import type { AuthzContract } from '@domain/entities/Authz';

// Default `enforcement: 'on'` — estes testes exercitam a régua de MAPA
// (M1/D268); o freio de rollout em si tem describe própria, abaixo.
const prontoFeatures = (
  countries: string[],
  features: AuthzContract['features'],
  enforcement: AuthzContract['enforcement'] = 'on',
) =>
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries, groups: [], features, enforcement } as AuthzContract,
  });

describe('useFeature — retorno booleano direto (fora do FeatureGate)', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('authz null → true (fail-open)', () => {
    const { result } = renderHook(() => useFeature('screen:hook-null'));
    expect(result.current).toBe(true);
  });

  it('mapa presente, chave true, enforcement on → true', () => {
    prontoFeatures(['AR'], { AR: { 'screen:hook-on': { enabled: true, config: null } } });
    const { result } = renderHook(() => useFeature('screen:hook-on'));
    expect(result.current).toBe(true);
  });

  it('mapa presente, chave false, enforcement on → false', () => {
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

describe('useFeature — M1 (D268): enforcement é o único interruptor de rollout', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('enforcement off + chave enabled:false → renderiza mesmo assim (freio de rollout vence o mapa)', () => {
    prontoFeatures(['AR'], { AR: { 'screen:hook-off-enforcement': { enabled: false, config: null } } }, 'off');
    const { result } = renderHook(() => useFeature('screen:hook-off-enforcement'));
    expect(result.current).toBe(true);
  });

  it('enforcement ausente (contrato de transição — o campo nem existe, não é só undefined) + chave enabled:false → renderiza', () => {
    // Direto no store (não via `prontoFeatures`): passar `undefined` pro 3º
    // parâmetro dispararia o DEFAULT ('on') — precisa do campo `enforcement`
    // genuinamente AUSENTE do objeto, como o contrato de transição manda.
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: {
        uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries: ['AR'], groups: [],
        features: { AR: { 'screen:hook-sem-enforcement': { enabled: false, config: null } } },
      } as AuthzContract,
    });
    const { result } = renderHook(() => useFeature('screen:hook-sem-enforcement'));
    expect(result.current).toBe(true);
  });

  it('enforcement off não gera warn de fail-open — é rollout esperado, não manifest incompleto', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prontoFeatures(['AR'], { AR: { 'screen:hook-off-no-warn': { enabled: false, config: null } } }, 'off');
    renderHook(() => useFeature('screen:hook-off-no-warn'));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
