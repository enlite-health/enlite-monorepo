/**
 * BlockedAttemptsPage.guard.test.tsx
 *
 * Guarda de container (espelha o padrão do DedupCenterPage): a célula da
 * leitura que a tela faz — GET /recruitment/blocked-attempts → recruitment:read.
 * - engine ON sem a célula → navigate('/admin') chamado, conteúdo NÃO renderizado
 * - engine ON com a célula → sem redirect, conteúdo renderizado
 * - engine OFF / contrato ainda não carregado → sem navigate (régua de rollout D268)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BlockedAttemptsPage } from './BlockedAttemptsPage';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.defaultValue !== undefined) return String(opts.defaultValue);
      return key;
    },
  }),
}));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const mockUseBlockedAttempts = vi.fn();

vi.mock('@hooks/admin/useBlockedAttempts', () => ({
  useBlockedAttempts: (...args: unknown[]) => mockUseBlockedAttempts(...args),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
});

const LOADING_STATE = {
  attempts: [],
  aggregates: { totalBlocked: 0, byReason: {} },
  pagination: {
    total: 0, limit: 20, offset: 0, page: 1, totalPages: 0,
    hasNext: false, hasPrev: false,
  },
  isLoading: true,
  error: null,
  refetch: vi.fn(),
};

// ── Helper ────────────────────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter>
      <BlockedAttemptsPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  mockUseBlockedAttempts.mockReturnValue(LOADING_STATE);
});

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BlockedAttemptsPage — guarda por célula: engine ON sem recruitment:read', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
  });

  it('chama navigate("/admin")', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
    });
  });

  it('NÃO renderiza o conteúdo da página', () => {
    renderPage();
    expect(screen.queryByTestId('blocked-skeleton')).not.toBeInTheDocument();
  });
});

describe('BlockedAttemptsPage — guarda por célula: engine ON com recruitment:read', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['recruitment:read'], 'on') });
  });

  it('NÃO redireciona', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  it('renderiza o conteúdo (skeleton em loading)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('blocked-skeleton')).toBeInTheDocument();
    });
  });
});

describe('BlockedAttemptsPage — guarda por célula: engine OFF ou contrato ausente', () => {
  it('sem contrato nenhum: NÃO chama navigate e renderiza o conteúdo', async () => {
    renderPage();
    expect(mockNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('blocked-skeleton')).toBeInTheDocument());
  });

  it('enforcement "off" SEM célula nenhuma: NÃO chama navigate', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'off') });
    renderPage();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
