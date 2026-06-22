/**
 * DedupCenterPage.dismiss.test.tsx
 *
 * Covers dismiss and modal handlers in DedupCenterPageInner:
 * - handleDismiss: calls AdminDedupApiService.dismiss + refetch
 * - handleDismissSelected: bulk dismiss + clears selection
 * - MergeCompareModal: opens, closes via onClose, triggers refetch via onMergeSuccess
 *
 * Companion to DedupCenterPage.handlers.test.tsx (which covers selection).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
  within,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DedupCenterPage } from './DedupCenterPage';
import { EnliteRole } from '@domain/entities/EnliteRole';
import type { AdminUser } from '@domain/entities/AdminUser';
import type { DedupGroupSummary } from '@domain/entities/DedupGroup';

// ── Module mocks ──────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
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
vi.mock('@hooks/admin/useDedupQueue', () => ({
  useDedupQueue: () => mockUseDedupQueue(),
}));

const mockDismiss = vi.fn();
vi.mock('@infrastructure/http/AdminDedupApiService', () => ({
  AdminDedupApiService: {
    dismiss: (...args: unknown[]) => mockDismiss(...args),
    getGroups: vi.fn().mockResolvedValue([]),
    getGroupDetail: vi.fn(),
    merge: vi.fn(),
  },
}));

vi.mock(
  '@presentation/components/features/admin/Dedup/MergeCompareModal',
  () => ({
    MergeCompareModal: ({
      phoneNormalized,
      onClose,
      onMergeSuccess,
    }: {
      phoneNormalized: string;
      onClose: () => void;
      onMergeSuccess: () => void;
    }) => (
      <div data-testid="merge-modal-stub" data-phone={phoneNormalized}>
        <button onClick={onClose} data-testid="modal-close-btn">Close</button>
        <button onClick={onMergeSuccess} data-testid="modal-success-btn">Success</button>
      </div>
    ),
  }),
);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_PROFILE: AdminUser = {
  firebaseUid: 'uid-admin',
  email: 'admin@enlite.health',
  displayName: 'Admin',
  role: EnliteRole.ADMIN,
  department: null,
  lastLoginAt: null,
  loginCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

function makeAccount(id: string) {
  return {
    id,
    email: `${id}@test.com`,
    tier: 'REGISTERED' as const,
    status: 'ACTIVE',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    wja_count: 1,
    docs_count: 1,
    encuadres_count: 0,
    login_real: true,
  };
}

const GROUP_1: DedupGroupSummary = {
  phone_normalized: '+5491111111111',
  accounts: [makeAccount('acc-1a'), makeAccount('acc-1b')],
  survivor_suggested: 'acc-1a',
};

const GROUP_2: DedupGroupSummary = {
  phone_normalized: '+5492222222222',
  accounts: [makeAccount('acc-2a'), makeAccount('acc-2b')],
  survivor_suggested: 'acc-2a',
};

const mockRefetch = vi.fn();

const QUEUE_WITH_GROUPS = {
  groups: [GROUP_1, GROUP_2],
  isLoading: false,
  error: null,
  refetch: mockRefetch,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderPage() {
  return render(
    <MemoryRouter>
      <DedupCenterPage />
    </MemoryRouter>,
  );
}

function getRowButtons(groupIndex: number) {
  const rows = screen.getAllByRole('row');
  const dataRow = rows[groupIndex + 1];
  const rowBtns = within(dataRow).getAllByRole('button');
  return { merge: rowBtns[0], dismiss: rowBtns[1] };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseAdminAuth.mockReturnValue({
    adminProfile: ADMIN_PROFILE,
    isAuthenticated: true,
    isLoading: false,
  });
  mockUseDedupQueue.mockReturnValue(QUEUE_WITH_GROUPS);
  mockDismiss.mockResolvedValue({
    phoneNormalized: GROUP_1.phone_normalized,
    dismissedAt: '2026-06-22T00:00:00Z',
  });
});

// ── handleDismiss ─────────────────────────────────────────────────────────────

describe('DedupCenterPage — handleDismiss', () => {
  it('clicking dismiss for GROUP_1 calls dismiss with correct phone', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const { dismiss } = getRowButtons(0);
    await act(async () => { fireEvent.click(dismiss); });

    await waitFor(() => {
      expect(mockDismiss).toHaveBeenCalledWith({
        phoneNormalized: GROUP_1.phone_normalized,
      });
    });
  });

  it('clicking dismiss for GROUP_2 calls dismiss with GROUP_2 phone', async () => {
    mockDismiss.mockResolvedValue({
      phoneNormalized: GROUP_2.phone_normalized,
      dismissedAt: '2026-06-22T00:00:00Z',
    });

    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const { dismiss } = getRowButtons(1);
    await act(async () => { fireEvent.click(dismiss); });

    await waitFor(() => {
      expect(mockDismiss).toHaveBeenCalledWith({
        phoneNormalized: GROUP_2.phone_normalized,
      });
    });
  });

  it('handleDismiss calls refetch after successful dismiss', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const { dismiss } = getRowButtons(0);
    await act(async () => { fireEvent.click(dismiss); });

    await waitFor(() => { expect(mockRefetch).toHaveBeenCalled(); });
  });

  it('handleDismiss does NOT crash when dismiss rejects', async () => {
    mockDismiss.mockRejectedValue(new Error('network error'));

    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const { dismiss } = getRowButtons(0);
    await act(async () => { fireEvent.click(dismiss); });

    expect(screen.getByTestId('dedup-content')).toBeInTheDocument();
  });
});

// ── handleDismissSelected (bulk) ──────────────────────────────────────────────

describe('DedupCenterPage — handleDismissSelected', () => {
  it('bulk dismiss calls dismiss for each selected phone', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
    });

    const bulkBar = screen.getByTestId('dedup-bulk-bar');
    const dismissBulkBtn = within(bulkBar).getByRole('button', {
      name: /dismissAriaLabel|Descartar/i,
    });

    await act(async () => { fireEvent.click(dismissBulkBtn); });

    await waitFor(() => { expect(mockDismiss).toHaveBeenCalledTimes(2); });
  });

  it('bulk dismiss calls refetch after completion', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
    });

    const bulkBar = screen.getByTestId('dedup-bulk-bar');
    const dismissBulkBtn = within(bulkBar).getByRole('button', {
      name: /dismissAriaLabel|Descartar/i,
    });

    await act(async () => { fireEvent.click(dismissBulkBtn); });

    await waitFor(() => { expect(mockRefetch).toHaveBeenCalled(); });
  });

  it('bulk dismiss clears selection (BulkActionBar disappears)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
    });

    const bulkBar = screen.getByTestId('dedup-bulk-bar');
    const dismissBulkBtn = within(bulkBar).getByRole('button', {
      name: /dismissAriaLabel|Descartar/i,
    });

    await act(async () => { fireEvent.click(dismissBulkBtn); });

    await waitFor(() => {
      expect(screen.queryByTestId('dedup-bulk-bar')).not.toBeInTheDocument();
    });
  });

  it('BulkActionBar clear (X) button clears selection', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    await waitFor(() => {
      expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
    });

    const bulkBar = screen.getByTestId('dedup-bulk-bar');
    const clearBtn = within(bulkBar).getByRole('button', {
      name: /clearAriaLabel|Limpiar/i,
    });
    fireEvent.click(clearBtn);

    await waitFor(() => {
      expect(screen.queryByTestId('dedup-bulk-bar')).not.toBeInTheDocument();
    });
  });
});

// ── MergeCompareModal integration ─────────────────────────────────────────────

describe('DedupCenterPage — MergeCompareModal integration', () => {
  it('modal renders with correct phone when Merge button is clicked', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const { merge } = getRowButtons(0);
    fireEvent.click(merge);

    await waitFor(() => {
      const modal = screen.getByTestId('merge-modal-stub');
      expect(modal).toBeInTheDocument();
      expect(modal.getAttribute('data-phone')).toBe(GROUP_1.phone_normalized);
    });
  });

  it('modal renders for GROUP_2 when its Merge button is clicked', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const { merge } = getRowButtons(1);
    fireEvent.click(merge);

    await waitFor(() => {
      const modal = screen.getByTestId('merge-modal-stub');
      expect(modal.getAttribute('data-phone')).toBe(GROUP_2.phone_normalized);
    });
  });

  it('modal closes when onClose is triggered', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const { merge } = getRowButtons(0);
    fireEvent.click(merge);
    await waitFor(() => {
      expect(screen.getByTestId('merge-modal-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('modal-close-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('merge-modal-stub')).not.toBeInTheDocument();
    });
  });

  it('onMergeSuccess closes modal and calls refetch', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const { merge } = getRowButtons(0);
    fireEvent.click(merge);
    await waitFor(() => {
      expect(screen.getByTestId('merge-modal-stub')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('modal-success-btn'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('merge-modal-stub')).not.toBeInTheDocument();
    });
    expect(mockRefetch).toHaveBeenCalled();
  });
});
