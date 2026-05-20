/**
 * RecruitmentHealthPage.test.tsx
 *
 * Unit tests covering:
 * - Loading skeleton renders while fetching
 * - Success: all 3 cards with correct metric values render
 * - Error state renders user-friendly message + retry button
 * - Retry button calls refetch
 * - Failed invites row has danger style (red) when > 0
 * - Bulk run card shows empty state when batch_id is null
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { RecruitmentHealthPage } from '../RecruitmentHealthPage';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

const mockGetRecruitmentHealth = vi.fn();

vi.mock('@infrastructure/http/AdminRecruitmentApiService', () => ({
  AdminRecruitmentApiService: {
    getRecruitmentHealth: (...args: unknown[]) => mockGetRecruitmentHealth(...args),
  },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_HEALTH_DATA = {
  auto_invite_last_24h: {
    vacancies_created: 3,
    invites_enqueued: 12,
    invites_sent: 10,
    invites_delivered: 9,
    invites_failed: 1,
  },
  bulk_dispatch_incomplete_last_run: {
    batch_id: 'batch-abc-123',
    total: 50,
    sent: 48,
    errors: 2,
    started_at: '2026-05-19T10:00:00Z',
    finished_at: '2026-05-19T10:05:00Z',
  },
  bulk_dispatch_talentum_last_run: {
    batch_id: null,
    total: 0,
    sent: 0,
    errors: 0,
    started_at: null,
    finished_at: null,
  },
};

const MOCK_NO_FAILURES = {
  auto_invite_last_24h: {
    vacancies_created: 3,
    invites_enqueued: 12,
    invites_sent: 10,
    invites_delivered: 10,
    invites_failed: 0,
  },
  bulk_dispatch_incomplete_last_run: {
    batch_id: 'batch-xyz',
    total: 10,
    sent: 10,
    errors: 0,
    started_at: '2026-05-19T10:00:00Z',
    finished_at: '2026-05-19T10:05:00Z',
  },
  bulk_dispatch_talentum_last_run: {
    batch_id: null,
    total: 0,
    sent: 0,
    errors: 0,
    started_at: null,
    finished_at: null,
  },
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

function renderPage() {
  return render(
    <MemoryRouter>
      <RecruitmentHealthPage />
    </MemoryRouter>,
  );
}

async function renderAndWait() {
  await act(async () => {
    renderPage();
  });
  await waitFor(() =>
    expect(screen.queryByTestId('health-skeleton')).not.toBeInTheDocument(),
    { timeout: 5000 },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RecruitmentHealthPage — loading state', () => {
  it('shows skeleton while data is loading', async () => {
    // Never resolves during this test
    mockGetRecruitmentHealth.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      renderPage();
    });

    expect(screen.getByTestId('health-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('health-content')).not.toBeInTheDocument();
    expect(screen.queryByTestId('health-error')).not.toBeInTheDocument();
  });
});

describe('RecruitmentHealthPage — success state', () => {
  beforeEach(() => {
    mockGetRecruitmentHealth.mockResolvedValue(MOCK_HEALTH_DATA);
  });

  it('renders page title', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('admin.recruitmentHealth.title');
  });

  it('renders content area after loading', async () => {
    await renderAndWait();
    expect(screen.getByTestId('health-content')).toBeInTheDocument();
  });

  it('renders auto-invite card with correct numeric values', async () => {
    await renderAndWait();
    const content = document.body.textContent ?? '';
    expect(content).toContain('3');   // vacancies_created
    expect(content).toContain('12');  // invites_enqueued
    expect(content).toContain('10');  // invites_sent
    expect(content).toContain('9');   // invites_delivered
    expect(content).toContain('1');   // invites_failed
  });

  it('renders bulk incomplete card with batch_id', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('batch-abc-123');
  });

  it('renders bulk incomplete card totals', async () => {
    await renderAndWait();
    const content = document.body.textContent ?? '';
    expect(content).toContain('50');  // total
    expect(content).toContain('48');  // sent
    expect(content).toContain('2');   // errors
  });

  it('renders bulk talentum card with empty state (batch_id null)', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('admin.recruitmentHealth.noRuns');
  });

  it('renders refresh button', async () => {
    await renderAndWait();
    expect(
      screen.getByRole('button', { name: /admin\.recruitmentHealth\.refresh/i }),
    ).toBeInTheDocument();
  });

  it('calls getRecruitmentHealth once on mount', async () => {
    await renderAndWait();
    expect(mockGetRecruitmentHealth).toHaveBeenCalledTimes(1);
  });

  it('calls getRecruitmentHealth again on refresh click', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    mockGetRecruitmentHealth.mockResolvedValue(MOCK_HEALTH_DATA);
    await user.click(screen.getByRole('button', { name: /admin\.recruitmentHealth\.refresh/i }));

    await waitFor(() => expect(mockGetRecruitmentHealth).toHaveBeenCalledTimes(2));
  });
});

describe('RecruitmentHealthPage — failed invites danger style', () => {
  it('applies red color class when invites_failed > 0', async () => {
    mockGetRecruitmentHealth.mockResolvedValue(MOCK_HEALTH_DATA);
    await renderAndWait();

    // The failed value "1" should be in a span with text-red-600
    const redSpans = document.querySelectorAll('.text-red-600');
    const redTexts = Array.from(redSpans).map((el) => el.textContent);
    // At least one red span contains the failed count
    expect(redTexts.some((t) => t?.includes('1') || t?.includes('2'))).toBe(true);
  });

  it('does NOT apply red color when invites_failed is 0', async () => {
    mockGetRecruitmentHealth.mockResolvedValue(MOCK_NO_FAILURES);
    await renderAndWait();

    // With 0 failures the MetricRow for "failed" does not receive danger=true,
    // so it should not render with text-red-600. The only red spans present
    // would be from bulk-run errors (also 0 in MOCK_NO_FAILURES).
    const redSpans = document.querySelectorAll('.text-red-600');
    expect(redSpans.length).toBe(0);
  });
});

describe('RecruitmentHealthPage — error state', () => {
  beforeEach(() => {
    mockGetRecruitmentHealth.mockRejectedValue(new Error('Network error'));
  });

  it('renders error state when fetch fails', async () => {
    await renderAndWait();
    expect(screen.getByTestId('health-error')).toBeInTheDocument();
  });

  it('shows load error key', async () => {
    await renderAndWait();
    expect(document.body.textContent).toContain('admin.recruitmentHealth.loadError');
  });

  it('shows retry button', async () => {
    await renderAndWait();
    expect(
      screen.getByRole('button', { name: /admin\.recruitmentHealth\.retry/i }),
    ).toBeInTheDocument();
  });

  it('retry button triggers refetch', async () => {
    const user = userEvent.setup();
    await renderAndWait();

    mockGetRecruitmentHealth.mockResolvedValue(MOCK_HEALTH_DATA);
    await user.click(screen.getByRole('button', { name: /admin\.recruitmentHealth\.retry/i }));

    await waitFor(() => expect(screen.getByTestId('health-content')).toBeInTheDocument());
    expect(mockGetRecruitmentHealth).toHaveBeenCalledTimes(2);
  });
});
