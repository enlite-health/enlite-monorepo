import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAdminNavItems } from '../adminNavigation';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const contrato = (permissions: string[], enforcement: 'on' | 'off' = 'on') => ({ uid: 'u', tenantId: 't', status: 'ACTIVE' as const, permissions, countries: [], groups: [], features: {}, enforcement });

describe('menu — o item de acessos deriva da CÉLULA', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('sem `permission_management:read` o item não existe — mesmo com contrato pronto', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['worker:read']) });
    const { result } = renderHook(() => useAdminNavItems());
    expect(result.current.map((i) => i.href)).not.toContain('/admin/access');
  });

  it('🔴 com a célula, aparece — sem depender de papel nenhum', () => {
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
  it('sem os outros itens de admin (nenhuma célula de leitura deles), o item de acessos carrega o sectionStart', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['permission_management:read']) });
    const item = renderHook(() => useAdminNavItems()).result.current.find((i) => i.href === '/admin/access');
    expect(item?.sectionStart).toBeTruthy();
  });
});
