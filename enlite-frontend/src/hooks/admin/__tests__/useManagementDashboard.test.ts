/**
 * useManagementDashboard.test.ts (PR-9, `lex` #9)
 *
 * Cobre o que o PR-9 adicionou (estado `country`/`setCountry`, repassado ao
 * serviço) sem quebrar o comportamento pré-existente (funnelPeriod, polling,
 * guarda de concorrência, refetch, erro).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useManagementDashboard } from '../useManagementDashboard';
import { ManagementDashboardApiService } from '@infrastructure/http/ManagementDashboardApiService';

vi.mock('@infrastructure/http/ManagementDashboardApiService', () => ({
  ManagementDashboardApiService: { getManagementDashboard: vi.fn() },
}));

const PAYLOAD = { scope: { countries: ['AR'], requested: 'ALL' } } as never;

describe('useManagementDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockResolvedValue(PAYLOAD);
  });

  it('estado inicial: country="" (Todos), funnelPeriod=null, e chama o serviço com (null, null)', async () => {
    const { result } = renderHook(() => useManagementDashboard());
    expect(result.current.country).toBe('');
    expect(result.current.funnelPeriod).toBeNull();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(ManagementDashboardApiService.getManagementDashboard).toHaveBeenCalledWith(null, null);
    expect(result.current.data).toEqual(PAYLOAD);
  });

  it('setCountry("BR") refaz a busca com country="BR" e acende o loading de novo', async () => {
    const { result } = renderHook(() => useManagementDashboard());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockClear();

    act(() => result.current.setCountry('BR'));

    await waitFor(() =>
      expect(ManagementDashboardApiService.getManagementDashboard).toHaveBeenCalledWith(null, 'BR'),
    );
    expect(result.current.country).toBe('BR');
  });

  it('setFunnelPeriod(30) refaz a busca com funnelPeriodDays=30 — o país corrente vai junto', async () => {
    const { result } = renderHook(() => useManagementDashboard());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    act(() => result.current.setCountry('AR'));
    await waitFor(() => expect(result.current.country).toBe('AR'));
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockClear();

    act(() => result.current.setFunnelPeriod(30));

    await waitFor(() =>
      expect(ManagementDashboardApiService.getManagementDashboard).toHaveBeenCalledWith(30, 'AR'),
    );
  });

  it('falha na busca: `error` é a mensagem, `data` continua null', async () => {
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockRejectedValueOnce(
      new Error('COUNTRY_SCOPE_REQUIRED'),
    );
    const { result } = renderHook(() => useManagementDashboard());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('COUNTRY_SCOPE_REQUIRED');
    expect(result.current.data).toBeNull();
  });

  it('falha sem Error (valor não-Error lançado): mensagem genérica', async () => {
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockRejectedValueOnce('boom-cru');
    const { result } = renderHook(() => useManagementDashboard());

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Failed to fetch management dashboard');
  });

  it('refetch() chama o serviço de novo com o estado corrente', async () => {
    const { result } = renderHook(() => useManagementDashboard());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockClear();

    act(() => result.current.refetch());

    await waitFor(() => expect(ManagementDashboardApiService.getManagementDashboard).toHaveBeenCalledTimes(1));
  });

  it('polling silencioso (30s): não acende `isLoading`, mesmo que a busca demore', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(() => useManagementDashboard());
      await vi.waitFor(() => expect(result.current.isLoading).toBe(false));
      vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockClear();

      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });

      expect(ManagementDashboardApiService.getManagementDashboard).toHaveBeenCalledTimes(1);
      expect(result.current.isLoading).toBe(false); // nunca piscou
    } finally {
      vi.useRealTimers();
    }
  });

  it('voltar para a aba (visibilitychange=visible) refaz a busca silenciosamente', async () => {
    const { result } = renderHook(() => useManagementDashboard());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(ManagementDashboardApiService.getManagementDashboard).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(false); // silencioso — não pisca
  });

  it('aba OCULTA no visibilitychange: não refaz a busca', async () => {
    const { result } = renderHook(() => useManagementDashboard());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(ManagementDashboardApiService.getManagementDashboard).not.toHaveBeenCalled();
  });

  it('guarda de concorrência: duas chamadas de refetch em voo não disparam 2 requests simultâneas', async () => {
    let resolveFirst: (() => void) | undefined;
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = () => resolve(PAYLOAD); }),
    );
    const { result } = renderHook(() => useManagementDashboard());

    // A 1ª busca (do mount) já está em voo — um refetch nesse meio-tempo é ignorado.
    act(() => result.current.refetch());
    expect(ManagementDashboardApiService.getManagementDashboard).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst?.();
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });
});
