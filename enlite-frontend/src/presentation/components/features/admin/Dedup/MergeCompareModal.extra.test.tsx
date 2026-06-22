/**
 * MergeCompareModal.extra.test.tsx
 *
 * Covers the remaining branches in MergeCompareModal NOT hit by MergeCompareModal.test.tsx:
 *
 * Lines 106-107: after successful merge, setMergeSuccess(true) is called, and
 *   setTimeout triggers onMergeSuccess() + onClose() after 1200ms.
 *   The success state shows the success message.
 *
 * Lines 110-111: the catch block in handleMerge — when merge() throws, the
 *   catch swallows it (mergeError is set by the hook, shown separately).
 *   This branch is reachable: merge() rejects and the component catches without crashing.
 *
 * Lines 107-113: the isDirectMode=true branch — MergeDirectModeBody rendered inside
 *   the shell. Tests: ESC closes in direct mode; X button and backdrop also close;
 *   the shell renders correctly with directAccounts props.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MergeCompareModal } from './MergeCompareModal';
import type { DedupGroupDetail, ImportedDedupAccount, MergeResult } from '@domain/entities/DedupGroup';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const mockMerge = vi.fn();
const mockRefetch = vi.fn();

vi.mock('@hooks/admin/useDedupGroupDetail', () => ({
  useDedupGroupDetail: vi.fn(),
}));

import { useDedupGroupDetail } from '@hooks/admin/useDedupGroupDetail';
const mockUseDedupGroupDetail = vi.mocked(useDedupGroupDetail);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_DETAIL: DedupGroupDetail = {
  phone_normalized: '+5491112345678',
  accounts: [
    {
      id: 'acc-001',
      email: 'a@test.com',
      tier: 'REGISTERED',
      status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      wja_count: 2,
      docs_count: 1,
      encuadres_count: 0,
      login_real: true,
    },
    {
      id: 'acc-002',
      email: 'b@test.com',
      tier: 'INCOMPLETE_REGISTER',
      status: 'INCOMPLETE',
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
      wja_count: 0,
      docs_count: 0,
      encuadres_count: 0,
      login_real: false,
    },
  ],
  survivor_suggested: 'acc-001',
  field_comparisons: [],
  reparent_preview: [],
};

const LOADED_STATE = {
  detail: MOCK_DETAIL,
  isLoading: false,
  error: null,
  refetch: mockRefetch,
  isMerging: false,
  mergeError: null,
  merge: mockMerge,
  dismiss: vi.fn(),
  dismissError: null,
  isDismissing: false,
};

// ── Helper ────────────────────────────────────────────────────────────────────

function renderModal(
  props: {
    phoneNormalized?: string;
    onClose?: () => void;
    onMergeSuccess?: () => void;
  } = {},
) {
  const defaults = {
    phoneNormalized: '+5491112345678',
    onClose: vi.fn(),
    onMergeSuccess: vi.fn(),
  };
  return render(<MergeCompareModal {...defaults} {...props} />);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockUseDedupGroupDetail.mockReturnValue(LOADED_STATE);
});

// ── Lines 106-107: mergeSuccess state ─────────────────────────────────────────

describe('MergeCompareModal — mergeSuccess state (lines 106-107)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('shows success message after merge resolves', async () => {
    mockMerge.mockResolvedValue({
      survivorId: 'acc-001',
      absorbedIds: ['acc-002'],
      mergedAt: '2026-06-22T00:00:00Z',
    } as MergeResult);

    const onMergeSuccess = vi.fn();
    renderModal({ onMergeSuccess });

    // Find the confirm button (defaultValue: 'Confirmar unificación')
    const confirmBtn = screen.getByRole('button', {
      name: /Confirmar unificación/i,
    });

    await act(async () => {
      fireEvent.click(confirmBtn);
      // Let the promise resolve
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // After merge resolves, mergeSuccess=true → success message in DOM
    // i18n returns defaultValue: 'Unificación realizada con éxito'
    const body = document.body.textContent ?? '';
    expect(body).toContain('Unificación realizada con éxito');
  });

  it('calls onMergeSuccess and onClose after 1200ms delay', async () => {
    mockMerge.mockResolvedValue({
      survivorId: 'acc-001',
      absorbedIds: ['acc-002'],
      mergedAt: '2026-06-22T00:00:00Z',
    } as MergeResult);

    const onClose = vi.fn();
    const onMergeSuccess = vi.fn();
    renderModal({ onClose, onMergeSuccess });

    const confirmBtn = screen.getByRole('button', {
      name: /Confirmar unificación/i,
    });

    await act(async () => {
      fireEvent.click(confirmBtn);
      // Let microtasks run (Promise.resolve chain)
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Before the timeout fires
    expect(onMergeSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Advance timers past the 1200ms delay
    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(onMergeSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('success state hides the footer Confirm button', async () => {
    mockMerge.mockResolvedValue({
      survivorId: 'acc-001',
      absorbedIds: ['acc-002'],
      mergedAt: '2026-06-22T00:00:00Z',
    } as MergeResult);

    renderModal();

    const confirmBtn = screen.getByRole('button', {
      name: /Confirmar unificación/i,
    });

    await act(async () => {
      fireEvent.click(confirmBtn);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Success state: footer condition `!mergeSuccess` → footer hidden
    // The confirm button should be gone
    expect(
      screen.queryByRole('button', { name: /Confirmar unificación/i }),
    ).not.toBeInTheDocument();
  });
});

// ── Lines 110-111: catch block in handleMerge ─────────────────────────────────

describe('MergeCompareModal — catch in handleMerge (lines 110-111)', () => {
  it('does NOT crash when merge() rejects (catch swallows the error)', async () => {
    mockMerge.mockRejectedValue(new Error('Backend conflict'));

    renderModal();

    const confirmBtn = screen.getByRole('button', {
      name: /Confirmar unificación/i,
    });

    // Clicking should not crash even though merge rejects
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Modal is still mounted — did not crash
    expect(screen.getByTestId('dedup-merge-modal')).toBeInTheDocument();
  });

  it('mergeSuccess stays false when merge() rejects', async () => {
    mockMerge.mockRejectedValue(new Error('Conflict'));

    renderModal();

    const confirmBtn = screen.getByRole('button', {
      name: /Confirmar unificación/i,
    });

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // The success message should NOT appear in the DOM
    const body = document.body.textContent ?? '';
    expect(body).not.toContain('Unificación realizada con éxito');
  });

  it('catch block handles non-Error throws without crashing', async () => {
    // Non-Error value thrown (plain string)
    mockMerge.mockRejectedValue('plain string error');

    renderModal();

    const confirmBtn = screen.getByRole('button', {
      name: /Confirmar unificación/i,
    });

    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    // Component still alive
    expect(screen.getByTestId('dedup-merge-modal')).toBeInTheDocument();
  });
});

// ── Lines 107-113: isDirectMode=true branch (MergeDirectModeBody inside shell) ─

const ACC_REAL: ImportedDedupAccount = {
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
};

const ACC_IMP: ImportedDedupAccount = {
  id: 'acc-imp-001',
  email: null,
  tier: 'PRE_REGISTER',
  status: 'INCOMPLETE',
  created_at: '2026-02-20T10:00:00Z',
  updated_at: '2026-02-20T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
  is_imported: true,
};

const DIRECT_ACCOUNTS = [ACC_REAL, ACC_IMP];

function renderDirectModal(overrides: {
  onClose?: () => void;
  onMergeSuccess?: () => void;
} = {}) {
  const defaults = {
    onClose: vi.fn(),
    onMergeSuccess: vi.fn(),
  };
  return render(
    <MergeCompareModal
      directAccounts={DIRECT_ACCOUNTS}
      survivorSuggestedId={ACC_REAL.id}
      survivorReason="real_account_absorbs_imported"
      {...defaults}
      {...overrides}
    />,
  );
}

describe('MergeCompareModal — direct mode shell (lines 107-113)', () => {
  it('renders the modal with direct accounts (isDirectMode=true branch)', () => {
    renderDirectModal();
    expect(screen.getByTestId('dedup-merge-modal')).toBeInTheDocument();
  });

  it('shows MergeDirectModeBody — account cards for each direct account', () => {
    renderDirectModal();
    expect(
      screen.getByTestId(`merge-account-card-${ACC_REAL.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`merge-account-card-${ACC_IMP.id}`),
    ).toBeInTheDocument();
  });

  it('ESC key closes the modal in direct mode', async () => {
    const onClose = vi.fn();
    renderDirectModal({ onClose });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('X button closes the modal in direct mode', async () => {
    const onClose = vi.fn();
    renderDirectModal({ onClose });

    const closeBtn = screen.getByRole('button', { name: /Cerrar/i });
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('backdrop click closes the modal in direct mode', async () => {
    const onClose = vi.fn();
    renderDirectModal({ onClose });

    const backdrop = screen.getByTestId('dedup-merge-modal');
    await act(async () => {
      fireEvent.click(backdrop);
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT render conflict banner for real_account_absorbs_imported', () => {
    renderDirectModal();
    expect(screen.queryByTestId('imported-conflict-banner')).not.toBeInTheDocument();
  });
});
