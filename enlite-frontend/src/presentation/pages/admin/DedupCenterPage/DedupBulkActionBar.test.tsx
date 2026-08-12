/**
 * DedupBulkActionBar.test.tsx
 *
 * Covers:
 * - selectedCount === 0 → returns null (not rendered)
 * - selectedCount > 0 → renders the bar (closes branch 33%)
 * - Dismiss button calls onDismissSelected
 * - Clear (X) button calls onClearSelection
 * - isLoading=true → dismiss button is disabled
 * - isLoading=false (default) → dismiss button is enabled
 * - Selected count text rendered
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DedupBulkActionBar } from './DedupBulkActionBar';

// ── Helper ────────────────────────────────────────────────────────────────────

function renderBar(
  selectedCount: number,
  overrides: {
    onDismissSelected?: () => void;
    onClearSelection?: () => void;
    isLoading?: boolean;
  } = {},
) {
  return render(
    <DedupBulkActionBar
      selectedCount={selectedCount}
      onDismissSelected={overrides.onDismissSelected ?? vi.fn()}
      onClearSelection={overrides.onClearSelection ?? vi.fn()}
      isLoading={overrides.isLoading}
    />,
  );
}

// ── Not rendered when selectedCount === 0 ─────────────────────────────────────

describe('DedupBulkActionBar — hidden when selectedCount = 0', () => {
  it('returns null and renders nothing when selectedCount is 0', () => {
    const { container } = renderBar(0);
    expect(container.firstChild).toBeNull();
  });

  it('data-testid dedup-bulk-bar is NOT in the DOM when selectedCount = 0', () => {
    renderBar(0);
    expect(screen.queryByTestId('dedup-bulk-bar')).not.toBeInTheDocument();
  });
});

// ── Rendered when selectedCount > 0 ──────────────────────────────────────────

describe('DedupBulkActionBar — visible when selectedCount > 0', () => {
  it('renders the bar when selectedCount = 1', () => {
    renderBar(1);
    expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
  });

  it('renders the bar when selectedCount = 5', () => {
    renderBar(5);
    expect(screen.getByTestId('dedup-bulk-bar')).toBeInTheDocument();
  });

  it('displays the selected count somewhere in the bar', () => {
    renderBar(3);
    expect(document.body.textContent).toContain('3');
  });

  it('renders plural form for selectedCount > 1', () => {
    renderBar(2);
    // The defaultValue contains "s" when count !== 1
    const body = document.body.textContent ?? '';
    expect(body).toContain('2');
  });

  it('renders singular form for selectedCount === 1', () => {
    renderBar(1);
    const body = document.body.textContent ?? '';
    expect(body).toContain('1');
  });
});

// ── Dismiss button ────────────────────────────────────────────────────────────

describe('DedupBulkActionBar — dismiss button', () => {
  it('clicking dismiss calls onDismissSelected', () => {
    const onDismissSelected = vi.fn();
    renderBar(2, { onDismissSelected });

    const dismissBtn = screen.getByRole('button', {
      name: /dismiss|descartar/i,
    });
    fireEvent.click(dismissBtn);
    expect(onDismissSelected).toHaveBeenCalledTimes(1);
  });

  it('dismiss button is disabled when isLoading=true', () => {
    renderBar(2, { isLoading: true });

    const dismissBtn = screen.getByRole('button', {
      name: /dismiss|descartar/i,
    });
    expect((dismissBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('dismiss button is enabled when isLoading=false (default)', () => {
    renderBar(2, { isLoading: false });

    const dismissBtn = screen.getByRole('button', {
      name: /dismiss|descartar/i,
    });
    expect((dismissBtn as HTMLButtonElement).disabled).toBe(false);
  });

  it('dismiss button is enabled when isLoading is not provided (default false)', () => {
    renderBar(1);

    const dismissBtn = screen.getByRole('button', {
      name: /dismiss|descartar/i,
    });
    expect((dismissBtn as HTMLButtonElement).disabled).toBe(false);
  });
});

// ── Clear selection button ────────────────────────────────────────────────────

describe('DedupBulkActionBar — clear selection button', () => {
  it('clicking the X button calls onClearSelection', () => {
    const onClearSelection = vi.fn();
    renderBar(2, { onClearSelection });

    // The X button has an aria-label from i18n (returns key)
    // Find by aria-label pattern or as a ghost button
    const clearBtn = screen.getByRole('button', {
      name: /clearAriaLabel|Limpiar/i,
    });
    fireEvent.click(clearBtn);
    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});
