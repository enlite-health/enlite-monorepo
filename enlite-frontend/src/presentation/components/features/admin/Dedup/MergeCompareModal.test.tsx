/**
 * MergeCompareModal.test.tsx
 *
 * Covers handleMerge logic + close paths:
 *
 * handleMerge:
 *   - absorbedIds = all accounts minus survivor
 *   - fieldChoices included only when non-empty
 *   - changing survivor (setSurvivorId) updates the payload accordingly
 *
 * Close paths:
 *   - X button calls onClose
 *   - Backdrop click calls onClose
 *   - ESC key calls onClose
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MergeCompareModal } from './MergeCompareModal';
import type { DedupGroupDetail, MergeResult } from '@domain/entities/DedupGroup';

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
      wja_count: 3,
      docs_count: 2,
      encuadres_count: 1,
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
    {
      id: 'acc-003',
      email: null,
      tier: 'PRE_REGISTER',
      status: 'INCOMPLETE',
      created_at: '2026-03-01T00:00:00Z',
      updated_at: '2026-03-01T00:00:00Z',
      wja_count: 0,
      docs_count: 0,
      encuadres_count: 0,
      login_real: false,
    },
  ],
  survivor_suggested: 'acc-001',
  field_comparisons: [
    {
      field: 'email',
      values: { 'acc-001': 'a@test.com', 'acc-002': 'b@test.com', 'acc-003': null },
      is_encrypted: false,
      has_conflict: true,
    },
  ],
  reparent_preview: [
    { entity: 'worker_job_applications', count: 3 },
  ],
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

const LOADING_STATE = {
  ...LOADED_STATE,
  detail: null as null,
  isLoading: true,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockUseDedupGroupDetail.mockReturnValue(LOADED_STATE);
});

// ── handleMerge ───────────────────────────────────────────────────────────────

describe('MergeCompareModal — handleMerge payload', () => {
  it('absorbedIds = all accounts minus survivor (acc-001)', async () => {
    mockMerge.mockResolvedValue({ survivorId: 'acc-001', absorbedIds: ['acc-002', 'acc-003'], mergedAt: '' } as MergeResult);

    const onMergeSuccess = vi.fn();
    renderModal({ onMergeSuccess });

    const confirmBtn = await screen.findByRole('button', { name: /Confirmar unificación/i });
    await act(async () => { fireEvent.click(confirmBtn); });

    expect(mockMerge).toHaveBeenCalledWith(
      expect.objectContaining({
        survivorId: 'acc-001',
        absorbedIds: expect.arrayContaining(['acc-002', 'acc-003']),
      }),
    );
    const calledPayload = mockMerge.mock.calls[0][0];
    expect(calledPayload.absorbedIds).not.toContain('acc-001');
    expect(calledPayload.absorbedIds).toHaveLength(2);
  });

  it('fieldChoices NOT included when empty', async () => {
    mockMerge.mockResolvedValue({ survivorId: 'acc-001', absorbedIds: ['acc-002', 'acc-003'], mergedAt: '' } as MergeResult);

    renderModal();

    const confirmBtn = await screen.findByRole('button', { name: /Confirmar unificación/i });
    await act(async () => { fireEvent.click(confirmBtn); });

    const calledPayload = mockMerge.mock.calls[0][0];
    expect('fieldChoices' in calledPayload).toBe(false);
  });

  it('fieldChoices IS included when a field-level choice is made', async () => {
    mockMerge.mockResolvedValue({ survivorId: 'acc-001', absorbedIds: ['acc-002', 'acc-003'], mergedAt: '' } as MergeResult);

    renderModal();

    // Open advanced section
    const advancedToggle = document.querySelector('button[aria-expanded]') as HTMLButtonElement;
    await act(async () => { fireEvent.click(advancedToggle); });

    // Click the second account button (acc-002) in the field-level picker
    const fieldButtons = document.querySelectorAll('.flex.flex-wrap.gap-2 button');
    // Click the non-default account button
    const nonDefaultBtn = Array.from(fieldButtons).find(
      (b) => !b.getAttribute('aria-pressed')?.includes('true'),
    ) as HTMLButtonElement;
    if (nonDefaultBtn) {
      await act(async () => { fireEvent.click(nonDefaultBtn); });
    }

    const confirmBtn = await screen.findByRole('button', { name: /Confirmar unificación/i });
    await act(async () => { fireEvent.click(confirmBtn); });

    const calledPayload = mockMerge.mock.calls[0][0];
    expect('fieldChoices' in calledPayload).toBe(true);
  });
});

describe('MergeCompareModal — explanatory banner', () => {
  it('renders the intro banner (title + desc) in phone mode', async () => {
    renderModal();

    expect(await screen.findByTestId('merge-intro-banner')).toBeInTheDocument();
    expect(
      screen.getByText(/parecen ser la misma persona/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Elegí cuál es la cuenta PRINCIPAL/i),
    ).toBeInTheDocument();
    // name-match reinforcement is only for direct (imported) mode
    expect(screen.queryByText(/Coincidencia por NOMBRE/i)).not.toBeInTheDocument();
  });
});

describe('MergeCompareModal — defensive guard (no crash on bad payload)', () => {
  it('does NOT crash when backend payload has field_comparisons undefined', async () => {
    // Simulate an unexpected/legacy payload (root cause of the prod crash:
    // backend sent the singular key → field_comparisons was undefined).
    const malformedDetail = {
      ...MOCK_DETAIL,
      field_comparisons: undefined,
      reparent_preview: undefined,
    } as unknown as DedupGroupDetail;
    mockUseDedupGroupDetail.mockReturnValue({
      ...LOADED_STATE,
      detail: malformedDetail,
    });

    renderModal();

    // Modal renders, account cards present, no thrown error.
    expect(await screen.findByTestId('dedup-merge-modal')).toBeInTheDocument();
    expect(
      screen.getByTestId('merge-account-card-acc-001'),
    ).toBeInTheDocument();
    // Confirm button still operable (proves no render crash short-circuited the tree).
    expect(
      screen.getByRole('button', { name: /Confirmar unificación/i }),
    ).toBeInTheDocument();
  });
});

describe('MergeCompareModal — survivor change updates payload', () => {
  it('selecting a different survivor changes survivorId and absorbedIds in merge payload', async () => {
    mockMerge.mockResolvedValue({ survivorId: 'acc-002', absorbedIds: ['acc-001', 'acc-003'], mergedAt: '' } as MergeResult);

    renderModal();

    // Find "Hacer principal" button for acc-002 account card
    const setSurvivorBtns = await screen.findAllByText(/Hacer principal/i);
    // Click the first one (acc-002 is first non-survivor)
    await act(async () => { fireEvent.click(setSurvivorBtns[0]); });

    const confirmBtn = screen.getByRole('button', { name: /Confirmar unificación/i });
    await act(async () => { fireEvent.click(confirmBtn); });

    const calledPayload = mockMerge.mock.calls[0][0];
    expect(calledPayload.survivorId).toBe('acc-002');
    expect(calledPayload.absorbedIds).toContain('acc-001');
    expect(calledPayload.absorbedIds).not.toContain('acc-002');
  });
});

// ── Close paths ───────────────────────────────────────────────────────────────

describe('MergeCompareModal — close via X button', () => {
  it('X button calls onClose', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    const closeBtn = screen.getByRole('button', { name: /Cerrar/i });
    await act(async () => { fireEvent.click(closeBtn); });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('MergeCompareModal — close via backdrop click', () => {
  it('clicking the backdrop overlay calls onClose', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    const backdrop = screen.getByTestId('dedup-merge-modal');
    await act(async () => { fireEvent.click(backdrop); });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the card does NOT call onClose', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    const dialog = screen.getByRole('dialog');
    await act(async () => { fireEvent.click(dialog); });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('MergeCompareModal — close via ESC key', () => {
  it('ESC key calls onClose', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape', code: 'Escape' });
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('other keys do NOT call onClose', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });

    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('MergeCompareModal — loading state', () => {
  it('shows loading skeleton when isLoading=true', () => {
    mockUseDedupGroupDetail.mockReturnValue(LOADING_STATE);
    renderModal();
    // The skeleton renders animated divs but no confirm button
    expect(screen.queryByRole('button', { name: /Confirmar unificación/i })).not.toBeInTheDocument();
  });
});

describe('MergeCompareModal — error state', () => {
  it('shows error message and retry button when error is set', async () => {
    mockUseDedupGroupDetail.mockReturnValue({
      ...LOADED_STATE,
      detail: null as null,
      isLoading: false,
      error: 'Not found',
    });
    renderModal();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Not found');
    });
  });
});

describe('MergeCompareModal — mergeError display', () => {
  it('renders mergeError text when merge fails', async () => {
    mockMerge.mockRejectedValue(new Error('Merge conflict'));
    mockUseDedupGroupDetail.mockReturnValue({
      ...LOADED_STATE,
      mergeError: 'Merge conflict',
    });
    renderModal();
    await waitFor(() => {
      expect(document.body.textContent).toContain('Merge conflict');
    });
  });
});

describe('MergeCompareModal — isMerging state', () => {
  it('shows spinner and merging text when isMerging=true', async () => {
    mockUseDedupGroupDetail.mockReturnValue({
      ...LOADED_STATE,
      isMerging: true,
    });
    renderModal();
    await waitFor(() => {
      // Merging state shows the merging text key
      expect(document.body.textContent).toContain('Unificando');
    });
  });

  it('cancel button is disabled when isMerging=true', async () => {
    mockUseDedupGroupDetail.mockReturnValue({
      ...LOADED_STATE,
      isMerging: true,
    });
    renderModal();
    await waitFor(() => {
      const cancelBtn = screen.getByRole('button', { name: /Cancelar/i });
      expect((cancelBtn as HTMLButtonElement).disabled).toBe(true);
    });
  });
});

describe('MergeCompareModal — phone label', () => {
  it('displays the phoneNormalized value in the modal body', async () => {
    renderModal({ phoneNormalized: '+5499887766' });
    await waitFor(() => {
      expect(document.body.textContent).toContain('+5499887766');
    });
  });
});
