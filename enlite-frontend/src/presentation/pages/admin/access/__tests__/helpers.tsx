import type { ReactNode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render } from '@testing-library/react';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

/** As três posturas do painel, pela célula — não por role. */
export function postura(nivel: 'hidden' | 'read' | 'write' | 'loading' | 'error'): void {
  if (nivel === 'loading') { useAdminAuthStore.setState({ authz: null, authzStatus: 'loading' }); return; }
  if (nivel === 'error') { useAdminAuthStore.setState({ authz: null, authzStatus: 'error' }); return; }
  const permissions = nivel === 'write'
    ? ['permission_management:read', 'permission_management:write']
    : nivel === 'read' ? ['permission_management:read'] : ['worker:read'];
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: ['AR'], groups: [], features: {} } as AuthzContract,
  });
}

export function renderRota(ui: ReactNode, path: string, pattern = path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={pattern} element={ui} />
        <Route path="/admin" element={<div data-testid="admin-home" />} />
        <Route path="/admin/access" element={<div data-testid="access-home" />} />
        <Route path="/admin/access/groups/:id" element={<div data-testid="group-detail-route" />} />
      </Routes>
    </MemoryRouter>,
  );
}

export const GRUPO = {
  id: '11111111-1111-4111-8111-111111111111',
  tenantId: 't',
  name: 'Recrutadores AR',
  description: 'Quem recruta na Argentina',
  isSystem: false,
  archivedAt: null,
  createdBy: 'u0',
  createdAt: '2026-08-01T00:00:00Z',
  cells: ['worker:read', 'funnel:read'],
  countries: ['AR'],
  memberCount: 1,
};

export const MEMBRO = {
  userId: 'uid-maria',
  email: 'maria@enlite.health',
  role: 'recruiter',
  status: 'ACTIVE',
  assignedBy: 'u0',
  assignedAt: '2026-08-02T00:00:00Z',
};

export const CATALOGO = [
  { category: 'workers', cells: [
    { resource: 'worker', action: 'read', category: 'workers', ownerService: 'wf' },
    { resource: 'worker', action: 'write', category: 'workers', ownerService: 'wf' },
  ] },
  { category: 'funnel', cells: [{ resource: 'funnel', action: 'read', category: 'funnel', ownerService: 'wf' }] },
];
