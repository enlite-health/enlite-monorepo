import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWorkersData } from '../useWorkersData';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

vi.mock('@infrastructure/http/AdminApiService');

const MOCK_STATS = { today: 5, yesterday: 3, sevenDaysAgo: 8 };

const MOCK_WORKER = {
  id: 'w1',
  name: 'Maria Silva',
  email: 'maria@test.com',
  casesCount: 2,
  documentsComplete: true,
  documentsStatus: 'approved',
  platform: 'talentum',
  createdAt: '2026-03-01T00:00:00Z',
};

describe('useWorkersData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Provide a default mock for getWorkerDateStats in every test to avoid
    // unhandled rejections from the new Promise.all in the hook.
    vi.spyOn(AdminApiService, 'getWorkerDateStats').mockResolvedValue(MOCK_STATS);
  });

  it('starts with isLoading=true and fetches workers on mount', async () => {
    const mockResult = { data: [MOCK_WORKER], total: 1 };
    vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue(mockResult);

    const { result } = renderHook(() => useWorkersData());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.workers).toEqual([MOCK_WORKER]);
    expect(result.current.total).toBe(1);
    expect(result.current.stats).toEqual(MOCK_STATS);
    expect(result.current.error).toBeNull();
  });

  it('sets error when list API call fails', async () => {
    const errorMessage = 'Network error';
    vi.spyOn(AdminApiService, 'listWorkers').mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => useWorkersData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe(errorMessage);
    expect(result.current.workers).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('uses STATS_FALLBACK when stats API call fails', async () => {
    vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue({ data: [], total: 0 });
    vi.spyOn(AdminApiService, 'getWorkerDateStats').mockRejectedValue(new Error('Stats error'));

    const { result } = renderHook(() => useWorkersData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // The hook catches stats errors with .catch(() => STATS_FALLBACK)
    expect(result.current.stats).toEqual({ today: 0, yesterday: 0, sevenDaysAgo: 0 });
    expect(result.current.error).toBeNull();
  });

  it('returns empty array when API returns empty data', async () => {
    vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue({ data: [], total: 0 });

    const { result } = renderHook(() => useWorkersData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.workers).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('passes platform filter to listWorkers', async () => {
    const listSpy = vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue({ data: [], total: 0 });

    renderHook(() => useWorkersData({ platform: 'talentum' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ platform: 'talentum' });
    });
  });

  it('passes docs_complete filter to listWorkers', async () => {
    const listSpy = vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue({ data: [], total: 0 });

    renderHook(() => useWorkersData({ docs_complete: 'complete' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ docs_complete: 'complete' });
    });
  });

  it('refetches when platform filter changes', async () => {
    const listSpy = vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue({ data: [], total: 0 });

    const { rerender } = renderHook(
      ({ filters }) => useWorkersData(filters),
      { initialProps: { filters: { platform: 'talentum' } } },
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ platform: 'talentum' }));

    rerender({ filters: { platform: 'ana_care' } });

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ platform: 'ana_care' }));
  });

  it('refetches when docs_complete filter changes', async () => {
    const listSpy = vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue({ data: [], total: 0 });

    const { rerender } = renderHook(
      ({ filters }) => useWorkersData(filters),
      { initialProps: { filters: { docs_complete: 'complete' } } },
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ docs_complete: 'complete' }));

    rerender({ filters: { docs_complete: 'incomplete' } });

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ docs_complete: 'incomplete' }));
  });

  // ── Checkbox "Mostrar desactivados" (D-2026-09-28) ─────────────────────────

  it('passes include_deactivated filter to listWorkers', async () => {
    const listSpy = vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue({ data: [], total: 0 });

    renderHook(() => useWorkersData({ include_deactivated: 'true' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ include_deactivated: 'true' });
    });
  });

  it('refetches when include_deactivated filter changes (checkbox marcado/desmarcado)', async () => {
    const listSpy = vi.spyOn(AdminApiService, 'listWorkers').mockResolvedValue({ data: [], total: 0 });

    const { rerender } = renderHook(
      ({ filters }) => useWorkersData(filters),
      { initialProps: { filters: {} as { include_deactivated?: string } } },
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({}));

    rerender({ filters: { include_deactivated: 'true' } });

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ include_deactivated: 'true' }));
  });
});
