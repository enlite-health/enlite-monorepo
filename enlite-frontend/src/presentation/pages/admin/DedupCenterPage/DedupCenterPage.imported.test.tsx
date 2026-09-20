/**
 * DedupCenterPage.imported.test.tsx
 *
 * Covers the Onda 4b (imported tab) paths in DedupCenterPage NOT covered by
 * DedupCenterPage.test.tsx / handlers.test.tsx / dismiss.test.tsx:
 *
 * - History tab: switching to "history" renders the history content area;
 *   handleRefresh delegates to refetchHistory
 * - Imported tab: switching to "imported" renders imported content area;
 *   handleRefresh delegates to refetchImported
 * - Imported modal: clicking onOpenMerge on ImportedGroupsTab opens
 *   MergeCompareModal in direct mode; onMergeSuccess closes it + refetchImported
 * - Undo modal: handleUndoRequest opens UndoConfirmModal;
 *   handleUndoConfirm calls undo; closing the modal clears undoTarget
 * - handleRefresh — queue tab: delegates to refetch (queue)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DedupCenterPage } from './DedupCenterPage';
import type { AdminUser } from '@domain/entities/AdminUser';
import type { ImportedDedupGroup } from '@domain/entities/DedupGroup';

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

const mockUseDedupHistory = vi.fn();
vi.mock('@hooks/admin/useDedupHistory', () => ({
  useDedupHistory: () => mockUseDedupHistory(),
}));

const mockUseImportedGroups = vi.fn();
vi.mock('@hooks/admin/useImportedGroups', () => ({
  useImportedGroups: () => mockUseImportedGroups(),
}));

vi.mock('@infrastructure/http/AdminDedupApiService', () => ({
  AdminDedupApiService: {
    dismiss: vi.fn().mockResolvedValue({}),
    getGroups: vi.fn().mockResolvedValue([]),
    getGroupDetail: vi.fn(),
    merge: vi.fn(),
    getImportedGroups: vi.fn().mockResolvedValue([]),
  },
}));

// ── Modal mocks (lightweight stubs) ──────────────────────────────────────────

vi.mock(
  '@presentation/components/features/admin/Dedup/MergeCompareModal',
  () => ({
    MergeCompareModal: ({
      phoneNormalized,
      directAccounts,
      onClose,
      onMergeSuccess,
    }: {
      phoneNormalized?: string;
      directAccounts?: { id: string }[];
      onClose: () => void;
      onMergeSuccess: () => void;
    }) => (
      <div
        data-testid="merge-modal-stub"
        data-phone={phoneNormalized}
        data-direct={directAccounts ? 'true' : 'false'}
      >
        <button onClick={onClose} data-testid="modal-close-btn">Close</button>
        <button onClick={onMergeSuccess} data-testid="modal-success-btn">Success</button>
      </div>
    ),
  }),
);

vi.mock(
  '@presentation/components/features/admin/Dedup/UndoConfirmModal',
  () => ({
    UndoConfirmModal: ({
      auditId,
      onConfirm,
      onClose,
    }: {
      auditId: string;
      phone: string;
      isUndoing: boolean;
      onConfirm: (id: string) => void;
      onClose: () => void;
    }) => (
      <div data-testid="undo-modal-stub" data-audit={auditId}>
        <button onClick={() => onConfirm(auditId)} data-testid="undo-confirm-btn">Confirm</button>
        <button onClick={onClose} data-testid="undo-close-btn">Close</button>
      </div>
    ),
  }),
);

// Lightweight stub for ImportedGroupsTab that exposes the onOpenMerge callback
vi.mock('./ImportedGroupsTab', () => ({
  ImportedGroupsTab: ({
    onOpenMerge,
    onRetry,
  }: {
    groups: ImportedDedupGroup[];
    isLoading: boolean;
    error: string | null;
    onlyWithReal: boolean;
    onToggleOnlyWithReal: (v: boolean) => void;
    onOpenMerge: (g: ImportedDedupGroup) => void;
    onRetry: () => void;
  }) => (
    <div data-testid="imported-tab-stub">
      <button
        data-testid="open-merge-imported-btn"
        onClick={() =>
          onOpenMerge({
            accounts: [
              {
                id: 'acc-real-001',
                email: 'maria@example.com',
                tier: 'REGISTERED',
                status: 'ACTIVE',
                created_at: '2026-01-15T10:00:00Z',
                updated_at: '2026-03-01T10:00:00Z',
                wja_count: 3,
                docs_count: 2,
                encuadres_count: 1,
                login_real: true,
                is_imported: false,
              },
            ],
            survivor_suggested_id: 'acc-real-001',
            survivor_reason: 'real_account_absorbs_imported',
            has_real: true,
          })
        }
      >
        Open Imported Merge
      </button>
      <button data-testid="retry-imported-btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  ),
}));

// Lightweight stub for DedupHistoryTab that exposes the onUndo callback
vi.mock('./DedupHistoryTab', () => ({
  DedupHistoryTab: ({
    onUndo,
    onRetry,
  }: {
    history: unknown[];
    isLoading: boolean;
    error: string | null;
    onRetry: () => void;
    onUndo: (auditId: string, phone: string) => void;
  }) => (
    <div data-testid="history-tab-stub">
      <button
        data-testid="trigger-undo-btn"
        onClick={() => onUndo('audit-001', '+5491112345678')}
      >
        Undo
      </button>
      <button data-testid="retry-history-btn" onClick={onRetry}>Retry</button>
    </div>
  ),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_PROFILE: AdminUser = {
  firebaseUid: 'uid-admin',
  email: 'admin@enlite.health',
  displayName: 'Admin',
  department: null,
  lastLoginAt: null,
  loginCount: 1,
  createdAt: '2026-01-01T00:00:00Z',
};

const mockRefetchQueue = vi.fn();
const mockRefetchHistory = vi.fn();
const mockRefetchImported = vi.fn();
const mockUndo = vi.fn();

const QUEUE_LOADED = {
  groups: [],
  isLoading: false,
  error: null,
  refetch: mockRefetchQueue,
};

const HISTORY_LOADED = {
  history: [],
  isLoading: false,
  error: null,
  refetch: mockRefetchHistory,
  isUndoing: false,
  undoError: null,
  undo: mockUndo,
};

const IMPORTED_LOADED = {
  groups: [],
  isLoading: false,
  error: null,
  refetch: mockRefetchImported,
  onlyWithReal: true,
  setOnlyWithReal: vi.fn(),
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
  mockUseDedupQueue.mockReturnValue(QUEUE_LOADED);
  mockUseDedupHistory.mockReturnValue(HISTORY_LOADED);
  mockUseImportedGroups.mockReturnValue(IMPORTED_LOADED);
  mockUndo.mockResolvedValue({ auditId: 'audit-001', restoredAt: '2026-06-22T00:00:00Z' });
});

// ── History tab ───────────────────────────────────────────────────────────────

describe('DedupCenterPage — history tab', () => {
  it('clicking "history" tab renders the history content area', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole('button');
    // buttons: [refresh, queue-tab, history-tab, imported-tab]
    const historyTabBtn = buttons.find((b) => b.textContent?.includes('history'));
    fireEvent.click(historyTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('history-tab-stub')).toBeInTheDocument();
    });
  });

  it('handleRefresh on history tab calls refetchHistory', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    // Switch to history tab
    const buttons = screen.getAllByRole('button');
    const historyTabBtn = buttons.find((b) => b.textContent?.includes('history'));
    fireEvent.click(historyTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('history-tab-stub')).toBeInTheDocument();
    });

    // Click the top refresh button
    const refreshBtn = screen.getByRole('button', { name: /refresh/i });
    await act(async () => { fireEvent.click(refreshBtn); });

    expect(mockRefetchHistory).toHaveBeenCalled();
  });
});

// ── Imported tab ──────────────────────────────────────────────────────────────

describe('DedupCenterPage — imported tab', () => {
  it('clicking "imported" tab renders the imported content area', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole('button');
    const importedTabBtn = buttons.find((b) => b.textContent?.includes('imported'));
    fireEvent.click(importedTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('imported-tab-stub')).toBeInTheDocument();
    });
  });

  it('handleRefresh on imported tab calls refetchImported', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    // Switch to imported tab
    const buttons = screen.getAllByRole('button');
    const importedTabBtn = buttons.find((b) => b.textContent?.includes('imported'));
    fireEvent.click(importedTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('imported-tab-stub')).toBeInTheDocument();
    });

    // Click the top refresh button
    const refreshBtn = screen.getByRole('button', { name: /refresh/i });
    await act(async () => { fireEvent.click(refreshBtn); });

    expect(mockRefetchImported).toHaveBeenCalled();
  });
});

// ── Imported merge modal ──────────────────────────────────────────────────────

describe('DedupCenterPage — imported merge modal (direct mode)', () => {
  it('clicking onOpenMerge on imported tab opens MergeCompareModal in direct mode', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    // Switch to imported tab
    const buttons = screen.getAllByRole('button');
    const importedTabBtn = buttons.find((b) => b.textContent?.includes('imported'));
    fireEvent.click(importedTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('imported-tab-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-merge-imported-btn'));

    await waitFor(() => {
      const modal = screen.getByTestId('merge-modal-stub');
      expect(modal).toBeInTheDocument();
      expect(modal.getAttribute('data-direct')).toBe('true');
    });
  });

  it('onClose on imported merge modal closes the modal', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole('button');
    const importedTabBtn = buttons.find((b) => b.textContent?.includes('imported'));
    fireEvent.click(importedTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('imported-tab-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-merge-imported-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('merge-modal-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('modal-close-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('merge-modal-stub')).not.toBeInTheDocument();
    });
  });

  it('onMergeSuccess on imported modal closes it and calls refetchImported', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole('button');
    const importedTabBtn = buttons.find((b) => b.textContent?.includes('imported'));
    fireEvent.click(importedTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('imported-tab-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('open-merge-imported-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('merge-modal-stub')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('modal-success-btn'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('merge-modal-stub')).not.toBeInTheDocument();
    });
    expect(mockRefetchImported).toHaveBeenCalled();
  });
});

// ── Undo modal ────────────────────────────────────────────────────────────────

describe('DedupCenterPage — undo modal', () => {
  it('handleUndoRequest opens UndoConfirmModal', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    // Switch to history tab
    const buttons = screen.getAllByRole('button');
    const historyTabBtn = buttons.find((b) => b.textContent?.includes('history'));
    fireEvent.click(historyTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('history-tab-stub')).toBeInTheDocument();
    });

    // Trigger undo from the stub
    fireEvent.click(screen.getByTestId('trigger-undo-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('undo-modal-stub')).toBeInTheDocument();
    });
  });

  it('handleUndoConfirm calls undo with auditId', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole('button');
    const historyTabBtn = buttons.find((b) => b.textContent?.includes('history'));
    fireEvent.click(historyTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('history-tab-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('trigger-undo-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('undo-modal-stub')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('undo-confirm-btn'));
    });

    expect(mockUndo).toHaveBeenCalledWith('audit-001');
  });

  it('handleUndoConfirm closes modal after successful undo', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole('button');
    const historyTabBtn = buttons.find((b) => b.textContent?.includes('history'));
    fireEvent.click(historyTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('history-tab-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('trigger-undo-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('undo-modal-stub')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('undo-confirm-btn'));
    });

    await waitFor(() => {
      expect(screen.queryByTestId('undo-modal-stub')).not.toBeInTheDocument();
    });
  });

  it('handleUndoConfirm does NOT close modal when undo throws (catch path)', async () => {
    mockUndo.mockRejectedValue(new Error('Undo window expired'));

    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole('button');
    const historyTabBtn = buttons.find((b) => b.textContent?.includes('history'));
    fireEvent.click(historyTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('history-tab-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('trigger-undo-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('undo-modal-stub')).toBeInTheDocument();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('undo-confirm-btn'));
    });

    // Modal stays open — undo error keeps it visible
    expect(screen.getByTestId('undo-modal-stub')).toBeInTheDocument();
  });

  it('clicking close on UndoConfirmModal clears undoTarget', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const buttons = screen.getAllByRole('button');
    const historyTabBtn = buttons.find((b) => b.textContent?.includes('history'));
    fireEvent.click(historyTabBtn!);

    await waitFor(() => {
      expect(screen.getByTestId('history-tab-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('trigger-undo-btn'));
    await waitFor(() => {
      expect(screen.getByTestId('undo-modal-stub')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('undo-close-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('undo-modal-stub')).not.toBeInTheDocument();
    });
  });
});

// ── handleRefresh — queue tab ─────────────────────────────────────────────────

describe('DedupCenterPage — handleRefresh on queue tab', () => {
  it('handleRefresh on queue tab calls refetch (queue)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dedup-content')).toBeInTheDocument(),
    );

    const refreshBtn = screen.getByRole('button', { name: /refresh/i });
    await act(async () => { fireEvent.click(refreshBtn); });

    expect(mockRefetchQueue).toHaveBeenCalled();
  });
});
