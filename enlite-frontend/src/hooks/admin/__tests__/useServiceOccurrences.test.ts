/**
 * useServiceOccurrences — spec 069, "Próximos días": 1 GET por (serviço, semana, prestador), janela
 * de 7 dias, guarda por `requestIdRef`, 403 → `forbidden`, erro sem código → `error`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import { useServiceOccurrences } from '../useServiceOccurrences';

vi.mock('@infrastructure/http/AdminContractedServicesApiService', async () => {
  const actual = await vi.importActual<typeof import('@infrastructure/http/AdminContractedServicesApiService')>(
    '@infrastructure/http/AdminContractedServicesApiService',
  );
  return { ...actual, AdminContractedServicesApiService: { getItineraryEvents: vi.fn() } };
});

const getItineraryEvents = AdminContractedServicesApiService.getItineraryEvents as ReturnType<typeof vi.fn>;
const ok = (events: unknown[]) => ({ patientId: 'p-1', from: '', to: '', events });

beforeEach(() => {
  getItineraryEvents.mockReset();
});

describe('useServiceOccurrences', () => {
  it('feliz: 1 GET com a janela [segunda, domingo] (7 dias) e o serviço; events chega só depois de carregar', async () => {
    getItineraryEvents.mockResolvedValue(ok([{ date: '2026-11-02' }]));
    const { result } = renderHook(() => useServiceOccurrences('p-1', 's-1', '2026-11-02'));

    expect(result.current.status).toBe('loading');
    expect(result.current.events).toBeNull();
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.events).toEqual([{ date: '2026-11-02' }]);
    expect(getItineraryEvents).toHaveBeenCalledTimes(1);
    expect(getItineraryEvents).toHaveBeenCalledWith('p-1', '2026-11-02', '2026-11-08', { serviceId: 's-1' });
  });

  it('trocar a semana refaz o GET e zera os eventos da semana anterior enquanto carrega', async () => {
    getItineraryEvents.mockResolvedValueOnce(ok([{ date: '2026-11-02' }]));
    const { result, rerender } = renderHook(({ week }) => useServiceOccurrences('p-1', 's-1', week), { initialProps: { week: '2026-11-02' } });
    await waitFor(() => expect(result.current.status).toBe('ok'));

    getItineraryEvents.mockResolvedValueOnce(ok([{ date: '2026-11-09' }]));
    rerender({ week: '2026-11-09' });
    expect(result.current.events).toBeNull();
    await waitFor(() => expect(result.current.events).toEqual([{ date: '2026-11-09' }]));
    expect(getItineraryEvents).toHaveBeenLastCalledWith('p-1', '2026-11-09', '2026-11-15', { serviceId: 's-1' });
  });

  it('403 → forbidden; erro sem status 403 → error', async () => {
    getItineraryEvents.mockRejectedValueOnce(new ContractedServiceApiError('forbidden', 403));
    const a = renderHook(() => useServiceOccurrences('p-1', 's-1', '2026-11-02'));
    await waitFor(() => expect(a.result.current.status).toBe('forbidden'));

    getItineraryEvents.mockRejectedValueOnce(new Error('boom'));
    const b = renderHook(() => useServiceOccurrences('p-1', 's-1', '2026-11-02'));
    await waitFor(() => expect(b.result.current.status).toBe('error'));
  });

  it('guarda por requestId: resposta atrasada da semana anterior não sobrescreve a atual (sucesso e erro)', async () => {
    let resolveFirst: (v: unknown) => void = () => undefined;
    let rejectSecondOld: (e: unknown) => void = () => undefined;
    getItineraryEvents.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    getItineraryEvents.mockResolvedValueOnce(ok([{ date: 'atual' }]));
    const { result, rerender } = renderHook(({ week }) => useServiceOccurrences('p-1', 's-1', week), { initialProps: { week: '2026-11-02' } });
    rerender({ week: '2026-11-09' });
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => resolveFirst(ok([{ date: 'velho' }])));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.events).toEqual([{ date: 'atual' }]);

    // mesma guarda no caminho de erro
    getItineraryEvents.mockImplementationOnce(() => new Promise((_, rej) => { rejectSecondOld = rej; }));
    getItineraryEvents.mockResolvedValueOnce(ok([{ date: 'atual2' }]));
    rerender({ week: '2026-11-16' });
    rerender({ week: '2026-11-23' });
    await waitFor(() => expect(result.current.events).toEqual([{ date: 'atual2' }]));
    act(() => rejectSecondOld(new Error('late')));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.status).toBe('ok');
  });

  it('mudar `refreshKey` (escrita fora do hook) refaz o GET da mesma semana', async () => {
    getItineraryEvents.mockResolvedValue(ok([]));
    const { result, rerender } = renderHook(({ k }) => useServiceOccurrences('p-1', 's-1', '2026-11-02', k), { initialProps: { k: 0 } });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    rerender({ k: 1 });
    await waitFor(() => expect(getItineraryEvents).toHaveBeenCalledTimes(2));
  });

  it('refresh() refaz o GET da mesma semana', async () => {
    getItineraryEvents.mockResolvedValue(ok([]));
    const { result } = renderHook(() => useServiceOccurrences('p-1', 's-1', '2026-11-02'));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    act(() => result.current.refresh());
    await waitFor(() => expect(getItineraryEvents).toHaveBeenCalledTimes(2));
  });
});
