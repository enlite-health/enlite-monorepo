/**
 * MergePhoneModeBody.test.tsx
 *
 * Covers:
 * - Renders LoadingSkeleton while loading
 * - Renders error state with retry button
 * - Renders account cards when detail loaded
 * - Renders reparent_preview badges
 * - Renders MergeAdvancedFields when conflicts present
 * - Footer hidden during loading and shown when detail available
 * - Layout / scroll structure: root flex-1 min-h-0, scrollable area
 *   overflow-y-auto min-h-0, footer shrink-0 — regression guard for the
 *   bug where 9 Advanced conflicts pushed footer out of max-h-[90vh].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MergePhoneModeBody } from './MergePhoneModeBody';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

vi.mock('@hooks/admin/useDedupGroupDetail', () => ({
  useDedupGroupDetail: vi.fn(),
}));

import { useDedupGroupDetail } from '@hooks/admin/useDedupGroupDetail';
const mockUse = vi.mocked(useDedupGroupDetail);

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ACC_A = {
  id: 'acc-ph-001',
  email: 'ana@example.com',
  tier: 'REGISTERED' as const,
  status: 'ACTIVE' as const,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  wja_count: 2,
  docs_count: 1,
  encuadres_count: 0,
  login_real: true,
};

const ACC_B = {
  id: 'acc-ph-002',
  email: null,
  tier: 'INCOMPLETE_REGISTER' as const,
  status: 'INCOMPLETE' as const,
  created_at: '2026-02-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
  wja_count: 0,
  docs_count: 0,
  encuadres_count: 0,
  login_real: false,
};

const MOCK_DETAIL = {
  phone_normalized: '+5491100000001',
  accounts: [ACC_A, ACC_B],
  survivor_suggested: ACC_A.id,
  field_comparisons: [
    {
      field: 'email',
      values: { [ACC_A.id]: 'ana@example.com', [ACC_B.id]: null },
      is_encrypted: false,
      has_conflict: true,
    },
  ],
  reparent_preview: [{ entity: 'worker_job_applications', count: 2 }],
};

const LOADING_STATE = {
  detail: null as null,
  isLoading: true,
  error: null,
  refetch: vi.fn(),
  isMerging: false,
  mergeError: null,
  merge: vi.fn(),
  dismiss: vi.fn(),
  dismissError: null,
  isDismissing: false,
};

const LOADED_STATE = {
  ...LOADING_STATE,
  detail: MOCK_DETAIL,
  isLoading: false,
};

const ERROR_STATE = {
  ...LOADING_STATE,
  isLoading: false,
  error: 'Error de red',
};

const DEFAULT_PROPS = {
  phoneNormalized: '+5491100000001',
  onClose: vi.fn(),
  onMergeSuccess: vi.fn(),
};

function renderBody() {
  return render(<MergePhoneModeBody {...DEFAULT_PROPS} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUse.mockReturnValue(LOADED_STATE);
});

// ── Loading state ─────────────────────────────────────────────────────────────

describe('MergePhoneModeBody — loading state', () => {
  it('renders LoadingSkeleton while isLoading=true', () => {
    mockUse.mockReturnValue(LOADING_STATE);
    const { container } = renderBody();
    // Skeleton is an animated-pulse div — no confirm button
    expect(screen.queryByRole('button', { name: /Confirmar/i })).not.toBeInTheDocument();
    // Skeleton has animate-pulse class
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
  });
});

// ── Error state ───────────────────────────────────────────────────────────────

describe('MergePhoneModeBody — error state', () => {
  it('shows error text and retry button when error is set', () => {
    mockUse.mockReturnValue(ERROR_STATE);
    renderBody();
    expect(screen.getByText('Error de red')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reintentar/i })).toBeInTheDocument();
  });
});

// ── Loaded state ──────────────────────────────────────────────────────────────

describe('MergePhoneModeBody — loaded state', () => {
  it('renders account cards for each account', () => {
    renderBody();
    expect(screen.getByTestId(`merge-account-card-${ACC_A.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`merge-account-card-${ACC_B.id}`)).toBeInTheDocument();
  });

  it('renders reparent_preview badges', () => {
    renderBody();
    expect(screen.getByText(/Se van a reasignar/i)).toBeInTheDocument();
    expect(screen.getByText(/worker_job_applications/i)).toBeInTheDocument();
  });

  it('renders Avanzado toggle when field conflicts exist', () => {
    const { container } = renderBody();
    // The toggle button has aria-expanded attribute
    const advancedToggle = container.querySelector('button[aria-expanded]');
    expect(advancedToggle).not.toBeNull();
  });

  it('renders footer with Confirmar button when detail loaded', () => {
    renderBody();
    expect(
      screen.getByRole('button', { name: /Confirmar unificación/i }),
    ).toBeInTheDocument();
  });

  it('footer hidden during loading (no Confirmar button)', () => {
    mockUse.mockReturnValue(LOADING_STATE);
    renderBody();
    expect(
      screen.queryByRole('button', { name: /Confirmar unificación/i }),
    ).not.toBeInTheDocument();
  });
});

// ── Layout / scroll structure ─────────────────────────────────────────────────
// Regression guard for the bug where many Advanced conflicts pushed content
// beyond max-h-[90vh] with no scrollbar, cutting off the footer.

describe('MergePhoneModeBody — scroll layout structure', () => {
  it('root element has flex-1 and min-h-0 classes (allows shrink in flex parent)', () => {
    const { container } = renderBody();
    const root = container.firstElementChild as HTMLElement;
    expect(root.tagName).toBe('DIV');
    expect(root.classList.contains('flex-1')).toBe(true);
    expect(root.classList.contains('min-h-0')).toBe(true);
  });

  it('scrollable area has overflow-y-auto and min-h-0 classes', () => {
    const { container } = renderBody();
    const scrollArea = container.querySelector('.overflow-y-auto') as HTMLElement;
    expect(scrollArea).not.toBeNull();
    expect(scrollArea.classList.contains('min-h-0')).toBe(true);
    expect(scrollArea.classList.contains('flex-1')).toBe(true);
  });

  it('footer wrapper has shrink-0 class (stays visible below scrollable area)', () => {
    const { container } = renderBody();
    // The footer is the last element in the root div — contains the action buttons
    const footerCandidates = container.querySelectorAll('.shrink-0');
    // At least one shrink-0 element must be the footer (has border-t class)
    const footer = Array.from(footerCandidates).find(
      (el) => el.classList.contains('border-t'),
    ) as HTMLElement | undefined;
    expect(footer).not.toBeUndefined();
  });
});
