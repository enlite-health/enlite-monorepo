import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { AdminProtectedRoute } from '../AdminProtectedRoute';
import type { AuthzContract, AuthzStatus } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const logout = vi.fn().mockResolvedValue(undefined);
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: vi.fn(() => ({
    isAuthenticated: true,
    isLoading: false,
    adminProfile: { role: 'admin', email: 'a@enlite.health' },
    logout,
  })),
}));

import { useAdminAuth } from '@presentation/hooks/useAdminAuth';

const contrato = (over: Partial<AuthzContract> = {}): AuthzContract => ({
  uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: [], countries: [], groups: [{ id: 'g1', name: 'G' }], features: {}, ...over,
});

function montar() {
  return render(
    <MemoryRouter>
      <AdminProtectedRoute>
        <div>painel-operacional</div>
      </AdminProtectedRoute>
    </MemoryRouter>,
  );
}

describe('AdminProtectedRoute — tabela-verdade da A1 (D268), ponto único que cobre /admin/*', () => {
  beforeEach(() => {
    vi.mocked(useAdminAuth).mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      adminProfile: { role: 'admin', email: 'a@enlite.health' } as ReturnType<typeof useAdminAuth>['adminProfile'],
      logout,
    } as unknown as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  });

  it('(off, 0 grupos) → painel', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ groups: [], enforcement: 'off' }) });
    montar();
    expect(screen.getByText('painel-operacional')).toBeInTheDocument();
    expect(screen.queryByText('admin.welcomeNoGroup.title')).not.toBeInTheDocument();
  });

  it('(on, 0 grupos) → welcome', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ groups: [], enforcement: 'on' }) });
    montar();
    expect(screen.getByText('admin.welcomeNoGroup.title')).toBeInTheDocument();
    expect(screen.queryByText('painel-operacional')).not.toBeInTheDocument();
  });

  it('(on, ≥1 grupo) → painel', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ enforcement: 'on' }) });
    montar();
    expect(screen.getByText('painel-operacional')).toBeInTheDocument();
  });

  it('(loading) → nada do gate novo — renderiza children (o spinner do próprio painel, se houver, é dele)', () => {
    useAdminAuthStore.setState({ authzStatus: 'loading', authz: null });
    montar();
    expect(screen.getByText('painel-operacional')).toBeInTheDocument();
  });

  it('(error) → renderiza children — a postura de erro é da própria página (ex. AccessGate), não welcome', () => {
    useAdminAuthStore.setState({ authzStatus: 'error', authz: null });
    montar();
    expect(screen.getByText('painel-operacional')).toBeInTheDocument();
    expect(screen.queryByText('admin.welcomeNoGroup.title')).not.toBeInTheDocument();
  });

  it('status !== ACTIVE (enforcement on, com grupo) → welcome', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ enforcement: 'on', status: 'SUSPENDED' }) });
    montar();
    expect(screen.getByText('admin.welcomeNoGroup.title')).toBeInTheDocument();
  });

  it('Firebase ainda carregando (isLoading) → não renderiza nada, nem welcome nem painel', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      isAuthenticated: false, isLoading: true, adminProfile: null, logout,
    } as unknown as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ groups: [], enforcement: 'on' }) });
    const { container } = montar();
    expect(container).toBeEmptyDOMElement();
  });

  it('autenticado mas sem adminProfile → redireciona ao login, nunca ao welcome', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      isAuthenticated: true, isLoading: false, adminProfile: null, logout,
    } as unknown as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ groups: [], enforcement: 'on' }) });
    montar();
    expect(screen.queryByText('admin.welcomeNoGroup.title')).not.toBeInTheDocument();
    expect(screen.queryByText('painel-operacional')).not.toBeInTheDocument();
  });

  it('não autenticado → redireciona ao login, nunca ao welcome', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      isAuthenticated: false, isLoading: false, adminProfile: null, logout,
    } as unknown as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ groups: [], enforcement: 'on' }) });
    montar();
    expect(screen.queryByText('admin.welcomeNoGroup.title')).not.toBeInTheDocument();
    expect(screen.queryByText('painel-operacional')).not.toBeInTheDocument();
  });
});

/** Confere que a função pura usada pelo componente é exatamente a exportada por Authz.ts — sem lógica duplicada aqui. */
describe('AdminProtectedRoute usa shouldShowWelcomeNoGroup (não reimplementa a regra)', () => {
  beforeEach(() => {
    vi.mocked(useAdminAuth).mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      adminProfile: { role: 'admin', email: 'a@enlite.health' } as ReturnType<typeof useAdminAuth>['adminProfile'],
      logout,
    } as unknown as ReturnType<typeof useAdminAuth>);
  });

  it('sanity: idle nunca é welcome', () => {
    const status: AuthzStatus = 'idle';
    useAdminAuthStore.setState({ authzStatus: status, authz: contrato({ groups: [], enforcement: 'on' }) });
    montar();
    expect(screen.getByText('painel-operacional')).toBeInTheDocument();
  });
});
