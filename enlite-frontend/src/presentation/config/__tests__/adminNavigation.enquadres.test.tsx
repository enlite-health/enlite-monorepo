/**
 * Item "Encuadres" do menu (spec 076): só com AS DUAS células (`openWith: 'all'`); com uma só, ausente; engine off, presente;
 * logo depois de Pacientes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminNavItems } from '../adminNavigation';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const HREF = '/admin/enquadres';
const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
});
const hrefs = (): string[] => renderHook(() => useAdminNavItems()).result.current.map((i) => i.href as string);

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

describe('menu: Encuadres exige as duas células', () => {
  it('as duas → o item aparece, logo depois de Pacientes', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['enquadre_event:read', 'vacancy:read', 'patient:read'], 'on') });
    const h = hrefs();
    expect(h).toContain(HREF);
    expect(h.indexOf(HREF)).toBe(h.indexOf('/admin/patients') + 1);
  });

  it('🔴 só enquadre_event:read → ausente', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['enquadre_event:read'], 'on') });
    expect(hrefs()).not.toContain(HREF);
  });

  it('🔴 só vacancy:read → ausente', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['vacancy:read'], 'on') });
    expect(hrefs()).not.toContain(HREF);
  });

  it('engine off → o item aparece (a API decide)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'off') });
    expect(hrefs()).toContain(HREF);
  });
});
