/**
 * usePatientItinerary — aba "Itinerario" (Fase 12, DX-12.6): 1 GET por montagem; `allocate` → POST
 * + 1 GET de refetch (sucesso, 409, 422); `loadOptions` → 1 GET de opções; guarda por requisição.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const getItinerary = vi.fn();
const getAllocationOptions = vi.fn();
const allocateCall = vi.fn();

// Molde de mock do cliente: useServiceTeam.test.ts.
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    getItinerary: (...a: unknown[]) => getItinerary(...a),
    getAllocationOptions: (...a: unknown[]) => getAllocationOptions(...a),
    allocate: (...a: unknown[]) => allocateCall(...a),
  },
  ContractedServiceApiError: class ContractedServiceApiError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly overlap?: unknown;
    constructor(message: string, status: number, body?: { code?: string; overlap?: unknown }) {
      super(message);
      this.name = 'ContractedServiceApiError';
      this.status = status;
      this.code = body?.code;
      this.overlap = body?.overlap;
    }
  },
}));

import { usePatientItinerary } from '../usePatientItinerary';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';
import type { ItineraryOverlapDetail, PatientItinerary } from '@domain/entities/PatientItinerary';

const P1 = 'p1';
const P2 = 'p2';
const S1 = 's1';
const SL1 = 'sl1';
const W1 = 'w1';

function itinerary(patientId: string, cobertas = 0): PatientItinerary {
  return {
    patientId,
    asOf: '2026-10-07',
    services: [{ contractedServiceId: S1, contratadas: { weekly: 20, authorized: null }, cobertas, slots: [] }],
    alerts: [],
    assembledAt: null,
  };
}

const OVERLAP: ItineraryOverlapDetail = {
  existing: { serviceId: 's9', weekday: 1, startTime: '08:00', endTime: '12:00' },
  requested: { serviceId: S1, weekday: 1, startTime: '10:00', endTime: '14:00' },
  sameAddress: false,
  minGapMinutes: 45,
};

function apiError(status: number, body?: { code?: string; overlap?: ItineraryOverlapDetail }) {
  return new (ContractedServiceApiError as unknown as new (m: string, s: number, b?: unknown) => Error)('x', status, body);
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function mountOk(first = itinerary(P1)) {
  getItinerary.mockResolvedValueOnce(first);
  const hook = renderHook(({ pid }) => usePatientItinerary(pid), { initialProps: { pid: P1 } });
  await waitFor(() => expect(hook.result.current.status).toBe('ok'));
  return hook;
}

describe('usePatientItinerary', () => {
  beforeEach(() => {
    getItinerary.mockReset();
    getAllocationOptions.mockReset();
    allocateCall.mockReset();
  });

  it('montagem: 1 GET e status ok com o itinerário', async () => {
    const { result } = await mountOk();
    expect(getItinerary).toHaveBeenCalledTimes(1);
    expect(getItinerary).toHaveBeenCalledWith(P1);
    expect(result.current.itinerary).toEqual(itinerary(P1));
    expect(result.current.actionError).toBeNull();
    expect(result.current.refreshError).toBe(false);
  });

  it('montagem: enquanto o GET não volta, status loading', () => {
    getItinerary.mockReturnValueOnce(new Promise(() => {}));
    const { result } = renderHook(() => usePatientItinerary(P1));
    expect(result.current.status).toBe('loading');
    expect(result.current.itinerary).toBeNull();
  });

  it('montagem: 403 → forbidden', async () => {
    getItinerary.mockRejectedValueOnce(apiError(403));
    const { result } = renderHook(() => usePatientItinerary(P1));
    await waitFor(() => expect(result.current.status).toBe('forbidden'));
    expect(getItinerary).toHaveBeenCalledTimes(1);
  });

  it('montagem: 500 → error', async () => {
    getItinerary.mockRejectedValueOnce(apiError(500));
    const { result } = renderHook(() => usePatientItinerary(P1));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('re-render com o mesmo patientId não faz 2º GET', async () => {
    const { rerender } = await mountOk();
    rerender({ pid: P1 });
    expect(getItinerary).toHaveBeenCalledTimes(1);
  });

  it('loadOptions: 1 GET de opções, devolve as opções ao chamador sem mexer no estado', async () => {
    const { result } = await mountOk();
    getAllocationOptions.mockResolvedValueOnce({ serviceId: S1, vacancyId: 'v1', options: [{ workerId: W1, displayName: null, vacancyId: 'v1' }] });
    let out: unknown;
    await act(async () => { out = await result.current.loadOptions(S1); });
    expect(getAllocationOptions).toHaveBeenCalledTimes(1);
    expect(getAllocationOptions).toHaveBeenCalledWith(P1, S1);
    expect(out).toEqual({ status: 'ok', options: [{ workerId: W1, displayName: null, vacancyId: 'v1' }] });
    expect(result.current.status).toBe('ok');
    expect(getItinerary).toHaveBeenCalledTimes(1);
  });

  it('loadOptions: 403 → { status: forbidden }; 500 → { status: error }', async () => {
    const { result } = await mountOk();
    getAllocationOptions.mockRejectedValueOnce(apiError(403)).mockRejectedValueOnce(apiError(500));
    let a: unknown;
    let b: unknown;
    await act(async () => {
      a = await result.current.loadOptions(S1);
      b = await result.current.loadOptions(S1);
    });
    expect(a).toEqual({ status: 'forbidden' });
    expect(b).toEqual({ status: 'error' });
    expect(result.current.status).toBe('ok');
  });

  it('allocate sucesso: 1 POST + 1 GET e o itinerário novo no estado', async () => {
    const { result } = await mountOk();
    allocateCall.mockResolvedValueOnce({ allocationId: 'al1' });
    getItinerary.mockResolvedValueOnce(itinerary(P1, 4));
    await act(async () => { await result.current.allocate(S1, SL1, W1); });
    expect(allocateCall).toHaveBeenCalledTimes(1);
    expect(allocateCall).toHaveBeenCalledWith(P1, S1, SL1, W1);
    expect(getItinerary).toHaveBeenCalledTimes(2);
    expect(result.current.itinerary?.services[0].cobertas).toBe(4);
    expect(result.current.status).toBe('ok');
    expect(result.current.actionError).toBeNull();
  });

  it('allocate 409 ITINERARY_OVERLAP: actionError com code + overlap e 1 GET de refetch', async () => {
    const { result } = await mountOk();
    allocateCall.mockRejectedValueOnce(apiError(409, { code: 'ITINERARY_OVERLAP', overlap: OVERLAP }));
    getItinerary.mockResolvedValueOnce(itinerary(P1));
    await act(async () => { await result.current.allocate(S1, SL1, W1); });
    expect(result.current.actionError).toEqual({ code: 'ITINERARY_OVERLAP', overlap: OVERLAP });
    expect(getItinerary).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe('ok');
  });

  it('allocate 422: actionError só com o code (sem overlap) e 1 GET de refetch', async () => {
    const { result } = await mountOk();
    allocateCall.mockRejectedValueOnce(apiError(422, { code: 'NOT_SELECTED_FOR_SERVICE' }));
    getItinerary.mockResolvedValueOnce(itinerary(P1));
    await act(async () => { await result.current.allocate(S1, SL1, W1); });
    expect(result.current.actionError).toEqual({ code: 'NOT_SELECTED_FOR_SERVICE' });
    expect(getItinerary).toHaveBeenCalledTimes(2);
  });

  it('allocate 403: forbidden, sem refetch', async () => {
    const { result } = await mountOk();
    allocateCall.mockRejectedValueOnce(apiError(403));
    await act(async () => { await result.current.allocate(S1, SL1, W1); });
    expect(result.current.status).toBe('forbidden');
    expect(getItinerary).toHaveBeenCalledTimes(1);
  });

  it('allocate erro sem code (500 / rede): error, sem refetch', async () => {
    const { result } = await mountOk();
    allocateCall.mockRejectedValueOnce(new Error('network'));
    await act(async () => { await result.current.allocate(S1, SL1, W1); });
    expect(result.current.status).toBe('error');
    expect(result.current.actionError).toBeNull();
    expect(getItinerary).toHaveBeenCalledTimes(1);
  });

  it('refetch que falha depois da ação → refreshError, itinerário e status de antes', async () => {
    const { result } = await mountOk();
    allocateCall.mockResolvedValueOnce({ allocationId: 'al1' });
    getItinerary.mockRejectedValueOnce(apiError(500));
    await act(async () => { await result.current.allocate(S1, SL1, W1); });
    expect(result.current.refreshError).toBe(true);
    expect(result.current.status).toBe('ok');
    expect(result.current.itinerary).toEqual(itinerary(P1));
  });

  it('guarda: resposta atrasada do GET de um patientId anterior não pinta (sucesso e falha)', async () => {
    const old = deferred<PatientItinerary>();
    const oldFail = deferred<PatientItinerary>();
    getItinerary.mockReturnValueOnce(old.promise).mockReturnValueOnce(oldFail.promise).mockResolvedValueOnce(itinerary(P2));
    const { result, rerender } = renderHook(({ pid }) => usePatientItinerary(pid), { initialProps: { pid: P1 } });
    rerender({ pid: 'p-mid' });
    rerender({ pid: P2 });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    await act(async () => {
      old.resolve(itinerary(P1));
      oldFail.reject(apiError(500));
      await Promise.resolve();
    });
    expect(result.current.itinerary?.patientId).toBe(P2);
    expect(result.current.status).toBe('ok');
  });

  it('guarda: POST velho que falha depois de uma ação mais nova não pinta', async () => {
    const { result } = await mountOk();
    const oldPost = deferred<unknown>();
    allocateCall.mockReturnValueOnce(oldPost.promise).mockResolvedValueOnce({ allocationId: 'al2' });
    getItinerary.mockResolvedValueOnce(itinerary(P1, 8));
    let first!: Promise<void>;
    act(() => { first = result.current.allocate(S1, SL1, W1); });
    await act(async () => { await result.current.allocate(S1, SL1, 'w2'); });
    await act(async () => {
      oldPost.reject(apiError(409, { code: 'ITINERARY_OVERLAP', overlap: OVERLAP }));
      await first;
    });
    expect(result.current.actionError).toBeNull();
    expect(result.current.itinerary?.services[0].cobertas).toBe(8);
    expect(getItinerary).toHaveBeenCalledTimes(2);
  });

  it('guarda: refetch velho (sucesso ou falha) que chega depois de uma ação mais nova não pinta', async () => {
    const { result } = await mountOk();
    const oldRefetchOk = deferred<PatientItinerary>();
    const oldRefetchFail = deferred<PatientItinerary>();
    allocateCall.mockResolvedValue({ allocationId: 'al1' });
    getItinerary
      .mockReturnValueOnce(oldRefetchOk.promise)
      .mockReturnValueOnce(oldRefetchFail.promise)
      .mockResolvedValueOnce(itinerary(P1, 12));
    let a!: Promise<void>;
    let b!: Promise<void>;
    act(() => { a = result.current.allocate(S1, SL1, W1); });
    await waitFor(() => expect(getItinerary).toHaveBeenCalledTimes(2));
    act(() => { b = result.current.allocate(S1, SL1, 'w2'); });
    await waitFor(() => expect(getItinerary).toHaveBeenCalledTimes(3));
    await act(async () => { await result.current.allocate(S1, SL1, 'w3'); });
    await act(async () => {
      oldRefetchOk.resolve(itinerary(P1, 99));
      oldRefetchFail.reject(apiError(500));
      await Promise.all([a, b]);
    });
    expect(result.current.itinerary?.services[0].cobertas).toBe(12);
    expect(result.current.refreshError).toBe(false);
  });
});
