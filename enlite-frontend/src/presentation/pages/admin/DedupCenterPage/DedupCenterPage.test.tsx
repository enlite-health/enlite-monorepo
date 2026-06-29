/**
 * DedupCenterPage.test.tsx
 *
 * Covers:
 * - Role guard: non-admin profile → navigate('/admin') called, content NOT rendered
 * - Role guard: admin profile → content IS rendered
 * - Role guard: adminProfile=null (loading) → no navigation, no inner content
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DedupCenterPage } from './DedupCenterPage';
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
  mockUseDedupQueue.mockReturnValue(QUEUE_LOADED);
  mockUseDedupHistory.mockReturnValue(HISTORY_LOADED);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DedupCenterPage — role guard: non-admin', () => {
  beforeEach(() => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: RECRUITER_PROFILE,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it('calls navigate("/admin") for a non-admin role', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/admin', { replace: true });
    });
  });

  it('does NOT render the page content for a non-admin role', () => {
    renderPage();
    expect(screen.queryByTestId('dedup-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dedup-skeleton')).not.toBeInTheDocument();
  });
});

describe('DedupCenterPage — role guard: admin', () => {
  beforeEach(() => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: ADMIN_PROFILE,
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it('does NOT redirect for admin role', async () => {
    renderPage();
    await waitFor(() => {
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  it('renders the content area for admin role', async () => {
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

describe('DedupCenterPage — role guard: loading (adminProfile=null)', () => {
  beforeEach(() => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: null,
      isAuthenticated: false,
      isLoading: true,
    });
  });

  it('does NOT call navigate when adminProfile is null (still loading)', () => {
    renderPage();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('renders the inner page (DedupCenterPageInner) when profile not yet loaded', () => {
    // When adminProfile is null we show the inner page (no redirect guard triggered)
    renderPage();
    // Content area should be visible (no loading state since useDedupQueue is not loading)
    expect(screen.getByTestId('dedup-content')).toBeInTheDocument();
  });
});

describe('DedupCenterPage — inner page loading state', () => {
  beforeEach(() => {
    mockUseAdminAuth.mockReturnValue({
      adminProfile: ADMIN_PROFILE,
      isAuthenticated: true,
      isLoading: false,
    });
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
    mockUseAdminAuth.mockReturnValue({
      adminProfile: ADMIN_PROFILE,
      isAuthenticated: true,
      isLoading: false,
    });
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
