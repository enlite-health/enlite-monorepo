/**
 * BlockedAttemptsPage.pagination.test.tsx
 *
 * Unit tests — pagination controls + filter interactions:
 * - Pagination rendered/hidden based on totalPages
 * - prev/next buttons disabled correctly
 * - Clicking next → hook called with page 2
 * - Clicking prev → hook called with page N-1
 * - Changing reason filter resets page to 1 + passes reason to hook
 * - Typing vacancy ID resets page to 1 + passes jobPostingId to hook
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

// Estes testes cobrem o conteúdo da página; a guarda de célula está no .guard.test
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({
    isAuthenticated: true,
    isLoading: false,
  }),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ATTEMPT = {
  id: 'ba-0001',
  workerId: 'w-0001',
  jobPostingId: 'jp-0001',
  blockedReason: 'registration_incomplete' as const,
  missingFields: [],
  attemptCount: 1,
  firstAttemptedAt: '2026-06-01T10:00:00Z',
  lastAttemptedAt: '2026-06-01T10:00:00Z',
  acquisitionChannel: null,
  createdAt: '2026-06-01T10:00:00Z',
  updatedAt: '2026-06-01T10:00:00Z',
  workerName: 'Test Worker',
  vacancyTitle: 'CASO 1-1',
  vacancyCaseNumber: 1,
};

const AGGREGATES = { totalBlocked: 50, byReason: { registration_incomplete: 50 } };

const MULTI_PAGE_PAGINATION = {
  total: 50, limit: 20, offset: 0, page: 1, totalPages: 3,
  hasNext: true, hasPrev: false,
};

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    attempts: [ATTEMPT],
    aggregates: AGGREGATES,
    pagination: MULTI_PAGE_PAGINATION,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

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

// ── Pagination tests ──────────────────────────────────────────────────────────

describe('BlockedAttemptsPage — pagination controls', () => {
  it('renders prev/next buttons when totalPages > 1', async () => {
    mockUseBlockedAttempts.mockReturnValue(makeState());
    await renderAndWait();
    expect(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.previous/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.next/i }),
    ).toBeInTheDocument();
  });

  it('does NOT render pagination bar when totalPages <= 1', async () => {
    mockUseBlockedAttempts.mockReturnValue(
      makeState({ pagination: { ...MULTI_PAGE_PAGINATION, totalPages: 1, hasNext: false } }),
    );
    await renderAndWait();
    expect(
      screen.queryByRole('button', { name: /admin\.blockedAttempts\.pagination\.next/i }),
    ).not.toBeInTheDocument();
  });

  it('previous button is disabled when hasPrev=false', async () => {
    mockUseBlockedAttempts.mockReturnValue(
      makeState({ pagination: { ...MULTI_PAGE_PAGINATION, hasPrev: false } }),
    );
    await renderAndWait();
    expect(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.previous/i }),
    ).toBeDisabled();
  });

  it('next button is enabled when hasNext=true', async () => {
    mockUseBlockedAttempts.mockReturnValue(
      makeState({ pagination: { ...MULTI_PAGE_PAGINATION, hasNext: true } }),
    );
    await renderAndWait();
    expect(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.next/i }),
    ).not.toBeDisabled();
  });

  it('next button is disabled when hasNext=false', async () => {
    mockUseBlockedAttempts.mockReturnValue(
      makeState({
        pagination: { ...MULTI_PAGE_PAGINATION, page: 3, hasNext: false, hasPrev: true },
      }),
    );
    await renderAndWait();
    expect(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.next/i }),
    ).toBeDisabled();
  });

  it('clicking next passes page=2 to hook', async () => {
    const user = userEvent.setup();
    mockUseBlockedAttempts.mockReturnValue(makeState());
    await renderAndWait();

    await user.click(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.next/i }),
    );

    await waitFor(() => {
      const calls = mockUseBlockedAttempts.mock.calls;
      const lastFilters = calls[calls.length - 1][0] as { page?: number };
      expect(lastFilters.page).toBe(2);
    });
  });

  it('clicking prev from page 2 passes page=1 to hook', async () => {
    const user = userEvent.setup();
    mockUseBlockedAttempts.mockReturnValue(
      makeState({ pagination: { ...MULTI_PAGE_PAGINATION, page: 2, hasPrev: true, hasNext: true } }),
    );
    await renderAndWait();

    await user.click(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.previous/i }),
    );

    await waitFor(() => {
      const calls = mockUseBlockedAttempts.mock.calls;
      const lastFilters = calls[calls.length - 1][0] as { page?: number };
      expect(lastFilters.page).toBe(1);
    });
  });
});

// ── Filter tests ──────────────────────────────────────────────────────────────

describe('BlockedAttemptsPage — filters reset page to 1', () => {
  it('selecting reason filter passes reason + page=1 to hook', async () => {
    const user = userEvent.setup();
    mockUseBlockedAttempts.mockReturnValue(makeState());
    await renderAndWait();

    // Advance to page 2 first
    await user.click(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.next/i }),
    );
    await waitFor(() => {
      const calls = mockUseBlockedAttempts.mock.calls;
      expect((calls[calls.length - 1][0] as { page?: number }).page).toBe(2);
    });

    // Change filter — should reset page to 1
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, 'worker_disabled');

    await waitFor(() => {
      const calls = mockUseBlockedAttempts.mock.calls;
      const last = calls[calls.length - 1][0] as { page?: number; reason?: string };
      expect(last.page).toBe(1);
      expect(last.reason).toBe('worker_disabled');
    });
  });

  it('typing vacancy ID resets page to 1 and passes jobPostingId to hook', async () => {
    const user = userEvent.setup();
    mockUseBlockedAttempts.mockReturnValue(makeState());
    await renderAndWait();

    // Advance to page 2 first
    await user.click(
      screen.getByRole('button', { name: /admin\.blockedAttempts\.pagination\.next/i }),
    );
    await waitFor(() => {
      const calls = mockUseBlockedAttempts.mock.calls;
      expect((calls[calls.length - 1][0] as { page?: number }).page).toBe(2);
    });

    // Type vacancy ID
    const vacancyInput = screen.getByRole('textbox');
    await user.clear(vacancyInput);
    await user.type(vacancyInput, 'some-uuid');

    await waitFor(() => {
      const calls = mockUseBlockedAttempts.mock.calls;
      const last = calls[calls.length - 1][0] as { page?: number; jobPostingId?: string };
      expect(last.page).toBe(1);
      expect(last.jobPostingId).toBe('some-uuid');
    });
  });

  it('clearing vacancy ID filter removes jobPostingId from hook args', async () => {
    const user = userEvent.setup();
    mockUseBlockedAttempts.mockReturnValue(makeState());
    await renderAndWait();

    const vacancyInput = screen.getByRole('textbox');

    // Type then clear
    await user.type(vacancyInput, 'abc');
    await waitFor(() => {
      const calls = mockUseBlockedAttempts.mock.calls;
      const last = calls[calls.length - 1][0] as { jobPostingId?: string };
      expect(last.jobPostingId).toBe('abc');
    });

    await user.clear(vacancyInput);

    await waitFor(() => {
      const calls = mockUseBlockedAttempts.mock.calls;
      const last = calls[calls.length - 1][0] as { jobPostingId?: string };
      expect(last.jobPostingId).toBeUndefined();
    });
  });
});
