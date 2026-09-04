import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAdminNavItems } from '../adminNavigation';
import { EnliteRole } from '@domain/entities/EnliteRole';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: { role: EnliteRole.RECRUITER } }),
}));

const contrato = (permissions: string[]) => ({ uid: 'u', tenantId: 't', status: 'ACTIVE' as const, permissions, countries: [], groups: [], features: {} });

describe('menu — o item de acessos deriva da CÉLULA, não do role', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('sem `permission_management:read` o item não existe — mesmo com contrato pronto', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['worker:read']) });
    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.map((i) => i.href)).not.toContain('/admin/access');
  });

  it('🔴 com a célula, aparece — para um RECRUITER, que o gate por role esconderia', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['permission_management:read']) });
    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.map((i) => i.href)).toContain('/admin/access');
  });

  it('contrato ainda não carregado: o item não aparece (fail-closed)', () => {
    useAdminAuthStore.setState({ authzStatus: 'loading' });
    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.map((i) => i.href)).not.toContain('/admin/access');
  });
});

describe('seção "Administración" — quem abre a seção', () => {
  it('sem itens de admin (recruiter), o item de acessos carrega o sectionStart', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['permission_management:read']) });
    const item = renderHook(() => useAdminNavItems()).result.current.find((i) => i.href === '/admin/access');
    expect(item?.sectionStart).toBeTruthy();
  });
});
