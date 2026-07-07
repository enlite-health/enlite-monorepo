/**
 * BlockedAttemptsPage.guard.test.tsx
 *
 * Role guard (espelha o padrão do DedupCenterPage):
 * - non-admin profile → navigate('/admin') chamado, conteúdo NÃO renderizado
 * - admin profile → sem redirect, conteúdo renderizado
 * - adminProfile=null (loading) → sem navigate
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BlockedAttemptsPage } from './BlockedAttemptsPage';
import { EnliteRole } from '@domain/entities/EnliteRole';
import type { AdminUser } from '@domain/entities/AdminUser';

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

const mockUseAdminAuth = vi.fn();

vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => mockUseAdminAuth(),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_PROFILE: AdminUser = {
  firebaseUid: 'uid-admin',
  email: 'admin@enlite.health',
  displayName: 'Admin User',
  role: EnliteRole.ADMIN,
  department: null,
  lastLoginAt: null,
  loginCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

const RECRUITER_PROFILE: AdminUser = {
  ...ADMIN_PROFILE,
  role: EnliteRole.RECRUITER,
  email: 'recruiter@enlite.health',
};

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
  mockUseBlockedAttempts.mockReturnValue(LOADING_STATE);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BlockedAttemptsPage — role guard: non-admin', () => {
  beforeEach(() => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: RECRUITER_PROFILE,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it('chama navigate("/admin") para role não-admin', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
    });
  });

  it('NÃO renderiza o conteúdo da página para role não-admin', () => {
    renderPage();
    expect(screen.queryByTestId('blocked-skeleton')).not.toBeInTheDocument();
  });
});

describe('BlockedAttemptsPage — role guard: admin', () => {
  beforeEach(() => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: ADMIN_PROFILE,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it('NÃO redireciona para role admin', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  it('renderiza o conteúdo (skeleton em loading) para admin', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('blocked-skeleton')).toBeInTheDocument();
    });
  });
});

describe('BlockedAttemptsPage — role guard: loading (adminProfile=null)', () => {
  beforeEach(() => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: null,
      isAuthenticated: false,
      isLoading: true,
    });
  });

  it('NÃO chama navigate enquanto o perfil não carregou', () => {
    renderPage();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
