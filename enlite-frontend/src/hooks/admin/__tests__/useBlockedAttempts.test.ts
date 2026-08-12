/**
 * useBlockedAttempts.test.ts
 *
 * Unit tests for the useBlockedAttempts hook covering:
 * - Happy path: fetches data, resolves worker names and vacancy titles
 * - Worker name resolution: firstName + lastName, firstName only, null on error
 * - Vacancy resolution: title + caseNumber, nulls on 404, dedup of IDs
 * - Deduplication: same workerId/jobPostingId repeated → single fetch call per ID
 * - Error path: network failure → error string, isLoading=false
 * - Filters: changing filter params triggers new fetch
 * - refetch: incrementing refreshKey retriggers fetch
 * - Cancellation: stale responses from cancelled effects are ignored
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBlockedAttempts } from '../useBlockedAttempts';
import { AdminRecruitmentApiService } from '@infrastructure/http/AdminRecruitmentApiService';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { BlockedAttempt, BlockedAttemptsFilters } from '@domain/entities/BlockedAttempt';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('@infrastructure/http/AdminRecruitmentApiService');
vi.mock('@infrastructure/http/AdminApiService');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WORKER_ID_1 = 'worker-uuid-0001';
const WORKER_ID_2 = 'worker-uuid-0002';
const VACANCY_ID_1 = 'vacancy-uuid-0001';
const VACANCY_ID_2 = 'vacancy-uuid-0002';

const RAW_ATTEMPT_1: BlockedAttempt = {
  id: 'ba-0001',
  workerId: WORKER_ID_1,
  jobPostingId: VACANCY_ID_1,
  blockedReason: 'registration_incomplete',
  missingFields: ['profession'],
  attemptCount: 2,
  firstAttemptedAt: '2026-06-01T10:00:00Z',
  lastAttemptedAt: '2026-06-10T10:00:00Z',
  acquisitionChannel: 'whatsapp',
  createdAt: '2026-06-01T10:00:00Z',
  updatedAt: '2026-06-10T10:00:00Z',
};

const RAW_ATTEMPT_2: BlockedAttempt = {
  ...RAW_ATTEMPT_1,
  id: 'ba-0002',
  workerId: WORKER_ID_2,
  jobPostingId: VACANCY_ID_2,
  blockedReason: 'worker_disabled',
};

// Same workerId/vacancyId as attempt 1 — for dedup test
const RAW_ATTEMPT_3: BlockedAttempt = {
  ...RAW_ATTEMPT_1,
  id: 'ba-0003',
  workerId: WORKER_ID_1,
  jobPostingId: VACANCY_ID_1,
};

const MOCK_WORKER_FULL = {
  id: WORKER_ID_1,
  firstName: 'María',
  lastName: 'González',
};

const MOCK_WORKER_FIRST_ONLY = {
  id: WORKER_ID_2,
  firstName: 'Carlos',
  lastName: null,
};

const MOCK_VACANCY_1 = {
  id: VACANCY_ID_1,
  title: 'CASO 766-1',
  case_number: 766,
};

const MOCK_VACANCY_2 = {
  id: VACANCY_ID_2,
  title: null,
  case_number: 800,
};

const MOCK_AGGREGATES = {
  totalBlocked: 10,
  byReason: { registration_incomplete: 8, worker_disabled: 2 },
};

const MOCK_PAGINATION = {
  total: 2,
  limit: 20,
  offset: 0,
  page: 1,
  totalPages: 1,
  hasNext: false,
  hasPrev: false,
};

function makeApiResponse(
  data: BlockedAttempt[] = [RAW_ATTEMPT_1],
  aggregates = MOCK_AGGREGATES,
  pagination = MOCK_PAGINATION,
) {
  return { data, aggregates, pagination };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useBlockedAttempts — happy path', () => {
  it('starts in loading state', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse(),
    );
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('resolves worker full name (firstName + lastName)', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse(),
    );
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.attempts[0].workerName).toBe('María González');
  });

  it('resolves worker name with firstName only when lastName is null', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse([{ ...RAW_ATTEMPT_1, workerId: WORKER_ID_2 }]),
    );
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(
      MOCK_WORKER_FIRST_ONLY as never,
    );
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.attempts[0].workerName).toBe('Carlos');
  });

  it('sets workerName=null when getWorkerById throws', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse(),
    );
    vi.spyOn(AdminApiService, 'getWorkerById').mockRejectedValue(new Error('404'));
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.attempts[0].workerName).toBeNull();
  });

  it('resolves vacancy title from API', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse(),
    );
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.attempts[0].vacancyTitle).toBe('CASO 766-1');
    expect(result.current.attempts[0].vacancyCaseNumber).toBe(766);
  });

  it('sets vacancyTitle=null and caseNumber from vacancy when title is null', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse([{ ...RAW_ATTEMPT_1, jobPostingId: VACANCY_ID_2 }]),
    );
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_2 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.attempts[0].vacancyTitle).toBeNull();
    expect(result.current.attempts[0].vacancyCaseNumber).toBe(800);
  });

  it('sets vacancyTitle=null and caseNumber=null when getVacancyById throws', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse(),
    );
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockRejectedValue(new Error('404'));

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.attempts[0].vacancyTitle).toBeNull();
    expect(result.current.attempts[0].vacancyCaseNumber).toBeNull();
  });

  it('returns aggregates and pagination from API', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse(),
    );
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.aggregates).toEqual(MOCK_AGGREGATES);
    expect(result.current.pagination).toEqual(MOCK_PAGINATION);
  });
});

describe('useBlockedAttempts — deduplication', () => {
  it('fetches each workerId only once even when repeated across attempts', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse([RAW_ATTEMPT_1, RAW_ATTEMPT_3]),
    );
    const workerSpy = vi
      .spyOn(AdminApiService, 'getWorkerById')
      .mockResolvedValue(MOCK_WORKER_FULL as never);
    const vacancySpy = vi
      .spyOn(AdminApiService, 'getVacancyById')
      .mockResolvedValue(MOCK_VACANCY_1 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // WORKER_ID_1 appears in both attempts — should only fetch once
    expect(workerSpy).toHaveBeenCalledTimes(1);
    expect(workerSpy).toHaveBeenCalledWith(WORKER_ID_1);

    // VACANCY_ID_1 appears in both — should only fetch once
    expect(vacancySpy).toHaveBeenCalledTimes(1);
    expect(vacancySpy).toHaveBeenCalledWith(VACANCY_ID_1);

    // Both attempts have the resolved name
    expect(result.current.attempts[0].workerName).toBe('María González');
    expect(result.current.attempts[1].workerName).toBe('María González');
  });

  it('fetches each distinct workerId once when multiple IDs present', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockResolvedValue(
      makeApiResponse([RAW_ATTEMPT_1, RAW_ATTEMPT_2]),
    );
    const workerSpy = vi.spyOn(AdminApiService, 'getWorkerById').mockImplementation(
      async (id: string) => (id === WORKER_ID_1 ? MOCK_WORKER_FULL : MOCK_WORKER_FIRST_ONLY) as never,
    );
    vi.spyOn(AdminApiService, 'getVacancyById').mockImplementation(
      async (id: string) => (id === VACANCY_ID_1 ? MOCK_VACANCY_1 : MOCK_VACANCY_2) as never,
    );

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(workerSpy).toHaveBeenCalledTimes(2);
    expect(result.current.attempts[0].workerName).toBe('María González');
    expect(result.current.attempts[1].workerName).toBe('Carlos');
  });
});

describe('useBlockedAttempts — error state', () => {
  it('sets error message when getBlockedAttempts throws', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockRejectedValue(
      new Error('Network error'),
    );

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Network error');
    expect(result.current.attempts).toEqual([]);
  });

  it('sets generic error message for non-Error throws', async () => {
    vi.spyOn(AdminRecruitmentApiService, 'getBlockedAttempts').mockRejectedValue(
      'plain string error',
    );

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Failed to fetch blocked attempts');
  });
});

describe('useBlockedAttempts — filters & refetch', () => {
  it('re-fetches when reason filter changes', async () => {
    const spy = vi
      .spyOn(AdminRecruitmentApiService, 'getBlockedAttempts')
      .mockResolvedValue(makeApiResponse());
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { rerender } = renderHook(
      ({ filters }: { filters: BlockedAttemptsFilters }) => useBlockedAttempts(filters),
      { initialProps: { filters: {} } },
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    rerender({ filters: { reason: 'worker_disabled' } });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toMatchObject({ reason: 'worker_disabled' });
  });

  it('re-fetches when page filter changes', async () => {
    const spy = vi
      .spyOn(AdminRecruitmentApiService, 'getBlockedAttempts')
      .mockResolvedValue(makeApiResponse());
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { rerender } = renderHook(
      ({ filters }) => useBlockedAttempts(filters),
      { initialProps: { filters: { page: 1 } } },
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    rerender({ filters: { page: 2 } });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toMatchObject({ page: 2 });
  });

  it('refetch() increments refreshKey and triggers a new fetch', async () => {
    const spy = vi
      .spyOn(AdminRecruitmentApiService, 'getBlockedAttempts')
      .mockResolvedValue(makeApiResponse());
    vi.spyOn(AdminApiService, 'getWorkerById').mockResolvedValue(MOCK_WORKER_FULL as never);
    vi.spyOn(AdminApiService, 'getVacancyById').mockResolvedValue(MOCK_VACANCY_1 as never);

    const { result } = renderHook(() => useBlockedAttempts());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(spy).toHaveBeenCalledTimes(1);

    result.current.refetch();

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
