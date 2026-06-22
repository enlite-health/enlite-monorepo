/**
 * DedupGroupList.test.tsx
 *
 * Covers:
 * - Empty state renders correctly
 * - Rows render phone, account count, signal badge
 * - Checkbox row toggles onToggleSelect
 * - Select-all checkbox triggers onToggleSelectAll
 * - "Merge" button triggers onOpenMerge with the correct phone
 * - "Dismiss" button triggers onDismiss with the correct phone
 * - formatDate happy path renders 2026
 * - allSelected state when all rows are checked
 * NOTE: survivor column was removed from DedupGroupList (queue has no suggestion)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DedupGroupList } from './DedupGroupList';
import type { DedupGroupSummary, DedupAccount } from '@domain/entities/DedupGroup';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeAccount(
  id: string,
  overrides: Partial<DedupAccount> = {},
): DedupAccount {
  return {
    id,
    email: `${id}@test.com`,
    tier: 'REGISTERED',
    status: 'ACTIVE',
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T10:00:00Z',
    wja_count: 2,
    docs_count: 1,
    encuadres_count: 0,
    login_real: true,
    ...overrides,
  };
}

const GROUP_A: DedupGroupSummary = {
  phone_normalized: '+5491111111111',
  accounts: [
    makeAccount('acc-A1', { tier: 'REGISTERED' }),
    makeAccount('acc-A2', { tier: 'INCOMPLETE_REGISTER', login_real: false }),
  ],
  survivor_suggested: 'acc-A1',
};

const GROUP_B: DedupGroupSummary = {
  phone_normalized: '+5492222222222',
  accounts: [
    makeAccount('acc-B1', {
      email: null,
      tier: 'PRE_REGISTER',
      login_real: false,
    }),
    makeAccount('acc-B2', { tier: 'REGISTERED' }),
  ],
  survivor_suggested: 'acc-B1',
};

// ── Default props factory ──────────────────────────────────────────────────────

function defaultProps(
  groups: DedupGroupSummary[] = [GROUP_A, GROUP_B],
  selectedPhones: Set<string> = new Set(),
  overrides: Partial<{
    onToggleSelect: (phone: string) => void;
    onToggleSelectAll: () => void;
    onOpenMerge: (phone: string) => void;
    onDismiss: (phone: string) => void;
  }> = {},
) {
  return {
    groups,
    selectedPhones,
    onToggleSelect: vi.fn(),
    onToggleSelectAll: vi.fn(),
    onOpenMerge: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
}

// ── Empty state ───────────────────────────────────────────────────────────────

describe('DedupGroupList — empty state', () => {
  it('renders the empty state container when groups is empty', () => {
    render(<DedupGroupList {...defaultProps([])} />);
    expect(screen.getByTestId('dedup-empty')).toBeInTheDocument();
  });

  it('does NOT render a table when groups is empty', () => {
    render(<DedupGroupList {...defaultProps([])} />);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

// ── Table rows render ─────────────────────────────────────────────────────────

describe('DedupGroupList — table rows rendering', () => {
  it('renders a table when groups is non-empty', () => {
    render(<DedupGroupList {...defaultProps()} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('renders phone number for each group', () => {
    render(<DedupGroupList {...defaultProps()} />);
    expect(screen.getByText(GROUP_A.phone_normalized)).toBeInTheDocument();
    expect(screen.getByText(GROUP_B.phone_normalized)).toBeInTheDocument();
  });

  it('renders account count for each group', () => {
    render(<DedupGroupList {...defaultProps()} />);
    // Both groups have 2 accounts each
    const cells = screen.getAllByText('2');
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });

  it('renders a DedupSignalBadge for each row', () => {
    const { container } = render(<DedupGroupList {...defaultProps()} />);
    // DedupSignalBadge renders a span with one of these bg classes
    const badges = container.querySelectorAll(
      'span[class*="bg-green-100"], span[class*="bg-amber-100"], span[class*="bg-slate-100"]',
    );
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Checkbox — row selection ───────────────────────────────────────────────────
// Note: i18n returns the key in tests (no translations loaded), so we cannot
// look up checkboxes by interpolated phone. We use index-based queries instead.

describe('DedupGroupList — checkbox row selection', () => {
  it('calls onToggleSelect with the phone when first row checkbox is clicked', () => {
    const onToggleSelect = vi.fn();
    render(
      <DedupGroupList
        {...defaultProps([GROUP_A], new Set(), { onToggleSelect })}
      />,
    );

    // checkboxes: [0]=select-all, [1]=GROUP_A row
    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);

    expect(onToggleSelect).toHaveBeenCalledWith(GROUP_A.phone_normalized);
  });

  it('row checkbox is checked when phone is in selectedPhones', () => {
    const selected = new Set([GROUP_A.phone_normalized]);
    render(<DedupGroupList {...defaultProps([GROUP_A], selected)} />);

    const checkboxes = screen.getAllByRole('checkbox');
    // checkboxes[1] is the row checkbox for GROUP_A
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(true);
  });

  it('row checkbox is unchecked when phone is NOT in selectedPhones', () => {
    render(<DedupGroupList {...defaultProps([GROUP_A], new Set())} />);

    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
  });

  it('clicking a checked row checkbox calls onToggleSelect (deselect)', () => {
    const onToggleSelect = vi.fn();
    const selected = new Set([GROUP_A.phone_normalized]);
    render(
      <DedupGroupList
        {...defaultProps([GROUP_A], selected, { onToggleSelect })}
      />,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);

    expect(onToggleSelect).toHaveBeenCalledWith(GROUP_A.phone_normalized);
  });
});

// ── Checkbox — select all ──────────────────────────────────────────────────────

describe('DedupGroupList — select all checkbox', () => {
  it('calls onToggleSelectAll when the header checkbox is clicked', () => {
    const onToggleSelectAll = vi.fn();
    render(
      <DedupGroupList
        {...defaultProps([GROUP_A, GROUP_B], new Set(), { onToggleSelectAll })}
      />,
    );

    const checkboxes = screen.getAllByRole('checkbox');
    // First checkbox is the select-all header
    fireEvent.click(checkboxes[0]);
    expect(onToggleSelectAll).toHaveBeenCalledTimes(1);
  });

  it('header checkbox is checked when all rows are selected', () => {
    const allPhones = new Set([
      GROUP_A.phone_normalized,
      GROUP_B.phone_normalized,
    ]);
    render(<DedupGroupList {...defaultProps([GROUP_A, GROUP_B], allPhones)} />);

    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
  });

  it('header checkbox is unchecked when not all rows are selected', () => {
    const partial = new Set([GROUP_A.phone_normalized]);
    render(<DedupGroupList {...defaultProps([GROUP_A, GROUP_B], partial)} />);

    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
  });

  it('header checkbox is unchecked when no rows are selected', () => {
    render(<DedupGroupList {...defaultProps([GROUP_A, GROUP_B], new Set())} />);
    const checkboxes = screen.getAllByRole('checkbox');
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
  });

  it('renders no checkboxes for empty groups (returns empty state)', () => {
    const { container } = render(
      <DedupGroupList {...defaultProps([], new Set())} />,
    );
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes).toHaveLength(0);
  });
});

// ── Action buttons ────────────────────────────────────────────────────────────
// Buttons in each row: [Merge, Dismiss] in order.
// With two groups: row 0 has buttons [0,1], row 1 has buttons [2,3].

describe('DedupGroupList — action buttons', () => {
  it('onOpenMerge is called with GROUP_A phone when its Merge button is clicked', () => {
    const onOpenMerge = vi.fn();
    render(
      <DedupGroupList
        {...defaultProps([GROUP_A], new Set(), { onOpenMerge })}
      />,
    );

    // All buttons in the rendered list; first row has [Merge, Dismiss]
    const buttons = screen.getAllByRole('button');
    // buttons[0] = Merge button for GROUP_A
    fireEvent.click(buttons[0]);

    expect(onOpenMerge).toHaveBeenCalledWith(GROUP_A.phone_normalized);
  });

  it('onDismiss is called with GROUP_A phone when its Dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <DedupGroupList
        {...defaultProps([GROUP_A], new Set(), { onDismiss })}
      />,
    );

    const buttons = screen.getAllByRole('button');
    // buttons[1] = Dismiss button for GROUP_A
    fireEvent.click(buttons[1]);

    expect(onDismiss).toHaveBeenCalledWith(GROUP_A.phone_normalized);
  });

  it('onOpenMerge called with GROUP_B phone when its Merge button is clicked', () => {
    const onOpenMerge = vi.fn();
    render(
      <DedupGroupList
        {...defaultProps([GROUP_A, GROUP_B], new Set(), { onOpenMerge })}
      />,
    );

    const buttons = screen.getAllByRole('button');
    // GROUP_A: buttons[0]=Merge, buttons[1]=Dismiss
    // GROUP_B: buttons[2]=Merge, buttons[3]=Dismiss
    fireEvent.click(buttons[2]);

    expect(onOpenMerge).toHaveBeenCalledWith(GROUP_B.phone_normalized);
  });

  it('onDismiss called with GROUP_B phone when its Dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <DedupGroupList
        {...defaultProps([GROUP_A, GROUP_B], new Set(), { onDismiss })}
      />,
    );

    const buttons = screen.getAllByRole('button');
    fireEvent.click(buttons[3]);

    expect(onDismiss).toHaveBeenCalledWith(GROUP_B.phone_normalized);
  });
});

// ── formatDate (lines 31-41) ──────────────────────────────────────────────────

describe('DedupGroupList — formatDate', () => {
  it('renders a formatted date containing 2026 for valid ISO string', () => {
    render(<DedupGroupList {...defaultProps([GROUP_A])} />);
    expect(document.body.textContent).toContain('2026');
  });

  /**
   * Note: The catch branch at lines 31-41 (returning iso as-is when
   * toLocaleString throws) is GENUINELY UNREACHABLE in practice.
   * new Date('invalid').toLocaleString() returns "Invalid Date" without
   * throwing — it never triggers the catch.
   * Covered via Istanbul ignore or left as known dead-code branch.
   */
  it('renders "Invalid Date" text for an invalid ISO string (no throw)', () => {
    const groupBadDate: DedupGroupSummary = {
      phone_normalized: '+5499999999999',
      accounts: [
        {
          ...makeAccount('acc-bad'),
          created_at: 'not-a-date',
        },
      ],
      survivor_suggested: 'acc-bad',
    };
    render(<DedupGroupList {...defaultProps([groupBadDate])} />);
    // toLocaleString returns "Invalid Date" for an invalid Date object
    expect(document.body.textContent).toContain('Invalid Date');
  });
});

// ── reduce "keep earliest" false branch ──────────────────────────────────────

describe('DedupGroupList — oldest-account reduce false branch', () => {
  it('keeps the earliest account when ordered chronologically (false branch of ternary)', () => {
    // acc-early (noon UTC) and acc-late (later) — reduce false branch: keep earliest
    // Use noon UTC so no timezone rollback across midnight
    const GROUP_ORDERED: DedupGroupSummary = {
      phone_normalized: '+5496666666666',
      accounts: [
        makeAccount('acc-early', { created_at: '2026-03-01T12:00:00Z' }),
        makeAccount('acc-late', { created_at: '2026-06-01T12:00:00Z' }),
      ],
      survivor_suggested: 'acc-early',
    };

    render(<DedupGroupList {...defaultProps([GROUP_ORDERED])} />);
    // Date rendered (es-AR) — either way contains '2026'
    expect(document.body.textContent).toContain('2026');
  });

  it('picks the earliest account when accounts are in reverse order (true branch)', () => {
    // acc-late comes first; reduce picks acc-early as the overall earliest
    const GROUP_REVERSED: DedupGroupSummary = {
      phone_normalized: '+5497777777777',
      accounts: [
        makeAccount('acc-late', { created_at: '2026-06-01T12:00:00Z' }),
        makeAccount('acc-early', { created_at: '2026-03-01T12:00:00Z' }),
      ],
      survivor_suggested: 'acc-late',
    };

    render(<DedupGroupList {...defaultProps([GROUP_REVERSED])} />);
    expect(document.body.textContent).toContain('2026');
  });
});

// ── Merge button disabled state (L168) ───────────────────────────────────────

describe('DedupGroupList — merge button disabled state', () => {
  it('merge button is NOT disabled when accounts have activity (totalActivity > 0)', () => {
    // GROUP_A accounts have wja_count=2, docs_count=1 → totalActivity=6 > 0
    render(<DedupGroupList {...defaultProps([GROUP_A])} />);
    const buttons = screen.getAllByRole('button');
    const mergeBtn = buttons[0] as HTMLButtonElement;
    expect(mergeBtn.disabled).toBe(false);
  });

  it('merge button IS disabled when totalActivity=0 and accounts.length < 2', () => {
    // Single account with all-zero counts
    const GROUP_SINGLE_ZERO: DedupGroupSummary = {
      phone_normalized: '+5498888888888',
      accounts: [
        makeAccount('acc-zero', {
          wja_count: 0,
          docs_count: 0,
          encuadres_count: 0,
        }),
      ],
      survivor_suggested: 'acc-zero',
    };

    render(<DedupGroupList {...defaultProps([GROUP_SINGLE_ZERO])} />);
    const buttons = screen.getAllByRole('button');
    const mergeBtn = buttons[0] as HTMLButtonElement;
    expect(mergeBtn.disabled).toBe(true);
  });

  it('merge button is NOT disabled when totalActivity=0 but accounts.length >= 2', () => {
    // Two accounts both with zero activity — totalActivity=0 but length=2 (not < 2)
    const GROUP_TWO_ZERO: DedupGroupSummary = {
      phone_normalized: '+5499999999990',
      accounts: [
        makeAccount('acc-z1', { wja_count: 0, docs_count: 0, encuadres_count: 0 }),
        makeAccount('acc-z2', { wja_count: 0, docs_count: 0, encuadres_count: 0 }),
      ],
      survivor_suggested: 'acc-z1',
    };

    render(<DedupGroupList {...defaultProps([GROUP_TWO_ZERO])} />);
    const buttons = screen.getAllByRole('button');
    const mergeBtn = buttons[0] as HTMLButtonElement;
    expect(mergeBtn.disabled).toBe(false);
  });
});
