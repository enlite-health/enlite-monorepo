import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { usePatientsMapPoints, useWorkersMapPoints } from '../useMapPoints';
import { AdminMapApiService } from '@infrastructure/http/AdminMapApiService';

vi.mock('@infrastructure/http/AdminMapApiService', () => ({
  AdminMapApiService: { getWorkersMap: vi.fn(), getPatientsMap: vi.fn() },
}));

const CABA = { lat: -34.6037, lng: -58.3816 };
const OK = { data: [{ id: 'w1' }], total: 1, withoutCoordinates: 0, truncated: false };

describe('useMapPoints', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('workers: começa carregando, entrega pontos e contagens', async () => {
    vi.mocked(AdminMapApiService.getWorkersMap).mockResolvedValue(OK as never);
    const { result } = renderHook(() => useWorkersMapPoints({ country: 'AR', center: CABA, radius_km: 5 }));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.points).toEqual([{ id: 'w1' }]);
    expect(result.current.total).toBe(1);
    expect(result.current.error).toBeNull();
    expect(AdminMapApiService.getWorkersMap).toHaveBeenCalledWith({ country: 'AR', center: CABA, radius_km: 5 });
    expect(AdminMapApiService.getPatientsMap).not.toHaveBeenCalled();
  });

  it('patients: usa o endpoint de pacientes; erro vira mensagem e zera a lista', async () => {
    vi.mocked(AdminMapApiService.getPatientsMap).mockRejectedValue(new Error('Invalid map filters'));
    const { result } = renderHook(() => usePatientsMapPoints({ country: 'AR', city: 'x' }));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBe('Invalid map filters');
    expect(result.current.points).toEqual([]);
  });

  it('erro não-Error vira mensagem genérica', async () => {
    vi.mocked(AdminMapApiService.getPatientsMap).mockRejectedValue('x');
    const { result } = renderHook(() => usePatientsMapPoints({ country: 'AR', city: 'x' }));
    await waitFor(() => expect(result.current.error).toBe('Failed to load map'));
  });

  it('refaz a chamada só quando o filtro muda POR VALOR (mesma forma = 1 chamada) e no refetch', async () => {
    vi.mocked(AdminMapApiService.getWorkersMap).mockResolvedValue(OK as never);
    const { result, rerender } = renderHook(({ km }) => useWorkersMapPoints({ country: 'AR', center: { ...CABA }, radius_km: km }), { initialProps: { km: 5 } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ km: 5 });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(AdminMapApiService.getWorkersMap).toHaveBeenCalledTimes(1);
    rerender({ km: 10 });
    await waitFor(() => expect(AdminMapApiService.getWorkersMap).toHaveBeenCalledTimes(2));
    act(() => result.current.refetch());
    await waitFor(() => expect(AdminMapApiService.getWorkersMap).toHaveBeenCalledTimes(3));
  });

  it('enabled=false NÃO chama a API (aba inativa): fica vazio e sem "carregando"; ligar depois busca uma vez', async () => {
    vi.mocked(AdminMapApiService.getPatientsMap).mockResolvedValue(OK as never);
    const { result, rerender } = renderHook(({ on }) => usePatientsMapPoints({ country: 'AR', center: CABA, radius_km: 25 }, on), { initialProps: { on: false } });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.points).toEqual([]);
    expect(result.current.error).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(AdminMapApiService.getPatientsMap).not.toHaveBeenCalled();
    // refetch com enabled=false também não chama
    act(() => result.current.refetch());
    await new Promise((r) => setTimeout(r, 0));
    expect(AdminMapApiService.getPatientsMap).not.toHaveBeenCalled();
    rerender({ on: true });
    await waitFor(() => expect(result.current.points).toEqual([{ id: 'w1' }]));
    expect(AdminMapApiService.getPatientsMap).toHaveBeenCalledTimes(1);
    // desligar não refaz a chamada nem apaga o que já veio
    rerender({ on: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(AdminMapApiService.getPatientsMap).toHaveBeenCalledTimes(1);
    expect(result.current.points).toEqual([{ id: 'w1' }]);
  });

  it('resposta atrasada de um filtro antigo não sobrescreve o atual (cancelamento)', async () => {
    let resolveFirst: (v: never) => void = () => {};
    vi.mocked(AdminMapApiService.getWorkersMap)
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r as (v: never) => void; }))
      .mockResolvedValueOnce({ ...OK, data: [{ id: 'w2' }] } as never);
    const { result, rerender } = renderHook(({ km }) => useWorkersMapPoints({ country: 'AR', center: CABA, radius_km: km }), { initialProps: { km: 5 } });
    rerender({ km: 10 });
    await waitFor(() => expect(result.current.points).toEqual([{ id: 'w2' }]));
    act(() => resolveFirst({ ...OK, data: [{ id: 'stale' }] } as never));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.points).toEqual([{ id: 'w2' }]);
  });

  it('rejeição atrasada de um filtro antigo também é ignorada', async () => {
    let rejectFirst: (e: unknown) => void = () => {};
    vi.mocked(AdminMapApiService.getWorkersMap)
      .mockImplementationOnce(() => new Promise((_r, rej) => { rejectFirst = rej; }))
      .mockResolvedValueOnce(OK as never);
    const { result, rerender } = renderHook(({ km }) => useWorkersMapPoints({ country: 'AR', center: CABA, radius_km: km }), { initialProps: { km: 5 } });
    rerender({ km: 10 });
    await waitFor(() => expect(result.current.points).toEqual([{ id: 'w1' }]));
    act(() => rejectFirst(new Error('late')));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.error).toBeNull();
  });
});
