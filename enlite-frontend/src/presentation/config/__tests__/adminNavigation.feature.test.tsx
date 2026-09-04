import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAdminNavItems } from '../adminNavigation';
import { EnliteRole } from '@domain/entities/EnliteRole';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: { role: EnliteRole.RECRUITER } }),
}));

// M1 (D268) — `enforcement: 'on'` default: estes testes exercitam a régua de
// screen:* por MAPA; o freio de rollout (`useFeature.test.tsx`) tem sua própria suíte.
const contrato = (features: AuthzContract['features'], enforcement: AuthzContract['enforcement'] = 'on'): AuthzContract => ({
  uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['permission_management:read'], countries: ['BR'], groups: [], features, enforcement,
});

describe('useAdminNavItems — B2 (D268): item de menu some quando screen:* está desligada no país', () => {
  it('screen:talentum desligada no BR NÃO afeta o menu — não tem item de topo', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato({ BR: { 'screen:talentum': { enabled: false, config: null } } }),
    });
    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.map((i) => i.href)).toContain('/admin/vacancies');
  });

  it('screen:vacancies desligada no BR remove "/admin/vacancies" do menu', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato({ BR: { 'screen:vacancies': { enabled: false, config: null } } }),
    });
    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.map((i) => i.href)).not.toContain('/admin/vacancies');
  });

  it('screen:vacancies ligada no BR mantém "/admin/vacancies" no menu', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato({ BR: { 'screen:vacancies': { enabled: true, config: null } } }),
    });
    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.map((i) => i.href)).toContain('/admin/vacancies');
  });

  it('screen:access-permissions desligada remove /admin/access mesmo com a célula concedida', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato({ BR: { 'screen:access-permissions': { enabled: false, config: null } } }),
    });
    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.map((i) => i.href)).not.toContain('/admin/access');
  });

  it('/admin/dashboard (fora do país mapeado, ex. mapa só tem AR) não é afetado — fail-open por ausência de país', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { ...contrato({ AR: { 'screen:management-dashboard': { enabled: false, config: null } } }), countries: ['AR', 'BR'] },
    });
    const { result } = renderHook(() => useAdminNavItems());
    // >1 país é "ator sem país único" (featureEnabledFor) — fail-open, item continua.
    expect(result.current.map((i) => i.href)).toContain('/admin/dashboard');
  });
});
