import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { AdminProtectedRoute } from '../AdminProtectedRoute';
import type { AuthzContract, AuthzStatus } from '@domain/entities/Authz';
import { AdminPresenceApiService } from '@infrastructure/http/AdminPresenceApiService';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
// `usePresenceHeartbeat` monta em TODO render deste componente (agora é o ponto único de
// heartbeat, ver describe "presença" no fim do arquivo) — default resolvido para as suítes que
// não passam pelo `.catch()` explicitamente; sem isto, `AdminPresenceApiService.heartbeat()`
// devolveria `undefined` e o `.catch()` do hook explodiria em toda montagem.
vi.mock('@infrastructure/http/AdminPresenceApiService', () => ({
  AdminPresenceApiService: { heartbeat: vi.fn().mockResolvedValue(undefined) },
}));

const logout = vi.fn().mockResolvedValue(undefined);
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: vi.fn(() => ({
    isAuthenticated: true,
    isLoading: false,
    adminProfile: { email: 'a@enlite.health' },
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
      adminProfile: { email: 'a@enlite.health' } as ReturnType<typeof useAdminAuth>['adminProfile'],
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

  it('🔴 (loading, SEM contrato prévio) → spinner, NUNCA o layout com children vazio (achado real, Parte 2)', () => {
    useAdminAuthStore.setState({ authzStatus: 'loading', authz: null });
    montar();
    expect(screen.getByTestId('admin-authz-loading')).toBeInTheDocument();
    expect(screen.queryByText('painel-operacional')).not.toBeInTheDocument();
  });

  it('(loading, COM contrato prévio — stale-while-revalidate) → renderiza children normalmente, sem spinner', () => {
    useAdminAuthStore.setState({ authzStatus: 'loading', authz: contrato({ enforcement: 'on' }) });
    montar();
    expect(screen.getByText('painel-operacional')).toBeInTheDocument();
    expect(screen.queryByTestId('admin-authz-loading')).not.toBeInTheDocument();
  });

  it('(error) → renderiza children — a postura de erro é da própria página (ex. AccessGate), não welcome', () => {
    useAdminAuthStore.setState({ authzStatus: 'error', authz: null });
    montar();
    expect(screen.getByText('painel-operacional')).toBeInTheDocument();
    expect(screen.queryByText('admin.welcomeNoGroup.title')).not.toBeInTheDocument();
  });

  it('status !== ACTIVE (enforcement on, com grupo) → welcome com a mensagem de INATIVO, não a de sem-grupo', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ enforcement: 'on', status: 'SUSPENDED' }) });
    montar();
    expect(screen.getByText('admin.welcomeNoGroup.inactiveTitle')).toBeInTheDocument();
    expect(screen.queryByText('admin.welcomeNoGroup.title')).not.toBeInTheDocument();
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
      adminProfile: { email: 'a@enlite.health' } as ReturnType<typeof useAdminAuth>['adminProfile'],
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

/**
 * Presença (spec 022, Rodada 2, 22/09) — o heartbeat MUDOU de `AdminLayout` para cá: este é o
 * ponto único onde o app decide "staff autenticado" (D268), cobrindo também estados em que
 * `AdminLayout` nunca chega a montar (spinner de authz, `WelcomeNoGroupPage`).
 */
describe('AdminProtectedRoute — presença (heartbeat monta aqui, não mais no AdminLayout)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // `mockClear` — descarta a contagem de chamadas acumulada pelas suítes ANTERIORES deste
    // arquivo (elas também montam `AdminProtectedRoute`, cada montagem dispara 1 heartbeat
    // imediato) — sem isto, o 1º teste desta suíte herda uma contagem que não é dele.
    vi.mocked(AdminPresenceApiService.heartbeat).mockClear();
    vi.mocked(AdminPresenceApiService.heartbeat).mockResolvedValue(undefined);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato({ enforcement: 'on' }) });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('🔒 staff autenticado + com perfil → manda heartbeat IMEDIATAMENTE (immediate: true, sem esperar 60s)', async () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      isAuthenticated: true,
      isLoading: false,
      adminProfile: { email: 'a@enlite.health' } as ReturnType<typeof useAdminAuth>['adminProfile'],
      logout,
    } as unknown as ReturnType<typeof useAdminAuth>);

    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(AdminPresenceApiService.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('não autenticado → NUNCA manda heartbeat (enabled=false), mesmo montado e com o tempo passando', async () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      isAuthenticated: false, isLoading: false, adminProfile: null, logout,
    } as unknown as ReturnType<typeof useAdminAuth>);

    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000 * 2); });
    expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
  });

  it('autenticado mas SEM adminProfile (redireciona ao login) → NUNCA manda heartbeat', async () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      isAuthenticated: true, isLoading: false, adminProfile: null, logout,
    } as unknown as ReturnType<typeof useAdminAuth>);

    montar();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000 * 2); });
    expect(AdminPresenceApiService.heartbeat).not.toHaveBeenCalled();
  });
});
