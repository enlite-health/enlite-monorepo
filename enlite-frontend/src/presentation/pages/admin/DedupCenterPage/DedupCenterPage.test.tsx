/**
 * DedupCenterPage.test.tsx
 *
 * Covers:
 * - Guarda por célula (`dedup:read`, engine ON): sem a célula → navigate('/admin')
 *   chamado, conteúdo NÃO renderizado; com a célula → conteúdo renderizado
 * - Engine OFF / contrato ausente → sem navegação, conteúdo renderizado (D268)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DedupCenterPage } from './DedupCenterPage';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AdminUser } from '@domain/entities/AdminUser';
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

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const mockUseAdminAuth = vi.fn();

vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => mockUseAdminAuth(),
}));

const mockUseDedupQueue = vi.fn();
const mockUseDedupHistory = vi.fn();

vi.mock('@hooks/admin/useDedupQueue', () => ({
  useDedupQueue: () => mockUseDedupQueue(),
}));

vi.mock('@hooks/admin/useDedupHistory', () => ({
  useDedupHistory: () => mockUseDedupHistory(),
}));

vi.mock('@presentation/components/features/admin/Dedup/MergeCompareModal', () => ({
  MergeCompareModal: () => <div data-testid="merge-modal-mock" />,
}));

vi.mock('@presentation/components/features/admin/Dedup/UndoConfirmModal', () => ({
  UndoConfirmModal: () => <div data-testid="undo-modal-mock" />,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_PROFILE: AdminUser = {
  firebaseUid: 'uid-admin',
  email: 'admin@enlite.health',
  displayName: 'Admin User',
  department: null,
  lastLoginAt: null,
  loginCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
});

const QUEUE_LOADED = {
  groups: [],
  isLoading: false,
  error: null,
  refetch: vi.fn(),
};

const HISTORY_LOADED = {
  history: [],
  isLoading: false,
  error: null,
  refetch: vi.fn(),
  isUndoing: false,
  undoError: null,
  undo: vi.fn(),
};

// ── Helper ────────────────────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter>
      <DedupCenterPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
  mockUseAdminAuth.mockReturnValue({ adminProfile: ADMIN_PROFILE, isAuthenticated: true, isLoading: false });
  mockUseDedupQueue.mockReturnValue(QUEUE_LOADED);
  mockUseDedupHistory.mockReturnValue(HISTORY_LOADED);
});

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DedupCenterPage — guarda por célula: engine ON sem dedup:read', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });
  });

  it('calls navigate("/admin")', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
    });
  });

  it('does NOT render the page content', () => {
    renderPage();
    expect(screen.queryByTestId('dedup-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dedup-skeleton')).not.toBeInTheDocument();
  });
});

describe('DedupCenterPage — guarda por célula: engine ON com dedup:read', () => {
  beforeEach(() => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['dedup:read'], 'on') });
  });

  it('does NOT redirect', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  it('renders the content area', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument();
    });
  });

  it('renders a per-tab description for the active tab (queue by default)', async () => {
    renderPage();
    await waitFor(() => {
      const desc = screen.getByTestId('dedup-tab-description');
      // i18n returns the key in tests — the active tab is 'queue'
      expect(desc).toHaveTextContent('admin.dedup.tabDesc.queue');
    });
  });
});

describe('DedupCenterPage — engine OFF ou contrato ausente (régua de rollout D268)', () => {
  it('does NOT call navigate quando o contrato ainda não chegou', () => {
    renderPage();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('enforcement "off" SEM célula nenhuma: does NOT call navigate', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'off') });
    renderPage();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders the inner page (DedupCenterPageInner) quando o contrato ainda não chegou', () => {
    renderPage();
    // Content area should be visible (no loading state since useDedupQueue is not loading)
    expect(screen.getByTestId('dedup-content')).toBeInTheDocument();
  });
});

describe('DedupCenterPage — inner page loading state', () => {
  beforeEach(() => {
    mockUseDedupQueue.mockReturnValue({
      ...QUEUE_LOADED,
      isLoading: true,
    });
  });

  it('shows loading skeleton', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('dedup-skeleton')).toBeInTheDocument();
    });
  });

  it('does not show content area while loading', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.queryByTestId('dedup-content')).not.toBeInTheDocument();
    });
  });
});

describe('DedupCenterPage — inner page error state', () => {
  beforeEach(() => {
    mockUseDedupQueue.mockReturnValue({
      ...QUEUE_LOADED,
      error: 'Network error',
    });
  });

  it('shows error container', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('dedup-error')).toBeInTheDocument();
    });
  });

  it('does not show content area on error', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.queryByTestId('dedup-content')).not.toBeInTheDocument();
    });
  });
});
