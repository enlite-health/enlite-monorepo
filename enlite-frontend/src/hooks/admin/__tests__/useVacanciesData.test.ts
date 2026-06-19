import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useVacanciesData } from '../useVacanciesData';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

vi.mock('@infrastructure/http/AdminApiService');

describe('useVacanciesData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should fetch vacancies and stats on mount', async () => {
    const mockVacancies = { data: [{ id: 1 }], total: 1 };
    const mockStats = [{ label: '+7 dias', value: '5' }];

    vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue(mockStats);

    const { result } = renderHook(() => useVacanciesData());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.vacancies).toEqual(mockVacancies.data);
    expect(result.current.stats).toEqual(mockStats);
    expect(result.current.total).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it('should handle errors', async () => {
    const errorMessage = 'Network error';
    vi.spyOn(AdminApiService, 'listVacancies').mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => useVacanciesData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe(errorMessage);
  });

  it('should refetch when filters change', async () => {
    const mockVacancies = { data: [], total: 0 };
    const mockStats: unknown[] = [];
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue(mockStats);

    const { rerender } = renderHook(
      ({ filters }) => useVacanciesData(filters),
      { initialProps: { filters: { search: 'test1' } } }
    );

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ search: 'test1' });
    });

    rerender({ filters: { search: 'test2' } });

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ search: 'test2' });
    });
  });

  it('deve passar priority para listVacancies', async () => {
    const mockVacancies = { data: [{ id: '1', status: 'Ativo', priority: 'Urgente' }], total: 1 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    renderHook(() => useVacanciesData({ status: 'ativo', priority: 'urgent' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ status: 'ativo', priority: 'urgent' });
    });
  });

  it('deve refazer fetch ao mudar priority', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    const { rerender } = renderHook(
      ({ filters }) => useVacanciesData(filters),
      { initialProps: { filters: { priority: 'urgent' } } },
    );

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ priority: 'urgent' });
    });

    rerender({ filters: { priority: 'high' } });

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ priority: 'high' });
    });
  });

  it('deve refazer fetch ao mudar status para pausado', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    const { rerender } = renderHook(
      ({ filters }) => useVacanciesData(filters),
      { initialProps: { filters: { status: 'ativo' } } },
    );

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ status: 'ativo' });
    });

    rerender({ filters: { status: 'pausado' } });

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ status: 'pausado' });
    });
  });

  // ── New advanced filter fields ─────────────────────────────────────────────

  it('passes worker_type to listVacancies', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    renderHook(() => useVacanciesData({ worker_type: 'AT' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ worker_type: 'AT' });
    });
  });

  it('passes state and city to listVacancies', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    renderHook(() => useVacanciesData({ state: 'Buenos Aires', city: 'Palermo' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ state: 'Buenos Aires', city: 'Palermo' });
    });
  });

  it('passes required_sex to listVacancies', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    renderHook(() => useVacanciesData({ required_sex: 'F' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ required_sex: 'F' });
    });
  });

  it('passes days CSV to listVacancies', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    renderHook(() => useVacanciesData({ days: '1,3,5' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ days: '1,3,5' });
    });
  });

  it('passes time_from and time_to to listVacancies', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    renderHook(() => useVacanciesData({ time_from: '09:00', time_to: '17:00' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ time_from: '09:00', time_to: '17:00' });
    });
  });

  it('refetches when days filter changes', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    const { rerender } = renderHook(
      ({ filters }) => useVacanciesData(filters),
      { initialProps: { filters: { days: '1' } } },
    );

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ days: '1' });
    });

    rerender({ filters: { days: '1,3,5' } });

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ days: '1,3,5' });
    });
  });

  it('refetches when time_from changes', async () => {
    const mockVacancies = { data: [], total: 0 };
    const listSpy = vi.spyOn(AdminApiService, 'listVacancies').mockResolvedValue(mockVacancies);
    vi.spyOn(AdminApiService, 'getVacanciesStats').mockResolvedValue([]);

    const { rerender } = renderHook(
      ({ filters }) => useVacanciesData(filters),
      { initialProps: { filters: { time_from: '08:00', time_to: '16:00' } } },
    );

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ time_from: '08:00', time_to: '16:00' });
    });

    rerender({ filters: { time_from: '09:00', time_to: '17:00' } });

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ time_from: '09:00', time_to: '17:00' });
    });
  });
});
