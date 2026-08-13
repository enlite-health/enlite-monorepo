import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useZoneAnalytics } from '../useZoneAnalytics';
import { ZoneAnalyticsApiService } from '@infrastructure/http/ZoneAnalyticsApiService';

vi.mock('@infrastructure/http/ZoneAnalyticsApiService');

const mockData = {
  zones: [
    { zone: 'Palermo', patients: 10, workersMale: 3, workersFemale: 5, demand: 12, availability: 8 },
    { zone: 'Não informado', patients: 2, workersMale: 0, workersFemale: 1, demand: 1, availability: 1 },
  ],
  unresolvedCount: 3,
};

describe('useZoneAnalytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('busca zone analytics ao montar, sem profession (undefined)', async () => {
    const spy = vi
      .spyOn(ZoneAnalyticsApiService, 'getZoneAnalytics')
      .mockResolvedValue(mockData);

    const { result } = renderHook(() => useZoneAnalytics());

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(mockData);
    expect(result.current.error).toBeNull();
    expect(spy).toHaveBeenCalledWith(undefined);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refaz o fetch quando profession muda (dispara com o novo valor)', async () => {
    const spy = vi
      .spyOn(ZoneAnalyticsApiService, 'getZoneAnalytics')
      .mockResolvedValue(mockData);

    const { result, rerender } = renderHook(({ profession }) => useZoneAnalytics(profession), {
      initialProps: {
        profession: undefined as 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST' | undefined,
      },
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).toHaveBeenLastCalledWith(undefined);

    rerender({ profession: 'CAREGIVER' });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy).toHaveBeenLastCalledWith('CAREGIVER');
  });

  it('em erro, expõe a mensagem e zera loading (sem quebrar)', async () => {
    vi.spyOn(ZoneAnalyticsApiService, 'getZoneAnalytics').mockRejectedValue(
      new Error('Falha ao buscar zone analytics'),
    );

    const { result } = renderHook(() => useZoneAnalytics());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Falha ao buscar zone analytics');
    expect(result.current.data).toBeNull();
  });

  it('em erro NÃO-Error (ex: string/objeto rejeitado), usa a mensagem de fallback', async () => {
    vi.spyOn(ZoneAnalyticsApiService, 'getZoneAnalytics').mockRejectedValue('network down');

    const { result } = renderHook(() => useZoneAnalytics());

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Failed to fetch zone analytics');
    expect(result.current.data).toBeNull();
  });

  it('refetch() dispara nova chamada com a mesma profession atual', async () => {
    const spy = vi
      .spyOn(ZoneAnalyticsApiService, 'getZoneAnalytics')
      .mockResolvedValue(mockData);

    const { result } = renderHook(() => useZoneAnalytics('PSYCHOLOGIST'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(spy).toHaveBeenCalledTimes(1);

    result.current.refetch();

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy).toHaveBeenLastCalledWith('PSYCHOLOGIST');
  });
});
