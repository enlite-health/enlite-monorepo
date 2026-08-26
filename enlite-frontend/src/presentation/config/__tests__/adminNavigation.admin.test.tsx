import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { useAdminNavItems } from '../adminNavigation';
import { EnliteRole } from '@domain/entities/EnliteRole';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/hooks/useAdminAuth', () => ({ useAdminAuth: () => ({ adminProfile: { role: EnliteRole.ADMIN } }) }));

describe('admin com a célula: a seção já foi aberta pelos itens de admin', () => {
  it('o item de acessos vem SEM sectionStart, depois dos itens de admin', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['permission_management:read'], countries: [], groups: [], features: {} } });
    const items = renderHook(() => useAdminNavItems()).result.current;
    const acesso = items.find((i) => i.href === '/admin/access');
    expect(acesso?.sectionStart).toBeUndefined();
    expect(items.findIndex((i) => i.href === '/admin/tags')).toBeLessThan(items.indexOf(acesso!));
  });
});
