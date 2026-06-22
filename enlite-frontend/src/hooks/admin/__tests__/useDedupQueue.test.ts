/**
 * useDedupQueue.test.ts
 *
 * Covers:
 * - Happy path: starts loading, sets groups, finishes loading
 * - Empty array returned from API
 * - Error path: rejects with Error and with plain string
 * - refetch: calling refetch triggers a new fetch
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useDedupQueue } from '../useDedupQueue';
import { AdminDedupApiService } from '@infrastructure/http/AdminDedupApiService';
import type { DedupGroupSummary } from '@domain/entities/DedupGroup';

vi.mock('@infrastructure/http/AdminDedupApiService');

const MOCK_GROUP_1: DedupGroupSummary = {
  phone_normalized: '+5491112345678',
  accounts: [
    {
      id: 'acc-001',
      email: 'a@test.com',
      tier: 'REGISTERED',
      status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      wja_count: 3,
      docs_count: 2,
      encuadres_count: 1,
      login_real: true,
    },
    {
      id: 'acc-002',
      email: null,
      tier: 'INCOMPLETE_REGISTER',
      status: 'INCOMPLETE',
      created_at: '2026-02-01T00:00:00Z',
      updated_at: '2026-02-01T00:00:00Z',
      wja_count: 0,
      docs_count: 0,
      encuadres_count: 0,
      login_real: false,
    },
  ],
  survivor_suggested: 'acc-001',
};

const MOCK_GROUP_2: DedupGroupSummary = {
  phone_normalized: '+5491187654321',
  accounts: [
    {
      id: 'acc-003',
      email: 'b@test.com',
      tier: 'REGISTERED',
      status: 'ACTIVE',
      created_at: '2026-03-01T00:00:00Z',
      updated_at: '2026-03-01T00:00:00Z',
      wja_count: 1,
      docs_count: 0,
      encuadres_count: 0,
      login_real: true,
    },
  ],
  survivor_suggested: 'acc-003',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useDedupQueue — happy path', () => {
  it('starts in loading state', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroups').mockResolvedValue([MOCK_GROUP_1]);

    const { result } = renderHook(() => useDedupQueue());
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });

  it('sets groups after successful fetch', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroups').mockResolvedValue([
      MOCK_GROUP_1,
      MOCK_GROUP_2,
    ]);

    const { result } = renderHook(() => useDedupQueue());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.groups).toHaveLength(2);
    expect(result.current.groups[0].phone_normalized).toBe('+5491112345678');
    expect(result.current.error).toBeNull();
  });

  it('sets groups to empty array when API returns []', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroups').mockResolvedValue([]);

    const { result } = renderHook(() => useDedupQueue());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.groups).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

describe('useDedupQueue — error state', () => {
  it('sets error message when getGroups throws an Error', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroups').mockRejectedValue(
      new Error('Network failure'),
    );

    const { result } = renderHook(() => useDedupQueue());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Network failure');
    expect(result.current.groups).toEqual([]);
  });

  it('sets generic error message for non-Error throws', async () => {
    vi.spyOn(AdminDedupApiService, 'getGroups').mockRejectedValue('plain string');

    const { result } = renderHook(() => useDedupQueue());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Error al cargar grupos de duplicados');
  });
});

describe('useDedupQueue — refetch', () => {
  it('refetch() triggers a second API call', async () => {
    const spy = vi
      .spyOn(AdminDedupApiService, 'getGroups')
      .mockResolvedValue([MOCK_GROUP_1]);

    const { result } = renderHook(() => useDedupQueue());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(spy).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
