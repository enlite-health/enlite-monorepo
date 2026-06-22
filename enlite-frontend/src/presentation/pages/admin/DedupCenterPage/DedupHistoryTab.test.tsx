/**
 * DedupHistoryTab.test.tsx
 *
 * Covers:
 * - Loading state: skeleton rendered
 * - Error state: error container + retry button calls onRetry
 * - Empty state: empty container visible
 * - Table renders rows for each history item
 * - "Deshacer" button only appears when can_undo=true
 * - Clicking "Deshacer" calls onUndo with correct auditId and phone
 * - Category rendered via i18n key (t('admin.dedup.history.category.X'))
 * - Date rendered via toLocaleString es-AR
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DedupHistoryTab } from './DedupHistoryTab';
import type { MergeHistoryItem } from '@domain/entities/DedupGroup';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ITEM_UNDOABLE: MergeHistoryItem = {
  auditId: 'audit-001',
  survivorId: 'acc-survivor-001',
  absorbedId: 'acc-absorbed-002',
  phone_normalized: '+5491112345678',
  category: 'phone_duplicate',
  created_at: '2026-06-22T10:00:00Z',
  can_undo: true,
};

const ITEM_NOT_UNDOABLE: MergeHistoryItem = {
  auditId: 'audit-002',
  survivorId: 'acc-survivor-003',
  absorbedId: 'acc-absorbed-004',
  phone_normalized: '+5491187654321',
  category: 'manual',
  created_at: '2026-06-21T08:00:00Z',
  can_undo: false,
};

// ── Helper ────────────────────────────────────────────────────────────────────

interface TabProps {
  history?: MergeHistoryItem[];
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onUndo?: (auditId: string, phone: string) => void;
}

function renderTab({
  history = [ITEM_UNDOABLE, ITEM_NOT_UNDOABLE],
  isLoading = false,
  error = null,
  onRetry = vi.fn(),
  onUndo = vi.fn(),
}: TabProps = {}) {
  return render(
    <DedupHistoryTab
      history={history}
      isLoading={isLoading}
      error={error}
      onRetry={onRetry}
      onUndo={onUndo}
    />,
  );
}

// ── Loading state ─────────────────────────────────────────────────────────────

describe('DedupHistoryTab — loading', () => {
  it('renders skeleton when isLoading=true', () => {
    renderTab({ isLoading: true });
    expect(screen.getByTestId('history-skeleton')).toBeInTheDocument();
  });

  it('does not render table or error when loading', () => {
    renderTab({ isLoading: true });
    expect(screen.queryByTestId('history-table-container')).not.toBeInTheDocument();
    expect(screen.queryByTestId('history-error')).not.toBeInTheDocument();
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('DedupHistoryTab — error', () => {
  it('renders error container when error is set', () => {
    renderTab({ isLoading: false, error: 'Something went wrong' });
    expect(screen.getByTestId('history-error')).toBeInTheDocument();
  });

  it('calls onRetry when retry button is clicked', () => {
    const onRetry = vi.fn();
    renderTab({ isLoading: false, error: 'Something went wrong', onRetry });
    const retryBtn = screen.getByRole('button');
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not render table when error is set', () => {
    renderTab({ isLoading: false, error: 'Something went wrong' });
    expect(screen.queryByTestId('history-table-container')).not.toBeInTheDocument();
  });
});

// ── Empty state ───────────────────────────────────────────────────────────────

describe('DedupHistoryTab — empty', () => {
  it('renders empty state when history is []', () => {
    renderTab({ history: [] });
    expect(screen.getByTestId('history-empty')).toBeInTheDocument();
  });

  it('does not render table when empty', () => {
    renderTab({ history: [] });
    expect(screen.queryByTestId('history-table-container')).not.toBeInTheDocument();
  });
});

// ── Table renders rows ────────────────────────────────────────────────────────

describe('DedupHistoryTab — table rows', () => {
  it('renders table container when there are items', () => {
    renderTab();
    expect(screen.getByTestId('history-table-container')).toBeInTheDocument();
  });

  it('renders phone number for each row', () => {
    renderTab();
    expect(screen.getByText(ITEM_UNDOABLE.phone_normalized)).toBeInTheDocument();
    expect(screen.getByText(ITEM_NOT_UNDOABLE.phone_normalized)).toBeInTheDocument();
  });

  it('renders survivorId and absorbedId for each row', () => {
    renderTab();
    expect(screen.getByText(ITEM_UNDOABLE.survivorId)).toBeInTheDocument();
    expect(screen.getByText(ITEM_UNDOABLE.absorbedId)).toBeInTheDocument();
  });
});

// ── Deshacer button visibility ────────────────────────────────────────────────

describe('DedupHistoryTab — Deshacer button', () => {
  it('renders Deshacer button only for can_undo=true item', () => {
    renderTab();
    // Only one item has can_undo=true, so only one undo button
    const undoBtns = screen.getAllByTestId(/^undo-btn-/);
    expect(undoBtns).toHaveLength(1);
    expect(undoBtns[0].getAttribute('data-testid')).toBe(
      `undo-btn-${ITEM_UNDOABLE.auditId}`,
    );
  });

  it('does NOT render Deshacer button for can_undo=false item', () => {
    renderTab();
    expect(
      screen.queryByTestId(`undo-btn-${ITEM_NOT_UNDOABLE.auditId}`),
    ).not.toBeInTheDocument();
  });

  it('clicking Deshacer calls onUndo with correct auditId and phone', () => {
    const onUndo = vi.fn();
    renderTab({ onUndo });

    const undoBtn = screen.getByTestId(`undo-btn-${ITEM_UNDOABLE.auditId}`);
    fireEvent.click(undoBtn);

    expect(onUndo).toHaveBeenCalledWith(
      ITEM_UNDOABLE.auditId,
      ITEM_UNDOABLE.phone_normalized,
    );
    expect(onUndo).toHaveBeenCalledTimes(1);
  });
});

// ── Category via i18n ─────────────────────────────────────────────────────────

describe('DedupHistoryTab — category i18n', () => {
  it('renders category value for phone_duplicate (via defaultValue fallback)', () => {
    renderTab({ history: [ITEM_UNDOABLE] });
    // Test env has no translations; t(key, { defaultValue: item.category })
    // returns item.category = 'phone_duplicate'
    expect(screen.getByText('phone_duplicate')).toBeInTheDocument();
  });

  it('renders category value for manual (via defaultValue fallback)', () => {
    renderTab({ history: [ITEM_NOT_UNDOABLE] });
    // defaultValue = 'manual'
    expect(screen.getByText('manual')).toBeInTheDocument();
  });
});

// ── Date formatting ───────────────────────────────────────────────────────────

describe('DedupHistoryTab — date column', () => {
  it('renders a formatted date string for each row', () => {
    renderTab({ history: [ITEM_UNDOABLE] });
    // toLocaleString('es-AR') produces something non-empty; we just verify it's there
    const expected = new Date(ITEM_UNDOABLE.created_at).toLocaleString('es-AR', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});
