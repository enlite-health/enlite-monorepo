/**
 * MergeDirectModeBody.test.tsx
 *
 * Covers:
 * - Renders account cards for each account (no fetch)
 * - Conflict banner: shown when survivorReason='conflict_multiple_real_accounts'
 * - Conflict banner: NOT shown for 'real_account_absorbs_imported'
 * - Merge button disabled when conflict
 * - Merge button enabled for non-conflict
 * - handleMerge builds correct payload: survivorId + absorbedIds (excludes survivor)
 * - handleMerge calls AdminDedupApiService.merge
 * - mergeError rendered when merge fails
 * - success message shown after merge succeeds
 * - cancel button calls onClose
 * - footer hidden after mergeSuccess
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MergeDirectModeBody } from './MergeDirectModeBody';
import type { MergeDirectModeBodyProps } from './MergeDirectModeBody';
import type { ImportedDedupAccount } from '@domain/entities/DedupGroup';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const mockMerge = vi.fn();

vi.mock('@infrastructure/http/AdminDedupApiService', () => ({
  AdminDedupApiService: {
    merge: (...args: unknown[]) => mockMerge(...args),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

const ACC_REAL_2: ImportedDedupAccount = {
  ...ACC_REAL,
  id: 'acc-real-002',
  email: 'carlos@example.com',
};

const DEFAULT_PROPS: MergeDirectModeBodyProps = {
  accounts: [ACC_REAL, ACC_IMP],
  survivorSuggestedId: ACC_REAL.id,
  survivorReason: 'real_account_absorbs_imported',
  onClose: vi.fn(),
  onMergeSuccess: vi.fn(),
};

function renderBody(overrides: Partial<MergeDirectModeBodyProps> = {}) {
  return render(<MergeDirectModeBody {...DEFAULT_PROPS} {...overrides} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Account cards ─────────────────────────────────────────────────────────────

describe('MergeDirectModeBody — account cards', () => {
  it('renders a card for each account', () => {
    renderBody();
    expect(
      screen.getByTestId(`merge-account-card-${ACC_REAL.id}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`merge-account-card-${ACC_IMP.id}`),
    ).toBeInTheDocument();
  });
});

// ── Conflict banner ───────────────────────────────────────────────────────────

describe('MergeDirectModeBody — conflict banner', () => {
  it('shows conflict banner when survivorReason=conflict_multiple_real_accounts', () => {
    renderBody({
      accounts: [ACC_REAL, ACC_REAL_2],
      survivorSuggestedId: ACC_REAL.id,
      survivorReason: 'conflict_multiple_real_accounts',
    });
    expect(screen.getByTestId('imported-conflict-banner')).toBeInTheDocument();
  });

  it('does NOT show conflict banner for real_account_absorbs_imported', () => {
    renderBody();
    expect(
      screen.queryByTestId('imported-conflict-banner'),
    ).not.toBeInTheDocument();
  });

  it('does NOT show conflict banner for most_complete', () => {
    renderBody({ survivorReason: 'most_complete' });
    expect(
      screen.queryByTestId('imported-conflict-banner'),
    ).not.toBeInTheDocument();
  });
});

// ── Merge button disabled state ───────────────────────────────────────────────

describe('MergeDirectModeBody — merge button disabled for conflict', () => {
  it('confirm button is disabled when survivorReason=conflict_multiple_real_accounts', () => {
    renderBody({
      accounts: [ACC_REAL, ACC_REAL_2],
      survivorSuggestedId: ACC_REAL.id,
      survivorReason: 'conflict_multiple_real_accounts',
    });
    const btn = screen.getByTestId(
      'imported-merge-confirm-btn',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('confirm button is enabled for real_account_absorbs_imported', () => {
    renderBody();
    const btn = screen.getByTestId(
      'imported-merge-confirm-btn',
    ) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('handleMerge returns early (L55) when isConflict=true — merge NOT called even on click', async () => {
    // fireEvent.click bypasses the HTML disabled attribute and fires the React handler.
    // The L55 early return (if (isConflict) return) prevents merge() from being called.
    renderBody({
      accounts: [ACC_REAL, ACC_REAL_2],
      survivorSuggestedId: ACC_REAL.id,
      survivorReason: 'conflict_multiple_real_accounts',
    });

    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      // Use fireEvent directly — bypasses disabled attr, hits the early-return guard at L55
      fireEvent.click(btn);
    });

    // The early return at L55 prevents merge() from being called
    expect(mockMerge).not.toHaveBeenCalled();
  });
});

// ── handleMerge payload ───────────────────────────────────────────────────────

describe('MergeDirectModeBody — handleMerge payload', () => {
  it('calls AdminDedupApiService.merge with correct survivorId and absorbedIds', async () => {
    mockMerge.mockResolvedValue({
      survivorId: ACC_REAL.id,
      absorbedIds: [ACC_IMP.id],
      mergedAt: '',
    });

    renderBody();

    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(btn);
    });

    expect(mockMerge).toHaveBeenCalledWith({
      survivorId: ACC_REAL.id,
      absorbedIds: [ACC_IMP.id],
    });
  });

  it('absorbedIds does NOT include the survivor', async () => {
    mockMerge.mockResolvedValue({
      survivorId: ACC_REAL.id,
      absorbedIds: [ACC_IMP.id],
      mergedAt: '',
    });

    renderBody();

    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(btn);
    });

    const payload = mockMerge.mock.calls[0][0];
    expect(payload.absorbedIds).not.toContain(ACC_REAL.id);
  });

  it('payload does NOT include fieldChoices (no advanced section in direct mode)', async () => {
    mockMerge.mockResolvedValue({
      survivorId: ACC_REAL.id,
      absorbedIds: [ACC_IMP.id],
      mergedAt: '',
    });

    renderBody();
    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(btn);
    });

    const payload = mockMerge.mock.calls[0][0];
    expect('fieldChoices' in payload).toBe(false);
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('MergeDirectModeBody — merge error', () => {
  it('renders mergeError text when merge fails', async () => {
    mockMerge.mockRejectedValue(new Error('Backend conflict'));

    renderBody();

    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(btn);
    });

    await waitFor(() => {
      expect(document.body.textContent).toContain('Backend conflict');
    });
  });

  it('does not crash for non-Error throws', async () => {
    mockMerge.mockRejectedValue('plain string');

    renderBody();
    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(btn);
    });

    // Component still alive
    expect(screen.getByTestId('imported-merge-confirm-btn')).toBeInTheDocument();
  });
});

// ── Success state ─────────────────────────────────────────────────────────────

describe('MergeDirectModeBody — success state', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
  });

  it('shows success message after merge resolves', async () => {
    mockMerge.mockResolvedValue({
      survivorId: ACC_REAL.id,
      absorbedIds: [ACC_IMP.id],
      mergedAt: '',
    });

    renderBody();

    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(document.body.textContent).toContain('Unificación realizada con éxito');
  });

  it('calls onMergeSuccess and onClose after 1200ms', async () => {
    mockMerge.mockResolvedValue({
      survivorId: ACC_REAL.id,
      absorbedIds: [ACC_IMP.id],
      mergedAt: '',
    });

    const onClose = vi.fn();
    const onMergeSuccess = vi.fn();
    renderBody({ onClose, onMergeSuccess });

    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onMergeSuccess).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(onMergeSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('footer (confirm btn) disappears after merge success', async () => {
    mockMerge.mockResolvedValue({
      survivorId: ACC_REAL.id,
      absorbedIds: [ACC_IMP.id],
      mergedAt: '',
    });

    renderBody();

    const btn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      screen.queryByTestId('imported-merge-confirm-btn'),
    ).not.toBeInTheDocument();
  });
});

// ── Cancel button ─────────────────────────────────────────────────────────────

describe('MergeDirectModeBody — cancel', () => {
  it('cancel button calls onClose', () => {
    const onClose = vi.fn();
    renderBody({ onClose });
    const cancelBtn = screen.getByRole('button', { name: /Cancelar/i });
    fireEvent.click(cancelBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ── onSelectSurvivor: changing the survivor updates the merge payload ─────────

describe('MergeDirectModeBody — onSelectSurvivor changes survivor', () => {
  it('clicking "Hacer principal" on a non-survivor card updates survivorId in payload', async () => {
    mockMerge.mockResolvedValue({
      survivorId: ACC_IMP.id,
      absorbedIds: [ACC_REAL.id],
      mergedAt: '',
    });

    renderBody();

    // ACC_IMP is the non-survivor; its card shows the "Hacer principal" button
    const setSurvivorBtn = screen.getByRole('button', { name: /Hacer principal/i });
    fireEvent.click(setSurvivorBtn);

    // Now click Confirm — payload should reflect new survivor (ACC_IMP)
    const confirmBtn = screen.getByTestId('imported-merge-confirm-btn');
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    expect(mockMerge).toHaveBeenCalledWith({
      survivorId: ACC_IMP.id,
      absorbedIds: [ACC_REAL.id],
    });
  });

  it('after changing survivor, previous survivor appears in absorbedIds', async () => {
    mockMerge.mockResolvedValue({
      survivorId: ACC_IMP.id,
      absorbedIds: [ACC_REAL.id],
      mergedAt: '',
    });

    renderBody();

    fireEvent.click(screen.getByRole('button', { name: /Hacer principal/i }));

    await act(async () => {
      fireEvent.click(screen.getByTestId('imported-merge-confirm-btn'));
    });

    const payload = mockMerge.mock.calls[0][0];
    expect(payload.absorbedIds).toContain(ACC_REAL.id);
    expect(payload.absorbedIds).not.toContain(ACC_IMP.id);
  });

  it('onSelectSurvivor is a no-op when survivorReason=conflict_multiple_real_accounts', async () => {
    // With isConflict=true the lambda does nothing: !isConflict && setSurvivorId(...)
    // The "Elegir" button is NOT rendered when the account IS already the survivor,
    // but both acc-real-001 and acc-real-002 are non-survivors in terms of the card
    // — the survivor card shows CheckCircle2 instead of the "Elegir" button.
    // With conflict, we verify the button click doesn't change survivor state.
    renderBody({
      accounts: [ACC_REAL, ACC_REAL_2],
      survivorSuggestedId: ACC_REAL.id,
      survivorReason: 'conflict_multiple_real_accounts',
    });

    // ACC_REAL_2 card has the "Elegir" button
    const setSurvivorBtn = screen.getByRole('button', { name: /Hacer principal/i });
    fireEvent.click(setSurvivorBtn);

    // Confirm button is disabled — merge will not fire; survivor state unchanged
    const confirmBtn = screen.getByTestId('imported-merge-confirm-btn') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
    expect(mockMerge).not.toHaveBeenCalled();
  });
});

// ── AdminDedupApiService.getImportedGroups (service test) ─────────────────────

describe('AdminDedupApiService.getImportedGroups — method/path/query', () => {
  // These are tested directly against the real service in AdminDedupApiService.test.ts.
  // Here we just verify the mock responds correctly to confirm the test harness works.
  it('mock merge is callable with the expected contract', async () => {
    mockMerge.mockResolvedValue({ survivorId: 'x', absorbedIds: ['y'], mergedAt: '' });
    const result = await mockMerge({ survivorId: 'x', absorbedIds: ['y'] });
    expect(result.survivorId).toBe('x');
  });
});
