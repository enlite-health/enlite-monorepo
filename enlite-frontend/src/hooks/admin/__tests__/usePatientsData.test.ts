import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePatientsData } from '../usePatientsData';
import { AdminPatientsApiService } from '@infrastructure/http/AdminPatientsApiService';

vi.mock('@infrastructure/http/AdminPatientsApiService');

const MOCK_STATS = {
  total: 303,
  complete: 133,
  needsAttention: 170,
  createdToday: 0,
  createdYesterday: 0,
  createdLast7Days: 0,
};

const MOCK_PATIENT = {
  id: 'p1',
  firstName: 'Francisco',
  lastName: 'Alomon',
  documentType: 'DNI',
  documentNumber: '50076035',
  dependencyLevel: 'SEVERE',
  clinicalSpecialty: null,
  serviceType: ['AT'],
  needsAttention: false,
  attentionReasons: [],
};

describe('usePatientsData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(AdminPatientsApiService, 'getPatientStats').mockResolvedValue(MOCK_STATS);
  });

  it('starts with isLoading=true and fetches patients on mount', async () => {
    const mockResult = { data: [MOCK_PATIENT], total: 1 };
    vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue(mockResult);

    const { result } = renderHook(() => usePatientsData());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.patients).toEqual([MOCK_PATIENT]);
    expect(result.current.total).toBe(1);
    expect(result.current.stats).toEqual(MOCK_STATS);
    expect(result.current.error).toBeNull();
  });

  it('repassa exclude_discharged para a lista E para os cards (mesmo contador); sem ele, o stats vai sem parâmetro', async () => {
    const list = vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });
    const stats = vi.spyOn(AdminPatientsApiService, 'getPatientStats');

    const { result, rerender } = renderHook(({ f }) => usePatientsData(f), {
      initialProps: { f: { exclude_discharged: 'true' } as { exclude_discharged?: string } },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(list).toHaveBeenLastCalledWith({ exclude_discharged: 'true' });
    expect(stats).toHaveBeenLastCalledWith({ exclude_discharged: 'true' });

    rerender({ f: {} });
    await waitFor(() => expect(stats).toHaveBeenCalledTimes(2));
    expect(stats).toHaveBeenLastCalledWith({ exclude_discharged: undefined });
  });

  it('sets error when list API call fails', async () => {
    const errorMessage = 'Network error';
    vi.spyOn(AdminPatientsApiService, 'listPatients').mockRejectedValue(new Error(errorMessage));

    const { result } = renderHook(() => usePatientsData());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBe(errorMessage);
    expect(result.current.patients).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('uses STATS_FALLBACK when stats API call fails', async () => {
    vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });
    vi.spyOn(AdminPatientsApiService, 'getPatientStats').mockRejectedValue(new Error('Stats error'));

    const { result } = renderHook(() => usePatientsData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.stats).toEqual({
      total: 0,
      complete: 0,
      needsAttention: 0,
      createdToday: 0,
      createdYesterday: 0,
      createdLast7Days: 0,
    });
    expect(result.current.error).toBeNull();
  });

  it('returns empty array when API returns empty data', async () => {
    vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });

    const { result } = renderHook(() => usePatientsData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.patients).toEqual([]);
    expect(result.current.total).toBe(0);
  });

  it('passes search filter to listPatients', async () => {
    const listSpy = vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });

    renderHook(() => usePatientsData({ search: 'Francisco' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ search: 'Francisco' });
    });
  });

  it('passes needs_attention filter to listPatients', async () => {
    const listSpy = vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });

    renderHook(() => usePatientsData({ needs_attention: 'true' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ needs_attention: 'true' });
    });
  });

  it('passes clinical_specialty filter to listPatients', async () => {
    const listSpy = vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });

    renderHook(() => usePatientsData({ clinical_specialty: 'ASD' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ clinical_specialty: 'ASD' });
    });
  });

  it('passes dependency_level filter to listPatients', async () => {
    const listSpy = vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });

    renderHook(() => usePatientsData({ dependency_level: 'SEVERE' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ dependency_level: 'SEVERE' });
    });
  });

  it('passes limit and offset filters to listPatients', async () => {
    const listSpy = vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });

    renderHook(() => usePatientsData({ limit: '10', offset: '20' }));

    await waitFor(() => {
      expect(listSpy).toHaveBeenCalledWith({ limit: '10', offset: '20' });
    });
  });

  it('refetches when dependency_level filter changes', async () => {
    const listSpy = vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });

    const { rerender } = renderHook(
      ({ filters }) => usePatientsData(filters),
      { initialProps: { filters: { dependency_level: 'SEVERE' } } },
    );

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ dependency_level: 'SEVERE' }));

    rerender({ filters: { dependency_level: 'MILD' } });

    await waitFor(() => expect(listSpy).toHaveBeenCalledWith({ dependency_level: 'MILD' }));
  });

  it('exposes refetch function that triggers a new fetch', async () => {
    const listSpy = vi.spyOn(AdminPatientsApiService, 'listPatients').mockResolvedValue({ data: [], total: 0 });

    const { result } = renderHook(() => usePatientsData());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listSpy).toHaveBeenCalledTimes(1);

    result.current.refetch();

    await waitFor(() => expect(listSpy).toHaveBeenCalledTimes(2));
  });
});
