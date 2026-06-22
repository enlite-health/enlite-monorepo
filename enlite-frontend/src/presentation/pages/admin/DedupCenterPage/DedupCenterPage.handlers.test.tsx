/**
 * DedupCenterPage.handlers.test.tsx
 *
 * Covers selection handlers in DedupCenterPageInner:
 * - handleToggleSelect: adds/removes phone from selectedPhones
 * - handleToggleSelectAll: selects all / deselects all
 *
 * Dismiss and modal integration are in DedupCenterPage.dismiss.test.tsx.
 * Role-guard tests are in DedupCenterPage.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
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
vi.mock('@hooks/admin/useDedupQueue', () => ({
  useDedupQueue: () => mockUseDedupQueue(),
}));

vi.mock('@infrastructure/http/AdminDedupApiService', () => ({
  AdminDedupApiService: {
    dismiss: vi.fn().mockResolvedValue({ phoneNormalized: '+5491111111111', dismissedAt: '2026-06-22' }),
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
  mockUseAdminAuth.mockReturnValue({
    adminProfile: ADMIN_PROFILE,
    isAuthenticated: true,
    isLoading: false,
  });
  mockUseDedupQueue.mockReturnValue(QUEUE_WITH_GROUPS);
});

// ── handleToggleSelect ────────────────────────────────────────────────────────

describe('DedupCenterPage — handleToggleSelect', () => {
  it('clicking a row checkbox shows the BulkActionBar (phone added to selectedPhones)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    // Checkboxes: [0]=select-all, [1]=GROUP_1 row, [2]=GROUP_2 row
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);

    await waitFor(() => {
      expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
    });
  });

  it('clicking a selected row checkbox deselects it (BulkActionBar disappears)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    // Select
    fireEvent.click(checkboxes[1]);
    await waitFor(() => {
      expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
    });

    // Deselect same row
    fireEvent.click(checkboxes[1]);
    await waitFor(() => {
      expect(screen.queryByTestId('dedup-bulk-bar')).not.toBeInTheDocument();
    });
  });

  it('row checkbox becomes checked when clicked', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);

    fireEvent.click(checkboxes[1]);
    await waitFor(() => {
      expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
    });
  });
});

// ── handleToggleSelectAll ─────────────────────────────────────────────────────

describe('DedupCenterPage — handleToggleSelectAll', () => {
  it('clicking select-all checks all row checkboxes', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    // [0]=select-all, [1]=GROUP_1, [2]=GROUP_2
    fireEvent.click(checkboxes[0]);

    await waitFor(() => {
      expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
      expect((checkboxes[2] as HTMLInputElement).checked).toBe(true);
    });
  });

  it('clicking select-all when all selected clears all row checkboxes', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    // Select all
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
    });

    // Deselect all
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
      expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
    });
  });

  it('select-all toggles BulkActionBar visible when all groups selected', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);

    await waitFor(() => {
      expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
    });
  });
});
