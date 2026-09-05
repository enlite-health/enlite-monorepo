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

  it('ligar um hook DESLIGADO entra em "carregando" no mesmo render — nunca em "0 resultados"', async () => {
    vi.mocked(AdminMapApiService.getWorkersMap).mockReturnValue(new Promise(() => {}) as never);
    const { result, rerender } = renderHook(
      ({ on }) => useWorkersMapPoints({ country: 'AR', center: CABA, radius_km: 5 }, on),
      { initialProps: { on: false } },
    );
    // desligado: não busca e não afirma nada
    expect(result.current.isLoading).toBe(false);
    expect(result.current.points).toEqual([]);
    expect(AdminMapApiService.getWorkersMap).not.toHaveBeenCalled();

    // ligou (é o que o portão da âncora faz): o PRIMEIRO render já diz "carregando".
    // Se ficasse `false` aqui, a tela pintaria "0 en 5 km · Nadie en este radio"
    // antes de existir pergunta — a afirmação mais forte possível, feita no vazio.
    rerender({ on: true });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it('ao RELIGAR com a MESMA pergunta, os pontos ficam — é a volta de aba, não uma busca nova', async () => {
    vi.mocked(AdminMapApiService.getWorkersMap).mockResolvedValue(OK as never);
    const { result, rerender } = renderHook(
      ({ on }) => useWorkersMapPoints({ country: 'AR', center: CABA, radius_km: 5 }, on),
      { initialProps: { on: true } },
    );
    await waitFor(() => expect(result.current.points).toEqual([{ id: 'w1' }]));
    rerender({ on: false });
    vi.mocked(AdminMapApiService.getWorkersMap).mockReturnValue(new Promise(() => {}) as never);
    rerender({ on: true });
    // Apagar aqui esvaziava a lista de opções do seletor da âncora, e o combobox
    // — sem achar o valor escolhido — voltava ao placeholder: a âncora seguia
    // ativa e a tela dizia que não havia nenhuma.
    expect(result.current.points).toEqual([{ id: 'w1' }]);
    expect(result.current.isLoading).toBe(true);
  });

  it('ao RELIGAR com pergunta DIFERENTE, os pontos antigos somem (podiam ser de outro país)', async () => {
    vi.mocked(AdminMapApiService.getWorkersMap).mockResolvedValue(OK as never);
    const { result, rerender } = renderHook(
      ({ on, km }) => useWorkersMapPoints({ country: 'AR', center: CABA, radius_km: km }, on),
      { initialProps: { on: true, km: 5 } },
    );
    await waitFor(() => expect(result.current.points).toEqual([{ id: 'w1' }]));
    rerender({ on: false, km: 5 });
    vi.mocked(AdminMapApiService.getWorkersMap).mockReturnValue(new Promise(() => {}) as never);
    rerender({ on: true, km: 25 });
    expect(result.current.points).toEqual([]);
    expect(result.current.isLoading).toBe(true);
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
