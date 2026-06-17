/**
 * BlockedAttemptsPage.test.tsx
 *
 * Unit tests — core page states:
 * - Loading skeleton
 * - Populated (aggregates, table, i18n, badges)
 * - Empty state
 * - Error state + retry
 * - Unknown worker/vacancy resolution branches
 * - Aggregate bar unknown-reason fallback
 * - Refresh button
 *
 * See BlockedAttemptsPage.pagination.test.tsx for pagination + filter tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BlockedAttemptsPage } from './BlockedAttemptsPage';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.defaultValue !== undefined) return String(opts.defaultValue);
      return key;
    },
  }),
}));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const mockUseBlockedAttempts = vi.fn();

vi.mock('@hooks/admin/useBlockedAttempts', () => ({
  useBlockedAttempts: (...args: unknown[]) => mockUseBlockedAttempts(...args),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const DEFAULT_AGGREGATES = {
  totalBlocked: 42,
  byReason: { registration_incomplete: 35, worker_disabled: 5, worker_not_found: 2 },
};

const DEFAULT_PAGINATION = {
  total: 1, limit: 20, offset: 0, page: 1, totalPages: 1,
  hasNext: false, hasPrev: false,
};

const MOCK_ATTEMPT = {
  id: 'ba-0001',
  workerId: 'w-0001',
  jobPostingId: 'jp-0001',
  blockedReason: 'registration_incomplete' as const,
  missingFields: ['profession', 'worker_documents'],
  attemptCount: 3,
  firstAttemptedAt: '2026-06-01T10:00:00Z',
  lastAttemptedAt: '2026-06-15T14:30:00Z',
  acquisitionChannel: 'whatsapp',
  createdAt: '2026-06-01T10:00:00Z',
  updatedAt: '2026-06-15T14:30:00Z',
  workerName: 'Ana García',
  workerPhone: '+5491112345678',
  vacancyTitle: 'CASO 766-1',
  vacancyCaseNumber: 766,
};

const LOADING_STATE = {
  attempts: [], aggregates: DEFAULT_AGGREGATES, pagination: DEFAULT_PAGINATION,
  isLoading: true, error: null, refetch: vi.fn(),
};

const POPULATED_STATE = {
  attempts: [MOCK_ATTEMPT], aggregates: DEFAULT_AGGREGATES, pagination: DEFAULT_PAGINATION,
  isLoading: false, error: null, refetch: vi.fn(),
};

const EMPTY_STATE = {
  attempts: [], aggregates: { totalBlocked: 0, byReason: {} }, pagination: DEFAULT_PAGINATION,
  isLoading: false, error: null, refetch: vi.fn(),
};

const ERROR_STATE = {
  attempts: [], aggregates: { totalBlocked: 0, byReason: {} }, pagination: DEFAULT_PAGINATION,
  isLoading: false, error: 'Network error', refetch: vi.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function renderPage() {
  return render(<MemoryRouter><BlockedAttemptsPage /></MemoryRouter>);
}

async function renderAndWait() {
  await act(async () => { renderPage(); });
  await waitFor(
    () => expect(screen.queryByTestId('blocked-skeleton')).not.toBeInTheDocument(),
    { timeout: 5000 },
  );
}

beforeEach(() => { vi.clearAllMocks(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BlockedAttemptsPage — loading state', () => {
  it('shows skeleton while data is loading', async () => {
    mockUseBlockedAttempts.mockReturnValue(LOADING_STATE);
    await act(async () => { renderPage(); });
    expect(screen.getByTestId('blocked-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('blocked-content')).not.toBeInTheDocument();
  });
});

describe('BlockedAttemptsPage — populated state', () => {
  beforeEach(() => { mockUseBlockedAttempts.mockReturnValue(POPULATED_STATE); });

  it('renders the page title via i18n key', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('admin.blockedAttempts.title');
  });

  it('renders content area', async () => {
    await renderAndWait();
    expect(screen.getByTestId('blocked-content')).toBeInTheDocument();
  });

  it('renders aggregate total card', async () => {
    await renderAndWait();
    expect(screen.getByTestId('agg-total')).toBeInTheDocument();
    expect(document.body.textContent).toContain('42');
  });

  it('renders per-reason aggregate cards', async () => {
    await renderAndWait();
    expect(screen.getByTestId('agg-reason-registration_incomplete')).toBeInTheDocument();
    expect(document.body.textContent).toContain('35');
  });

  it('renders worker name in table', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('Ana García');
  });

  it('renders vacancy title in table', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('CASO 766-1');
  });

  it('renders reason via i18n (not raw enum)', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('registration_incomplete');
    expect(document.body.textContent).not.toMatch(/^registration_incomplete$/);
  });

  it('renders missing fields as translated badges', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('profession');
    expect(document.body.textContent).toContain('worker_documents');
  });

  it('renders attempt count', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('3');
  });

  it('worker link points to /admin/workers/:workerId', async () => {
    await renderAndWait();
    const link = screen.getAllByRole('link').find(
      (el) => el.getAttribute('href') === '/admin/workers/w-0001',
    );
    expect(link).toBeDefined();
  });

  it('vacancy link points to /admin/vacancies/:jobPostingId', async () => {
    await renderAndWait();
    const link = screen.getAllByRole('link').find(
      (el) => el.getAttribute('href') === '/admin/vacancies/jp-0001',
    );
    expect(link).toBeDefined();
  });
});

describe('BlockedAttemptsPage — missing fields edge cases', () => {
  it('renders dash when missingFields is empty', async () => {
    mockUseBlockedAttempts.mockReturnValue({
      ...POPULATED_STATE,
      attempts: [{ ...MOCK_ATTEMPT, missingFields: [] }],
    });
    await renderAndWait();
    expect(document.body.textContent).toContain('—');
  });
});

describe('BlockedAttemptsPage — unknown worker/vacancy resolution', () => {
  it('shows worker name when present', async () => {
    mockUseBlockedAttempts.mockReturnValue(POPULATED_STATE);
    await renderAndWait();
    expect(document.body.textContent).toContain('Ana García');
  });

  it('shows phone fallback when workerName is null but phone is available', async () => {
    mockUseBlockedAttempts.mockReturnValue({
      ...POPULATED_STATE,
      attempts: [{ ...MOCK_ATTEMPT, workerName: null, workerPhone: '+5491112345678' }],
    });
    await renderAndWait();
    expect(document.body.textContent).toContain('+5491112345678');
    expect(document.body.textContent).not.toContain('Ana García');
  });

  it('shows noName i18n fallback when workerName and workerPhone are both null', async () => {
    mockUseBlockedAttempts.mockReturnValue({
      ...POPULATED_STATE,
      attempts: [{ ...MOCK_ATTEMPT, workerName: null, workerPhone: null }],
    });
    await renderAndWait();
    expect(document.body.textContent).toContain('admin.blockedAttempts.table.noName');
  });

  it('worker link still present when workerName is null', async () => {
    mockUseBlockedAttempts.mockReturnValue({
      ...POPULATED_STATE,
      attempts: [{ ...MOCK_ATTEMPT, workerName: null, workerPhone: null }],
    });
    await renderAndWait();
    const link = screen.getAllByRole('link').find(
      (el) => el.getAttribute('href') === '/admin/workers/w-0001',
    );
    expect(link).toBeDefined();
  });

  it('worker link still present when only phone fallback is shown', async () => {
    mockUseBlockedAttempts.mockReturnValue({
      ...POPULATED_STATE,
      attempts: [{ ...MOCK_ATTEMPT, workerName: null, workerPhone: '+5491112345678' }],
    });
    await renderAndWait();
    const link = screen.getAllByRole('link').find(
      (el) => el.getAttribute('href') === '/admin/workers/w-0001',
    );
    expect(link).toBeDefined();
  });

  it('shows unknownVacancy when both vacancyTitle and vacancyCaseNumber are null', async () => {
    mockUseBlockedAttempts.mockReturnValue({
      ...POPULATED_STATE,
      attempts: [{ ...MOCK_ATTEMPT, vacancyTitle: null, vacancyCaseNumber: null }],
    });
    await renderAndWait();
    expect(document.body.textContent).toContain('admin.blockedAttempts.table.unknownVacancy');
  });

  it('shows "Caso #N" fallback when vacancyTitle is null but caseNumber exists', async () => {
    mockUseBlockedAttempts.mockReturnValue({
      ...POPULATED_STATE,
      attempts: [{ ...MOCK_ATTEMPT, vacancyTitle: null, vacancyCaseNumber: 999 }],
    });
    await renderAndWait();
    expect(document.body.textContent).toContain('Caso #999');
  });
});

describe('BlockedAttemptsPage — aggregate bar unknown reason', () => {
  it('renders unknown reason card with fallback color (no crash)', async () => {
    mockUseBlockedAttempts.mockReturnValue({
      ...POPULATED_STATE,
      aggregates: { totalBlocked: 10, byReason: { some_new_reason: 10 } },
    });
    await renderAndWait();
    expect(screen.getByTestId('agg-reason-some_new_reason')).toBeInTheDocument();
    expect(document.body.textContent).toContain('10');
  });
});

describe('BlockedAttemptsPage — empty state', () => {
  it('shows empty state message when no attempts', async () => {
    mockUseBlockedAttempts.mockReturnValue(EMPTY_STATE);
    await renderAndWait();
    expect(screen.getByTestId('blocked-empty')).toBeInTheDocument();
    expect(document.body.textContent).toContain('admin.blockedAttempts.noAttempts');
  });
});

describe('BlockedAttemptsPage — error state', () => {
  beforeEach(() => { mockUseBlockedAttempts.mockReturnValue(ERROR_STATE); });

  it('renders error state', async () => {
    await renderAndWait();
    expect(screen.getByTestId('blocked-error')).toBeInTheDocument();
  });

  it('shows error message', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('admin.blockedAttempts.loadError');
  });

  it('retry button triggers refetch', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mockUseBlockedAttempts.mockReturnValue({ ...ERROR_STATE, refetch });
    await renderAndWait();
    await user.click(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.retry/i }),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('BlockedAttemptsPage — refresh button', () => {
  it('calls refetch when refresh button is clicked', async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mockUseBlockedAttempts.mockReturnValue({ ...POPULATED_STATE, refetch });
    await renderAndWait();
    await user.click(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.refresh/i }),
    );
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
