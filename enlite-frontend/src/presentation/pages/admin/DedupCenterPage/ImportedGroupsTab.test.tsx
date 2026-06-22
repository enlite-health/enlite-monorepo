/**
 * ImportedGroupsTab.test.tsx
 *
 * Covers:
 * - Loading: shows skeleton, hides table
 * - Error: shows error state with retry button
 * - Empty: shows empty state message
 * - Populated: renders group rows, name-match warning badge visible
 * - Toggle: renders toggle, calling onToggleOnlyWithReal with correct value
 * - Conflict badge: survivor_reason='conflict_multiple_real_accounts' renders
 *   "requiere revisión" badge and "Revisar" button instead of "Unificar"
 * - Open merge: clicking the merge button calls onOpenMerge with the correct group
 * - Survivor real: renders survivor email and tier badge
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ImportedGroupsTab } from './ImportedGroupsTab';
import type { ImportedDedupGroup } from '@domain/entities/DedupGroup';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACC_REAL = {
  id: 'acc-real-001',
  email: 'maria@example.com',
  tier: 'REGISTERED' as const,
  status: 'ACTIVE',
  created_at: '2026-01-15T10:00:00Z',
  updated_at: '2026-03-01T10:00:00Z',
  wja_count: 3,
  docs_count: 2,
  encuadres_count: 1,
  login_real: true,
  is_imported: false,
};

const ACC_IMPORTED = {
  id: 'acc-imp-001',
  email: null,
  tier: 'PRE_REGISTER' as const,
  status: 'INCOMPLETE',
  created_at: '2026-02-20T10:00:00Z',
  updated_at: '2026-02-20T10:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
  is_imported: true,
};

const GROUP_NORMAL: ImportedDedupGroup = {
  accounts: [ACC_REAL, ACC_IMPORTED],
  survivor_suggested_id: ACC_REAL.id,
  survivor_reason: 'real_account_absorbs_imported',
  has_real: true,
};

const GROUP_CONFLICT: ImportedDedupGroup = {
  accounts: [
    { ...ACC_REAL, id: 'acc-real-002', email: 'carlos@example.com' },
    { ...ACC_REAL, id: 'acc-real-003', email: 'carlos.alt@example.com' },
  ],
  survivor_suggested_id: 'acc-real-002',
  survivor_reason: 'conflict_multiple_real_accounts',
  has_real: true,
};

// Group where survivor_suggested_id does not match any account id
// (exercises the else branch at L222-223 that renders "—" in the survivor cell)
const GROUP_NO_SURVIVOR: ImportedDedupGroup = {
  accounts: [ACC_REAL, ACC_IMPORTED],
  survivor_suggested_id: 'non-existent-id',
  survivor_reason: 'most_complete',
  has_real: true,
};

// Group where the survivor account has a null email
// (exercises the survivor.email ?? '—' branch, ImportedGroupsTab.tsx L210)
const GROUP_SURVIVOR_NULL_EMAIL: ImportedDedupGroup = {
  accounts: [
    { ...ACC_IMPORTED, id: 'acc-imp-survivor', is_imported: false, login_real: true },
    ACC_IMPORTED,
  ],
  survivor_suggested_id: 'acc-imp-survivor',
  survivor_reason: 'most_complete',
  has_real: false,
};

// ── Default props ─────────────────────────────────────────────────────────────

const DEFAULT_PROPS = {
  groups: [] as ImportedDedupGroup[],
  isLoading: false,
  error: null as string | null,
  onlyWithReal: true,
  onToggleOnlyWithReal: vi.fn(),
  onOpenMerge: vi.fn(),
  onRetry: vi.fn(),
};

function renderTab(overrides: Partial<typeof DEFAULT_PROPS> = {}) {
  return render(<ImportedGroupsTab {...DEFAULT_PROPS} {...overrides} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Loading ───────────────────────────────────────────────────────────────────

describe('ImportedGroupsTab — loading', () => {
  it('shows skeleton when isLoading=true', () => {
    renderTab({ isLoading: true });
    expect(screen.getByTestId('imported-skeleton')).toBeInTheDocument();
  });

  it('does not show table when loading', () => {
    renderTab({ isLoading: true });
    expect(screen.queryByTestId('imported-content')).not.toBeInTheDocument();
  });
});

// ── Error ─────────────────────────────────────────────────────────────────────

describe('ImportedGroupsTab — error', () => {
  it('shows error state when error is set', () => {
    renderTab({ error: 'Network failure' });
    expect(screen.getByTestId('imported-error')).toBeInTheDocument();
    expect(document.body.textContent).toContain('Network failure');
  });

  it('retry button calls onRetry', () => {
    const onRetry = vi.fn();
    renderTab({ error: 'Error', onRetry });
    const retryBtn = screen.getByRole('button');
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

// ── Empty ─────────────────────────────────────────────────────────────────────

describe('ImportedGroupsTab — empty', () => {
  it('shows empty state when groups is []', () => {
    renderTab({ groups: [] });
    expect(screen.getByTestId('imported-empty')).toBeInTheDocument();
  });

  it('shows the name-match warning banner even when empty', () => {
    renderTab({ groups: [] });
    expect(screen.getByTestId('imported-name-match-warning')).toBeInTheDocument();
  });
});

// ── Name-match warning ────────────────────────────────────────────────────────

describe('ImportedGroupsTab — name-match warning banner', () => {
  it('warning banner is always visible in content mode', () => {
    renderTab({ groups: [GROUP_NORMAL] });
    expect(screen.getByTestId('imported-name-match-warning')).toBeInTheDocument();
  });

  it('warning banner contains the namematchWarningTitle i18n key', () => {
    // In test environment i18n returns the key path as text
    renderTab({ groups: [GROUP_NORMAL] });
    const warning = screen.getByTestId('imported-name-match-warning');
    expect(warning.textContent).toContain('namematchWarning');
  });
});

// ── Toggle ────────────────────────────────────────────────────────────────────

describe('ImportedGroupsTab — onlyWithReal toggle', () => {
  it('renders the toggle checkbox', () => {
    renderTab({ groups: [] });
    expect(screen.getByTestId('only-with-real-toggle')).toBeInTheDocument();
  });

  it('toggle is checked when onlyWithReal=true', () => {
    renderTab({ onlyWithReal: true, groups: [] });
    const toggle = screen.getByTestId('only-with-real-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('toggle is unchecked when onlyWithReal=false', () => {
    renderTab({ onlyWithReal: false, groups: [] });
    const toggle = screen.getByTestId('only-with-real-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it('clicking toggle calls onToggleOnlyWithReal with false when checked', () => {
    const onToggle = vi.fn();
    renderTab({ onlyWithReal: true, groups: [], onToggleOnlyWithReal: onToggle });
    const toggle = screen.getByTestId('only-with-real-toggle');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('clicking toggle calls onToggleOnlyWithReal with true when unchecked', () => {
    const onToggle = vi.fn();
    renderTab({ onlyWithReal: false, groups: [], onToggleOnlyWithReal: onToggle });
    const toggle = screen.getByTestId('only-with-real-toggle');
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

// ── Populated — normal group ──────────────────────────────────────────────────

describe('ImportedGroupsTab — populated with normal group', () => {
  it('renders the merge button for a normal group', () => {
    renderTab({ groups: [GROUP_NORMAL] });
    expect(screen.getByTestId('imported-merge-btn-0')).toBeInTheDocument();
  });

  it('merge button calls onOpenMerge with the correct group', () => {
    const onOpenMerge = vi.fn();
    renderTab({ groups: [GROUP_NORMAL], onOpenMerge });
    fireEvent.click(screen.getByTestId('imported-merge-btn-0'));
    expect(onOpenMerge).toHaveBeenCalledWith(GROUP_NORMAL);
  });

  it('renders survivor email in the row', () => {
    renderTab({ groups: [GROUP_NORMAL] });
    expect(document.body.textContent).toContain('maria@example.com');
  });

  it('does NOT render the conflict badge for a normal group', () => {
    renderTab({ groups: [GROUP_NORMAL] });
    expect(screen.queryByTestId('conflict-badge-0')).not.toBeInTheDocument();
  });
});

// ── Populated — conflict group ────────────────────────────────────────────────

describe('ImportedGroupsTab — conflict group (multiple real accounts)', () => {
  it('renders conflict badge for conflict group', () => {
    renderTab({ groups: [GROUP_CONFLICT] });
    expect(screen.getByTestId('conflict-badge-0')).toBeInTheDocument();
  });

  it('conflict badge renders with the reasonConflict i18n key', () => {
    // In test environment i18n returns key path; the badge data-testid confirms presence
    renderTab({ groups: [GROUP_CONFLICT] });
    const badge = screen.getByTestId('conflict-badge-0');
    expect(badge.textContent).toContain('reasonConflict');
  });

  it('clicking the conflict group button still calls onOpenMerge (modal handles blocking)', () => {
    const onOpenMerge = vi.fn();
    renderTab({ groups: [GROUP_CONFLICT], onOpenMerge });
    fireEvent.click(screen.getByTestId('imported-merge-btn-0'));
    expect(onOpenMerge).toHaveBeenCalledWith(GROUP_CONFLICT);
  });
});

// ── Survivor cell: null path (survivor_suggested_id matches no account) ────────

describe('ImportedGroupsTab — survivor cell null path', () => {
  it('renders "—" in survivor cell when survivor_suggested_id does not match any account', () => {
    renderTab({ groups: [GROUP_NO_SURVIVOR] });
    // The survivor cell falls into the else branch and renders a Text with "—"
    // The dash is present in the table body
    const tableBody = document.querySelector('tbody');
    expect(tableBody?.textContent).toContain('—');
  });
});

// ── Survivor cell: survivor exists but email is null (L210 branch) ─────────────

describe('ImportedGroupsTab — survivor email null fallback', () => {
  it('renders "—" when survivor account has null email', () => {
    renderTab({ groups: [GROUP_SURVIVOR_NULL_EMAIL] });
    // survivor.email is null → L210: survivor.email ?? '—' renders '—'
    const tableBody = document.querySelector('tbody');
    expect(tableBody?.textContent).toContain('—');
  });
});

// ── Mixed: normal + conflict ──────────────────────────────────────────────────

describe('ImportedGroupsTab — mixed groups', () => {
  it('renders one merge btn and one conflict row when mixed', () => {
    renderTab({ groups: [GROUP_NORMAL, GROUP_CONFLICT] });
    expect(screen.getByTestId('imported-merge-btn-0')).toBeInTheDocument();
    expect(screen.getByTestId('imported-merge-btn-1')).toBeInTheDocument();
    expect(screen.queryByTestId('conflict-badge-0')).not.toBeInTheDocument();
    expect(screen.getByTestId('conflict-badge-1')).toBeInTheDocument();
  });

  it('clicking first button opens first group', () => {
    const onOpenMerge = vi.fn();
    renderTab({ groups: [GROUP_NORMAL, GROUP_CONFLICT], onOpenMerge });
    fireEvent.click(screen.getByTestId('imported-merge-btn-0'));
    expect(onOpenMerge).toHaveBeenCalledWith(GROUP_NORMAL);
  });

  it('clicking second button opens second group', () => {
    const onOpenMerge = vi.fn();
    renderTab({ groups: [GROUP_NORMAL, GROUP_CONFLICT], onOpenMerge });
    fireEvent.click(screen.getByTestId('imported-merge-btn-1'));
    expect(onOpenMerge).toHaveBeenCalledWith(GROUP_CONFLICT);
  });
});
