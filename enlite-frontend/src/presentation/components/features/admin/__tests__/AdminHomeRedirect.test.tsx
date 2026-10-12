import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { FeatureRouteGate } from '@presentation/components/features/access';
import { AdminHomeRedirect } from '../AdminHomeRedirect';
import type { AuthzContract } from '@domain/entities/Authz';

const KEY = 'screen:management-dashboard';

const pronto = (enabled: boolean) =>
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], groups: [],
      countries: ['AR'], enforcement: 'on',
      features: { AR: { [KEY]: { enabled, config: null } } },
    } as unknown as AuthzContract,
  });

/** A mesma topologia do App.tsx: índice redireciona; dashboard atrás de FeatureRouteGate; users própria. */
function montar(inicial: string) {
  return render(
    <MemoryRouter initialEntries={[inicial]}>
      <Routes>
        <Route path="/admin" element={<Outlet />}>
          <Route index element={<AdminHomeRedirect />} />
          <Route path="users" element={<span>tela-usuarios</span>} />
          <Route path="dashboard" element={<FeatureRouteGate feature={KEY}><span>tela-dashboard</span></FeatureRouteGate>} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('AdminHomeRedirect — o índice de /admin decide, sem loop', () => {
  beforeEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

  it('feature ligada: /admin termina na Gestão à Vista', () => {
    pronto(true);
    montar('/admin');
    expect(screen.getByText('tela-dashboard')).toBeInTheDocument();
    expect(screen.queryByText('tela-usuarios')).not.toBeInTheDocument();
  });

  it('feature desligada no país: /admin termina em Usuários (e o dashboard, aberto direto, volta ao índice e para lá — sem loop)', () => {
    pronto(false);
    const a = montar('/admin');
    expect(screen.getByText('tela-usuarios')).toBeInTheDocument();
    a.unmount();
    montar('/admin/dashboard');
    expect(screen.getByText('tela-usuarios')).toBeInTheDocument();
    expect(screen.queryByText('tela-dashboard')).not.toBeInTheDocument();
  });

  it.each([
    ['authz nulo (idle)', { authz: null, authzStatus: 'idle' as const }],
    ['authz nulo (erro)', { authz: null, authzStatus: 'error' as const }],
  ])('%s: useFeature é fail-open — vai ao dashboard, que também renderiza (sem loop)', (_n, estado) => {
    useAdminAuthStore.setState(estado);
    montar('/admin');
    expect(screen.getByText('tela-dashboard')).toBeInTheDocument();
  });
});

describe('App.tsx — rotas de Usuários', () => {
  const APP = readFileSync(resolve(__dirname, '../../../../App.tsx'), 'utf8');
  it('/admin/users renderiza AdminUsersPage; o índice é o redirect (não a tela)', () => {
    expect(APP).toContain('<Route path="users" element={<AdminUsersPage />} />');
    expect(APP).toContain('<Route index element={<AdminHomeRedirect />} />');
    expect(APP).not.toContain('<Route index element={<AdminUsersPage />} />');
  });
});
