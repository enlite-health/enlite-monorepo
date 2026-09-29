/**
 * useItineraryEvents — D445.3. Molde `usePatientItinerary.test.ts`: 1 GET por montagem/troca de
 * filtro, guarda por `requestIdRef` (só a resposta da requisição mais recente pinta), 403 →
 * `forbidden`, erro sem código → `error`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import { useItineraryEvents } from '../useItineraryEvents';

vi.mock('@infrastructure/http/AdminContractedServicesApiService', async () => {
  const actual = await vi.importActual<typeof import('@infrastructure/http/AdminContractedServicesApiService')>(
    '@infrastructure/http/AdminContractedServicesApiService',
  );
  return { ...actual, AdminContractedServicesApiService: { getItineraryEvents: vi.fn() } };
});

const getItineraryEvents = AdminContractedServicesApiService.getItineraryEvents as ReturnType<typeof vi.fn>;

beforeEach(() => {
  getItineraryEvents.mockReset();
});

describe('useItineraryEvents', () => {
  it('feliz: 1 GET na montagem com from/to/serviceId/workerId; status ok e events preenchidos', async () => {
    getItineraryEvents.mockResolvedValue({ patientId: 'p-1', from: '2026-09-27', to: '2026-10-04', events: [{ date: '2026-09-27' }] });
    const { result } = renderHook(() => useItineraryEvents('p-1', { from: '2026-09-27', to: '2026-10-04', serviceId: 's-1' }));

    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.events).toEqual([{ date: '2026-09-27' }]);
    expect(getItineraryEvents).toHaveBeenCalledWith('p-1', '2026-09-27', '2026-10-04', { serviceId: 's-1', workerId: undefined });
  });

  it('trocar filtros refaz o GET com os novos valores', async () => {
    getItineraryEvents.mockResolvedValue({ patientId: 'p-1', from: '2026-09-27', to: '2026-10-04', events: [] });
    const { result } = renderHook(() => useItineraryEvents('p-1', { from: '2026-09-27', to: '2026-10-04' }));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.setFilters({ from: '2026-10-01', to: '2026-10-08' }));
    await waitFor(() => expect(getItineraryEvents).toHaveBeenCalledTimes(2));
    expect(getItineraryEvents).toHaveBeenLastCalledWith('p-1', '2026-10-01', '2026-10-08', { serviceId: undefined, workerId: undefined });
  });

  it('403 → status forbidden', async () => {
    getItineraryEvents.mockRejectedValue(new ContractedServiceApiError('forbidden', 403));
    const { result } = renderHook(() => useItineraryEvents('p-1', { from: '2026-09-27', to: '2026-10-04' }));
    await waitFor(() => expect(result.current.status).toBe('forbidden'));
  });

  it('erro sem status 403 → status error', async () => {
    getItineraryEvents.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useItineraryEvents('p-1', { from: '2026-09-27', to: '2026-10-04' }));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('guarda por requestId: resposta atrasada da 1ª requisição não sobrescreve a 2ª', async () => {
    let resolveFirst: (v: unknown) => void = () => undefined;
    getItineraryEvents.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    getItineraryEvents.mockResolvedValueOnce({ patientId: 'p-1', from: '2026-10-01', to: '2026-10-08', events: [{ date: 'segunda' }] });
    const { result } = renderHook(() => useItineraryEvents('p-1', { from: '2026-09-27', to: '2026-10-04' }));

    act(() => result.current.setFilters({ from: '2026-10-01', to: '2026-10-08' }));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.events).toEqual([{ date: 'segunda' }]);

    act(() => resolveFirst({ patientId: 'p-1', from: '2026-09-27', to: '2026-10-04', events: [{ date: 'velho' }] }));
    await new Promise((r) => setTimeout(r, 0));
    expect(result.current.events).toEqual([{ date: 'segunda' }]); // a resposta velha foi descartada
  });

  it('refresh() refaz o GET com os filtros atuais', async () => {
    getItineraryEvents.mockResolvedValue({ patientId: 'p-1', from: '2026-09-27', to: '2026-10-04', events: [] });
    const { result } = renderHook(() => useItineraryEvents('p-1', { from: '2026-09-27', to: '2026-10-04' }));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.refresh());
    await waitFor(() => expect(getItineraryEvents).toHaveBeenCalledTimes(2));
  });
});
