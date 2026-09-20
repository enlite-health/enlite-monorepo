import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAdminNavItems } from '../adminNavigation';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

describe('com a célula de acessos E as de admin: a seção já foi aberta pelos itens de admin', () => {
  it('o item de acessos vem SEM sectionStart, depois dos itens de admin', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['permission_management:read', 'worker:read'], countries: [], groups: [], features: {} } });
    const items = renderHook(() => useAdminNavItems()).result.current;
    const acesso = items.find((i) => i.href === '/admin/access');
    expect(acesso?.sectionStart).toBeUndefined();
    expect(items.findIndex((i) => i.href === '/admin/tags')).toBeLessThan(items.indexOf(acesso!));
  });
});
